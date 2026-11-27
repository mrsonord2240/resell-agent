import { complete, parseJson } from "./anthropic.js";
import { DEPOP_FIELD_NAMES, type DepopFields, type ItemAttributes, type ListingDraft, type MarketField } from "../types.js";

// STATIC, best-known Depop sell-form category tree. Not verified against the live form:
// Task 4 (Depop fill) must check this against the real sell form and correct it.
const DEPOP_TREE: Record<string, Record<string, string[]>> = {
  Menswear: {
    Tops: ["T-shirts", "Shirts", "Hoodies", "Sweatshirts", "Jumpers", "Polo shirts", "Vests"],
    Bottoms: ["Jeans", "Trousers", "Shorts", "Joggers"],
    Coats_and_jackets: ["Coats", "Jackets", "Blazers", "Gilets"],
    Footwear: ["Trainers", "Boots", "Sandals", "Formal shoes"],
    Accessories: ["Bags", "Hats", "Belts", "Jewellery", "Sunglasses", "Scarves"],
    Suits: ["Suits"],
  },
  Womenswear: {
    Tops: ["T-shirts", "Shirts and blouses", "Hoodies", "Sweatshirts", "Jumpers", "Cardigans", "Crop tops", "Vests"],
    Dresses: ["Mini dresses", "Midi dresses", "Maxi dresses"],
    Bottoms: ["Jeans", "Trousers", "Shorts", "Skirts", "Leggings"],
    Coats_and_jackets: ["Coats", "Jackets", "Blazers", "Gilets"],
    Footwear: ["Heels", "Trainers", "Boots", "Sandals", "Flats"],
    Accessories: ["Bags", "Hats", "Belts", "Jewellery", "Sunglasses", "Scarves"],
    Swimwear: ["Bikinis", "Swimsuits"],
    Lingerie_and_nightwear: ["Lingerie", "Pyjamas"],
  },
  Kids: {
    Clothing: ["Tops", "Bottoms", "Dresses", "Coats and jackets"],
    Footwear: ["Shoes", "Boots"],
    Accessories: ["Bags", "Hats"],
  },
  "Everything else": {
    Home: ["Decor", "Kitchen"],
    Collectables: ["Toys", "Books", "Music"],
    Beauty: ["Makeup", "Skincare"],
  },
};

const pretty = (s: string) => s.replace(/_/g, " ");
export const DEPOP_CATEGORIES: string[] = Object.entries(DEPOP_TREE).flatMap(([dept, cats]) =>
  Object.entries(cats).flatMap(([cat, subs]) => subs.map((sub) => `${dept} > ${pretty(cat)} > ${sub}`))
);

// STATIC Depop condition options; check against the live form (Task 4).
export const DEPOP_CONDITION: Record<ItemAttributes["condition"], string> = {
  NWT: "Brand new",
  "like-new": "Like new",
  good: "Used - Good",
  fair: "Used - Fair",
};
// Depop's other options ("Used - Excellent") are never auto-picked; Sam can change it in the form.

export const DEPOP_SHIPPING_SIZES = ["small", "medium", "large"] as const;

const unmapped = (): MarketField => ({ value: null, mapped: false });
const fromAttr = (v: string | null | undefined): MarketField => {
  const t = v?.trim();
  return t ? { value: t, mapped: true } : unmapped();
};
const fromReply = (v: unknown, allowed?: readonly string[]): MarketField => {
  if (typeof v !== "string" || !v.trim()) return unmapped();
  const t = v.trim();
  if (!allowed) return { value: t, mapped: true };
  const hit = allowed.find((a) => a.toLowerCase() === t.toLowerCase());
  return hit ? { value: hit, mapped: true } : unmapped();
};

const SYSTEM = `You map a used item's attributes onto Depop's sell form.
Reply with ONLY a JSON object: { "category": string|null, "size": string|null, "shipping": string|null }.
- category: copy EXACTLY one entry from the allowed list, or null if none fits clearly.
- size: the size as Depop shows it for that category (e.g. "US 8", "M", "UK 10"). Use only the size in the attributes; null if absent or you cannot place it confidently. Never invent one.
- shipping: parcel size "small" (fits a bag), "medium" (shoebox) or "large" (coats, bulky), or null if unsure.`;

type Complete = (system: string, messages: Array<{ role: "user"; content: string }>, maxTokens?: number) => Promise<string>;

// attributes -> Depop form fields. Never throws: a bad or failed model reply leaves the model-filled
// fields (category, size, shipping) unmapped for Sam. Brand, condition and color come straight from attributes.
export async function mapDepopFields(attrs: ItemAttributes, completeFn: Complete = complete): Promise<DepopFields> {
  let r: Record<string, unknown> = {};
  try {
    const raw = await completeFn(
      SYSTEM,
      [{ role: "user", content: `Attributes: ${JSON.stringify(attrs)}\n\nAllowed categories:\n${DEPOP_CATEGORIES.join("\n")}` }],
      600
    );
    r = parseJson<Record<string, unknown>>(raw) ?? {};
  } catch {
    r = {};
  }
  return {
    category: fromReply(r.category, DEPOP_CATEGORIES),
    size: attrs.size?.trim() ? fromReply(r.size) : unmapped(),
    brand: fromAttr(attrs.brand),
    condition: fromAttr(DEPOP_CONDITION[attrs.condition]), // off-list: unmapped, left for Sam
    color: fromAttr(attrs.color),
    shipping: fromReply(r.shipping, DEPOP_SHIPPING_SIZES),
  };
}

// Field names Sam still has to fill. Depop drafts without fields (old drafts) read as all unmapped.
export function unmappedFields(listing: ListingDraft): string[] {
  if (listing.platform !== "depop") return [];
  const f = listing.marketFields?.depop;
  return DEPOP_FIELD_NAMES.filter((n) => !f?.[n]?.mapped);
}
