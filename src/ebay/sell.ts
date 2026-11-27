import { cfg } from "../config.js";
import { getAppToken, getUserToken } from "./auth.js";
import { uploadEbayImages } from "./media.js";
import { conformAspects, getAspectSpecs } from "./taxonomy.js";
import type { ListingDraft } from "../types.js";

// eBay condition IDs -> Inventory API ConditionEnum. Source: eBay "Item condition
// ID and name values" (sell/static/metadata/condition-id-values.html).
const CONDITION_ENUM: Record<number, string> = {
  1000: "NEW",                  // New, New with tags, New with box
  1500: "NEW_OTHER",            // New without tags / box
  2750: "LIKE_NEW",
  2990: "PRE_OWNED_EXCELLENT",  // apparel only
  3000: "USED_EXCELLENT",       // Used; "Pre-owned - Good" in apparel
  3010: "PRE_OWNED_FAIR",       // apparel only
  4000: "USED_VERY_GOOD",
  5000: "USED_GOOD",
  6000: "USED_ACCEPTABLE",
};

// Closest eBay condition first. Categories allow different sets (apparel uses
// 2990/3000/3010, most others 2750-6000), so the first one the category allows wins.
const CONDITION_PREFERENCE: Record<ListingDraft["condition"], number[]> = {
  NWT: [1000],
  "like-new": [2990, 2750, 3000],
  good: [3000, 4000],
  fair: [3010, 5000, 6000],
};

// Used when the category's allowed conditions can't be fetched.
const GENERAL_CONDITION: Record<ListingDraft["condition"], number> = { NWT: 1000, "like-new": 2750, good: 3000, fair: 5000 };

const allowedConditionCache = new Map<string, Set<number> | null>();

async function allowedConditionIds(categoryId: string): Promise<Set<number> | null> {
  if (allowedConditionCache.has(categoryId)) return allowedConditionCache.get(categoryId) ?? null;
  let allowed: Set<number> | null = null;
  try {
    const res = await fetch(
      `${cfg.apiBase}/sell/metadata/v1/marketplace/EBAY_US/get_item_condition_policies?filter=${encodeURIComponent(`categoryIds:{${categoryId}}`)}`,
      { headers: { Authorization: `Bearer ${await getAppToken()}`, "Accept-Language": "en-US" } }
    );
    if (res.ok) {
      const body = (await res.json()) as { itemConditionPolicies?: Array<{ itemConditions?: Array<{ conditionId?: string }> }> };
      const ids = (body.itemConditionPolicies?.[0]?.itemConditions ?? []).map((c) => Number(c.conditionId)).filter(Number.isFinite);
      if (ids.length) allowed = new Set(ids);
    }
  } catch {
    allowed = null;
  }
  if (allowed) allowedConditionCache.set(categoryId, allowed);
  return allowed;
}

async function ebayConditionEnum(condition: ListingDraft["condition"], categoryId: string): Promise<string> {
  const allowed = await allowedConditionIds(categoryId);
  const id = allowed ? CONDITION_PREFERENCE[condition].find((c) => allowed.has(c)) : undefined;
  return CONDITION_ENUM[id ?? GENERAL_CONDITION[condition]];
}

async function ebayFetch(path: string, init: RequestInit) {
  const token = await getUserToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${cfg.apiBase}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Language": "en-US",
        // Node's fetch defaults to "Accept-Language: *", which eBay rejects (errorId 25709).
        "Accept-Language": "en-US",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`${path} -> ${res.status} ${text}`), { status: res.status });
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
  }
}

export interface PostOptions {
  sku: string;
  imageUrls: string[];        // public HTTPS URLs; empty means upload photoPaths
  photoPaths?: string[];      // local photos, uploaded to eBay when imageUrls is empty
  quantity?: number;
  categoryId: string;         // eBay leaf category id
  packageWeightLb?: number;   // packed weight; calculated shipping needs it
  merchantLocationKey: string;
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
}

interface ExistingOffer {
  offerId: string;
  listingId?: string;
  status?: string;
}

async function existingOffers(sku: string): Promise<ExistingOffer[]> {
  let result: unknown;
  try {
    result = await ebayFetch(`/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`, { method: "GET" });
  } catch (error) {
    // eBay answers 404 (errorId 25713) for a SKU with no offers yet.
    if ((error as { status?: number }).status === 404) return [];
    throw error;
  }
  const offers = (result as { offers?: unknown })?.offers;
  if (!Array.isArray(offers)) return [];
  return offers.flatMap((raw): ExistingOffer[] => {
    if (!raw || typeof raw !== "object") return [];
    const offer = raw as Record<string, unknown>;
    if (typeof offer.offerId !== "string" || !offer.offerId) return [];
    return [{
      offerId: offer.offerId,
      listingId: typeof offer.listingId === "string" ? offer.listingId : undefined,
      status: typeof offer.status === "string" ? offer.status : undefined,
    }];
  });
}

/**
 * O4, E12: whether an offer's eBay listing is still for sale, from the Inventory API offer lookup.
 * A sale (any sold quantity: resale items are one of a kind) is `sold`; a withdrawn, deleted or
 * ended listing is `ended`. Any other eBay failure throws, so the caller shows "couldn't confirm".
 */
export async function offerStock(offerId: string): Promise<"active" | "sold" | "ended"> {
  let offer: any;
  try {
    offer = await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { method: "GET" });
  } catch (error) {
    if ((error as { status?: number }).status === 404) return "ended";
    throw error;
  }
  const listing = offer?.listing ?? {};
  if (Number(listing.soldQuantity ?? 0) > 0) return "sold";
  if (offer?.status !== "PUBLISHED") return "ended";
  if (listing.listingStatus && listing.listingStatus !== "ACTIVE") return "ended";
  return "active";
}

// Three-step publish: inventory item -> offer -> publish.
// Assumes you have already created business policies and a merchant location
// (one-time setup via the Account API or Seller Hub). See README.
export async function publishListing(
  draft: ListingDraft,
  opts: PostOptions
): Promise<{ offerId: string; listingId: string }> {
  // Stable SKUs make retries detectable. A published offer for this SKU is the
  // listing already; one unpublished offer is a run that died before publish
  // and is resumed. Anything else is ambiguous and left for a human.
  const priorOffers = await existingOffers(opts.sku);
  const priorPublished = priorOffers.find((offer) => offer.status === "PUBLISHED" && offer.listingId);
  if (priorPublished?.listingId) return { offerId: priorPublished.offerId, listingId: priorPublished.listingId };
  const unpublished = priorOffers.filter((offer) => offer.status === "UNPUBLISHED");
  if (priorOffers.length && (unpublished.length !== 1 || priorOffers.length !== 1)) {
    throw new Error(
      `eBay already has offers for SKU ${opts.sku} (${priorOffers.map((o) => o.offerId).join(", ")}); inspect them before retrying to avoid a duplicate.`
    );
  }
  const resumeOfferId = unpublished[0]?.offerId;

  // Snap item specifics to the category's current value lists (drafts made
  // earlier may hold values eBay now rejects: "EU 37.5" for "37.5"), and stop
  // before anything reaches eBay if a required one is missing.
  let aspects = draft.itemSpecifics;
  let specs: Awaited<ReturnType<typeof getAspectSpecs>> | null = null;
  try {
    specs = await getAspectSpecs(opts.categoryId);
  } catch (e) {
    console.warn(`aspect check failed, sending item specifics as drafted: ${String(e)}`);
  }
  if (specs) {
    aspects = conformAspects(aspects ?? {}, specs);
    const missing = specs.filter((s) => s.required && !aspects?.[s.name]?.length).map((s) => s.name);
    if (missing.length) {
      throw new Error(`eBay requires these item specifics for category ${opts.categoryId}: ${missing.join(", ")}. Add them to the draft, then publish again.`);
    }
    if (!Object.keys(aspects).length) aspects = undefined;
  }

  // Upload only once we know a listing will be made; unused eBay images expire.
  const imageUrls = opts.imageUrls.length
    ? opts.imageUrls
    : await uploadEbayImages(opts.photoPaths ?? []);
  if (!imageUrls.length) throw new Error("eBay publish needs photos or public HTTPS image URLs.");

  // 1. inventory item (keyed by SKU)
  await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(opts.sku)}`, {
    method: "PUT",
    body: JSON.stringify({
      availability: { shipToLocationAvailability: { quantity: opts.quantity ?? 1 } },
      condition: await ebayConditionEnum(draft.condition, opts.categoryId),
      ...(opts.packageWeightLb ? { packageWeightAndSize: { weight: { value: opts.packageWeightLb, unit: "POUND" } } } : {}),
      product: {
        title: draft.title,
        description: draft.description,
        imageUrls,
        ...(aspects ? { aspects } : {}),
      },
    }),
  });

  // 2. offer: update the stranded one, or create it
  const offerBody = JSON.stringify({
    sku: opts.sku,
    marketplaceId: "EBAY_US",
    format: "FIXED_PRICE",
    availableQuantity: opts.quantity ?? 1,
    categoryId: opts.categoryId,
    listingDescription: draft.description,
    pricingSummary: { price: { value: draft.price.toFixed(2), currency: "USD" } },
    listingPolicies: {
      fulfillmentPolicyId: opts.fulfillmentPolicyId,
      paymentPolicyId: opts.paymentPolicyId,
      returnPolicyId: opts.returnPolicyId,
    },
    merchantLocationKey: opts.merchantLocationKey,
  });
  let offerId: string;
  if (resumeOfferId) {
    await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(resumeOfferId)}`, { method: "PUT", body: offerBody });
    offerId = resumeOfferId;
  } else {
    offerId = (await ebayFetch(`/sell/inventory/v1/offer`, { method: "POST", body: offerBody })).offerId;
  }

  // 3. publish
  const published = await ebayFetch(
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
    { method: "POST" }
  );

  return { offerId, listingId: published.listingId };
}
