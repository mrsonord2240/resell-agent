// The GUI Drafts list: what a stored GUI draft looks like in the list, and which drafts the TTL sweep must keep.
import { unmappedFields } from "./brain/market-fields.js";
import type { PlatformPublishResult } from "./publish.js";
import type { DraftBundle, Platform } from "./types.js";

/** GUI draft ids are the server's own randomUUID(); anything else (including `../`) is not a draft id. */
const GUI_DRAFT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isGuiDraftId(value: string): boolean {
  return GUI_DRAFT_ID_RE.test(value);
}

/**
 * The sweep never deletes a draft Sam still has to resolve (`unknown`/`filling`, O7) or one with a
 * `published` result: that draft is the record of a live listing.
 */
export function keepFromSweep(results: unknown): boolean {
  return Array.isArray(results) && results.some((r) => r && (r.status === "unknown" || r.status === "filling" || r.status === "published"));
}

/** The fields a draft-list row needs; DraftRecord in gui.ts satisfies it. */
export interface StoredGuiDraft {
  draftId: string;
  draft: DraftBundle;
  photos: unknown[];
  createdAt: string;
  updatedAt: string;
  publishResults: PlatformPublishResult[];
}

export type MarketState = "published" | "unknown" | "error" | "not_posted" | "held" | "none";

export interface DraftListRow {
  draftId: string;
  title: string;
  price: number | null;
  createdAt: string;
  updatedAt: string;
  thumbnailUrl: string | null;
  markets: { platform: Platform; state: MarketState; url?: string }[];
}

function marketState(result: PlatformPublishResult | undefined): MarketState {
  switch (result?.status) {
    case undefined:
    case "skipped":
      return "none";
    case "filling":
      return "unknown";
    case "published":
    case "unknown":
    case "error":
    case "not_posted":
    case "held":
      return result.status;
    default:
      return "error";
  }
}

/** Only an https link the list can open: a browser market's captured URL, or eBay's item page from its listing id. */
function publishedUrl(result: PlatformPublishResult): string | undefined {
  if (result.url && /^https:\/\//i.test(result.url)) return result.url;
  if (result.platform === "ebay" && result.listingId && /^\d+$/.test(result.listingId)) {
    return `${result.env === "sandbox" ? "https://sandbox.ebay.com" : "https://www.ebay.com"}/itm/${result.listingId}`;
  }
  return undefined;
}

export function draftListRow(record: StoredGuiDraft): DraftListRow {
  const listings = Array.isArray(record.draft?.listings) ? record.draft.listings : [];
  const lead = listings.find((l) => l.platform === "ebay") ?? listings[0];
  const results = Array.isArray(record.publishResults) ? record.publishResults : [];
  const platforms = [...new Set<Platform>([...listings.map((l) => l.platform), ...results.map((r) => r.platform)])];
  const markets = platforms.map((platform) => {
    const result = results.find((r) => r.platform === platform);
    const state = marketState(result);
    const url = state === "published" && result ? publishedUrl(result) : undefined;
    return url ? { platform, state, url } : { platform, state };
  });
  const price = lead && Number.isFinite(lead.price) ? lead.price : (Number.isFinite(record.draft?.price?.suggested) ? record.draft.price.suggested : null);
  return {
    draftId: record.draftId,
    title: lead?.title || record.draft?.attributes?.productName || "Untitled draft",
    price,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    thumbnailUrl: record.photos.length ? `/api/draft/${record.draftId}/photo/0` : null,
    markets,
  };
}

/** Every stored draft, newest first. */
export function draftListRows(records: Iterable<StoredGuiDraft>): DraftListRow[] {
  const time = (value: string) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...records].map(draftListRow).sort((a, b) => time(b.createdAt) - time(a.createdAt));
}

/** S11: per-market fields the tool could not fill, which Sam fills himself (Depop only today). */
export function unmappedByMarket(draft: DraftBundle): Partial<Record<Platform, string[]>> {
  const out: Partial<Record<Platform, string[]>> = {};
  for (const listing of Array.isArray(draft?.listings) ? draft.listings : []) {
    const fields = unmappedFields(listing);
    if (fields.length) out[listing.platform] = fields;
  }
  return out;
}
