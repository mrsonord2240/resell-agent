import { cfg } from "../config.js";
import { getUserToken } from "./auth.js";
import { uploadEbayImages } from "./media.js";
import type { ListingDraft } from "../types.js";

// eBay condition enums for the Inventory API.
function ebayConditionEnum(c: ListingDraft["condition"]): string {
  switch (c) {
    case "NWT":
      return "NEW_WITH_TAGS";
    case "like-new":
      return "LIKE_NEW";
    case "good":
      return "USED_EXCELLENT";
    case "fair":
      return "USED_GOOD";
  }
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
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${text}`);
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
  const result = await ebayFetch(`/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`, { method: "GET" });
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
      condition: ebayConditionEnum(draft.condition),
      product: {
        title: draft.title,
        description: draft.description,
        imageUrls,
        ...(draft.itemSpecifics ? { aspects: draft.itemSpecifics } : {}),
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
