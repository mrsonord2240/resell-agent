// Item specifics conformed to eBay's value lists. Run: npm test
import assert from "node:assert";
import { conformAspects, type AspectSpec } from "./taxonomy.js";

// Live Heels (55793) shapes, 2026-11-26: size aspects are FREE_TEXT in the taxonomy,
// yet publish rejects anything outside the listed values (errorId 25129).
const specs: AspectSpec[] = [
  { name: "EU Shoe Size", required: false, values: ["37", "37 1/3", "37.5", "38"], selectionOnly: false },
  { name: "US Shoe Size", required: true, values: ["7", "7.5", "8"], selectionOnly: false },
  { name: "Color", required: false, values: ["Silver", "Taupe"], selectionOnly: false },
  { name: "Department", required: true, values: ["Women", "Men", "Unisex Adults"], selectionOnly: true },
  { name: "Style", required: false, values: [], selectionOnly: false },
];

assert.deepEqual(
  conformAspects(
    {
      "EU Shoe Size": ["EU 37.5"],      // region prefix the model added
      "US Shoe Size": ["US 7.5"],
      Color: ["silver"],                // case
      Department: ["Womens"],           // not a listed choice: dropped
      Style: ["Pump"],                  // no value list: kept as written
      Brand: ["Stuart Weitzman"],       // not in this spec list: kept
    },
    specs
  ),
  {
    "EU Shoe Size": ["37.5"],
    "US Shoe Size": ["7.5"],
    Color: ["Silver"],
    Style: ["Pump"],
    Brand: ["Stuart Weitzman"],
  }
);

// A free-text aspect with a value list keeps an unmatched value (eBay may accept it).
assert.deepEqual(conformAspects({ Color: ["Champagne"] }, specs), { Color: ["Champagne"] });
// A selection-only match is canonicalized, not dropped.
assert.deepEqual(conformAspects({ Department: ["women"] }, specs), { Department: ["Women"] });

console.log("taxonomy.test ok");
