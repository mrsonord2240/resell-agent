// Query broadening for eBay comps. Run: npm test
import assert from "node:assert";
import { buildQueries } from "./browse.js";
import type { ItemAttributes } from "../types.js";

const a: ItemAttributes = {
  brand: "Zimmermann", brandInferred: false, productName: null, category: "Dress",
  titleKeywords: ["silk", "mini dress", "baroque print", "scarf print", "belted", "pink"],
  size: null, color: "pink", material: "silk", condition: "good", flaws: [], dimensions: null, originalRetail: null,
};

// Never the all-keywords query (eBay ANDs words; it matches nothing), specific to broad.
assert.deepStrictEqual(buildQueries(a), [
  "Zimmermann silk mini dress baroque print",
  "Zimmermann silk mini dress",
  "Zimmermann silk",
]);

// A named product leads; duplicates collapse; no brand still yields queries.
assert.strictEqual(buildQueries({ ...a, productName: "Tama Mini Dress" })[0], "Zimmermann Tama Mini Dress");
assert.deepStrictEqual(buildQueries({ ...a, brand: null, titleKeywords: [] }), ["Dress"]);

console.log("browse ok");
