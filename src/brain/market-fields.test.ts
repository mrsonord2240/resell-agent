// Depop field mapping: model reply is validated against static lists; anything off-list or malformed stays unmapped.
import assert from "node:assert";
import { DEPOP_CATEGORIES, mapDepopFields, unmappedFields } from "./market-fields.js";
import type { ItemAttributes, ListingDraft } from "../types.js";

const attrs: ItemAttributes = {
  brand: "Zara", brandInferred: false, productName: null, category: "Heeled sandals", titleKeywords: [],
  size: "8", color: "black", material: "leather", condition: "like-new", flaws: [], dimensions: null, originalRetail: null,
};
const reply = (o: unknown) => async () => JSON.stringify(o);
const cat = "Womenswear > Footwear > Heels";
assert.ok(DEPOP_CATEGORIES.includes(cat));

// valid map
{
  const f = await mapDepopFields(attrs, reply({ category: cat, size: "US 8", shipping: "medium" }));
  assert.deepStrictEqual(f.category, { value: cat, mapped: true });
  assert.deepStrictEqual(f.size, { value: "US 8", mapped: true });
  assert.deepStrictEqual(f.brand, { value: "Zara", mapped: true });
  assert.deepStrictEqual(f.condition, { value: "Like new", mapped: true });
  assert.deepStrictEqual(f.color, { value: "black", mapped: true });
  assert.deepStrictEqual(f.shipping, { value: "medium", mapped: true });
  assert.deepStrictEqual(unmappedFields({ platform: "depop", title: "t", description: "d", price: 1, condition: "good", marketFields: { depop: f } }), []);
}

// malformed JSON and a throwing model: model-filled fields unmapped, no throw
for (const complete of [async () => "sorry, I can't", async () => { throw new Error("network"); }]) {
  const f = await mapDepopFields(attrs, complete);
  for (const k of ["category", "size", "shipping"] as const) assert.deepStrictEqual(f[k], { value: null, mapped: false });
  assert.strictEqual(f.condition.mapped, true);
}

// invalid category: category unmapped, the rest kept
{
  const f = await mapDepopFields(attrs, reply({ category: "Womenswear > Shoes > Pumps", size: "8", shipping: "huge" }));
  assert.deepStrictEqual(f.category, { value: null, mapped: false });
  assert.strictEqual(f.size.mapped, true);
  assert.deepStrictEqual(f.shipping, { value: null, mapped: false });
}

// missing attributes stay unmapped even if the model invents a value
{
  const f = await mapDepopFields({ ...attrs, size: null, brand: null, color: null }, reply({ category: cat, size: "8", shipping: "small" }));
  assert.strictEqual(f.size.mapped, false);
  assert.strictEqual(f.brand.mapped, false);
  assert.strictEqual(f.color.mapped, false);
}

// an off-list condition (a model or an old draft outside DEPOP_CONDITION) is unmapped, never auto-picked
{
  const f = await mapDepopFields({ ...attrs, condition: "excellent" as ItemAttributes["condition"] }, reply({ category: cat, size: "US 8", shipping: "medium" }));
  assert.deepStrictEqual(f.condition, { value: null, mapped: false });
  assert.deepStrictEqual(unmappedFields({ platform: "depop", title: "t", description: "d", price: 1, condition: "good", marketFields: { depop: f } }), ["condition"]);
}

// old drafts and unmapped lists
const old: ListingDraft = { platform: "depop", title: "t", description: "d", price: 1, condition: "good" };
assert.deepStrictEqual(unmappedFields(old), ["category", "size", "brand", "condition", "color", "shipping"]);
assert.deepStrictEqual(unmappedFields({ ...old, platform: "ebay" }), []);
{
  const f = await mapDepopFields(attrs, async () => "nope");
  assert.deepStrictEqual(unmappedFields({ ...old, marketFields: { depop: f } }), ["category", "size", "shipping"]);
}
