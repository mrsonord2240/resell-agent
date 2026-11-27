// Opt-in eval: runs the Depop mapping prompt against the real model (costs API calls).
// Run: npm run eval:market-fields. Not part of `npm test`.
import { readFileSync } from "node:fs";
import { mapDepopFields } from "./brain/market-fields.js";
import type { ItemAttributes } from "./types.js";

interface Case {
  name: string;
  attributes: ItemAttributes;
  expectedCategory: string | null; // null = ambiguous: the model should leave category unmapped
}

const cases = JSON.parse(readFileSync(new URL("../evals/market-fields.cases.json", import.meta.url), "utf8")) as Case[];
let failed = 0;
for (const c of cases) {
  const f = await mapDepopFields(c.attributes);
  const got = f.category.value;
  const ok = got === c.expectedCategory;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.name}: expected ${c.expectedCategory ?? "unmapped"}, got ${got ?? "unmapped"}`);
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed ? 1 : 0;
