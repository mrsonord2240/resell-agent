import { cfg } from "../config.js";
import { getAppToken } from "./auth.js";

// eBay Taxonomy API: resolve a listing title to a leaf category, and fetch the
// item-specific aspects that category expects. App-token path, no user login.

export interface AspectSpec {
  name: string;
  required: boolean;
  /** eBay's listed values. Publish can reject values outside this list even for FREE_TEXT aspects (sizes: errorId 25129). */
  values: string[];
  selectionOnly: boolean;
}

function normalizeAspectValue(value: string): string {
  return value.trim().toLowerCase().replace(/^(eu|us|uk|au)\s*:?\s*/, "").replace(/\s+/g, " ");
}

/**
 * Snap item specifics onto eBay's value lists: case and region prefixes ("EU 37.5")
 * resolve to the listed value ("37.5"). An unmatched value is dropped for a
 * selection-only aspect and kept for a free-text one. Aspects not in specs pass through.
 */
export function conformAspects(specifics: Record<string, string[]>, specs: AspectSpec[]): Record<string, string[]> {
  const byName = new Map(specs.map((s) => [s.name.toLowerCase(), s]));
  const out: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(specifics)) {
    const spec = byName.get(name.toLowerCase());
    if (!spec || !spec.values.length) {
      out[name] = values;
      continue;
    }
    const listed = new Map<string, string>();
    for (const v of spec.values) {
      listed.set(v.toLowerCase(), v);
      if (!listed.has(normalizeAspectValue(v))) listed.set(normalizeAspectValue(v), v);
    }
    const kept = values.flatMap((v) => {
      const match = listed.get(v.trim().toLowerCase()) ?? listed.get(normalizeAspectValue(v));
      if (match) return [match];
      return spec.selectionOnly ? [] : [v];
    });
    if (kept.length) out[spec.name] = kept;
  }
  return out;
}

async function taxonomyGet(path: string): Promise<any> {
  const token = await getAppToken();
  const res = await fetch(`${cfg.apiBase}/commerce/taxonomy/v1${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Accept-Language": "en-US" },
  });
  if (!res.ok) throw new Error(`taxonomy ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

let treeIdCache: string | null = null;
async function categoryTreeId(): Promise<string> {
  if (treeIdCache) return treeIdCache;
  const j = await taxonomyGet(`/get_default_category_tree_id?marketplace_id=EBAY_US`);
  treeIdCache = j.categoryTreeId as string;
  return treeIdCache;
}

// Best-effort: returns null if eBay can't suggest one (e.g. sandbox gaps), so the
// pipeline degrades to a manual --category flag instead of hard-failing.
export async function suggestCategory(
  title: string
): Promise<{ categoryId: string; categoryName: string } | null> {
  try {
    const tree = await categoryTreeId();
    const j = await taxonomyGet(
      `/category_tree/${tree}/get_category_suggestions?q=${encodeURIComponent(title)}`
    );
    const c = j.categorySuggestions?.[0]?.category;
    return c ? { categoryId: c.categoryId, categoryName: c.categoryName } : null;
  } catch (e) {
    console.warn(`category suggestion failed, continuing without: ${String(e)}`);
    return null;
  }
}

/** Every aspect eBay lists for the category, with its value list. Throws on API failure. */
export async function getAspectSpecs(categoryId: string): Promise<AspectSpec[]> {
  const tree = await categoryTreeId();
  const j = await taxonomyGet(
    `/category_tree/${tree}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`
  );
  return (j.aspects ?? []).map((a: any) => ({
    name: a.localizedAspectName as string,
    required: Boolean(a.aspectConstraint?.aspectRequired),
    values: (a.aspectValues ?? []).map((v: any) => v.localizedValue as string),
    selectionOnly: a.aspectConstraint?.aspectMode === "SELECTION_ONLY",
  }));
}

export async function getRequiredAspects(categoryId: string): Promise<AspectSpec[]> {
  try {
    const specs = await getAspectSpecs(categoryId);
    // Required first, then a few recommended, capped so the fill prompt stays small.
    return specs.sort((x, y) => Number(y.required) - Number(x.required)).slice(0, 20);
  } catch (e) {
    console.warn(`aspect fetch failed, listing without specifics: ${String(e)}`);
    return [];
  }
}
