export type Platform = "ebay" | "poshmark" | "depop";

export interface ItemAttributes {
  brand: string | null;
  brandInferred: boolean; // true = inferred from design signatures, not read off a label
  productName: string | null; // exact product when identifiable, e.g. "Embroidered Linen Midi Dress"
  category: string;
  titleKeywords: string[];
  size: string | null;
  color: string | null;
  material: string | null;
  condition: "NWT" | "like-new" | "good" | "fair";
  flaws: string[];
  dimensions: string | null; // estimated size, e.g. "≈ 15 x 11 x 4 in (estimate)"
  shippingWeightLb?: number | null; // estimated packed weight, box included; absent on old drafts
  originalRetail: number | null;
  resaleLow?: number | null;
  resaleHigh?: number | null;
}

export interface Comp {
  title: string;
  price: number;
  currency: string;
  condition: string | null;
  url: string;
  source:
    | "ebay-active"
    | "ebay-sold"
    | "poshmark-active"
    | "thredup-active"
    | "therealreal-active"
    | "mercari-active";
}

// A new/retail offer for the same item (like a Google Shopping row).
export interface RetailListing {
  retailer: string;
  price: number;
  currency: string;
  url: string;
}

// One row of the cross-platform price comparison (trimmed stats per source).
export interface PlatformStat {
  source: Comp["source"];
  median: number;
  low: number;
  high: number;
  n: number;
}

export interface PriceSuggestion {
  suggested: number;
  low: number;
  high: number;
  currency: string;
  basis: string;
  sampleSize: number;
}

// One browser-market form field. mapped=false means the tool could not fill it and Sam must.
export interface MarketField {
  value: string | null;
  mapped: boolean;
}

// Marketplace description caps (characters). eBay has none worth enforcing.
export const DESCRIPTION_LIMITS: Partial<Record<Platform, number>> = { depop: 1000, poshmark: 1500 };
export const PLATFORM_NAMES: Record<Platform, string> = { ebay: "eBay", poshmark: "Poshmark", depop: "Depop" };

export const DEPOP_FIELD_NAMES = ["category", "size", "brand", "condition", "color", "shipping"] as const;
export type DepopFieldName = (typeof DEPOP_FIELD_NAMES)[number];
export type DepopFields = Record<DepopFieldName, MarketField>;

// Per-market fields, keyed by platform. Poshmark can add its own key later; eBay keeps categoryId/itemSpecifics.
export interface MarketFields {
  depop?: DepopFields;
}

export interface ListingDraft {
  platform: Platform;
  title: string;
  description: string;
  price: number;
  condition: ItemAttributes["condition"];
  // eBay-only, filled at draft time by the taxonomy step. Poshmark ignores these.
  categoryId?: string;
  itemSpecifics?: Record<string, string[]>;
  // eBay-only: packed weight in pounds, estimated at draft time, editable. Calculated shipping needs it.
  packageWeightLb?: number;
  // Depop (browser markets): form fields from the mapping step. Absent on old drafts = all unmapped.
  marketFields?: MarketFields;
}

export interface DraftBundle {
  attributes: ItemAttributes;
  price: PriceSuggestion;
  comps: Comp[];
  comparison: PlatformStat[];
  retail: RetailListing[]; // where the exact piece sells new, when identified
  listings: ListingDraft[];
}
