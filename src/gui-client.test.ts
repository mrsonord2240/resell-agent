// The GUI script's pure helpers, lifted out of the built script and run here. No browser, no server.
// Run: npm test
import assert from "node:assert";
import { buildGuiScript } from "./gui-client.js";

const script = buildGuiScript({
  platforms: ["ebay", "depop"],
  ebayDefaults: { sku: "", merchantLocationKey: "", fulfillmentPolicyId: "", paymentPolicyId: "", returnPolicyId: "" },
});
const lines = script.split("\n");
/** One top-level declaration of the script: the single line, or a function through its closing `}`. */
function source(start: string): string {
  const i = lines.findIndex((l) => l.startsWith(start));
  assert.ok(i >= 0, `the script declares ${start}`);
  if (!start.startsWith("function")) return lines[i];
  return lines.slice(i, lines.indexOf("}", i) + 1).join("\n");
}
const deleteConfirmText = new Function(`${source("var PLATFORM_LABELS")}\n${source("function deleteConfirmText(")}\nreturn deleteConfirmText;`)() as (row: unknown) => string;

const row = (markets: { platform: string; state: string; url?: string }[]) => ({ title: "Green fleece", markets });

// Nothing live or unconfirmed: the plain confirm.
assert.strictEqual(
  deleteConfirmText(row([{ platform: "ebay", state: "error" }, { platform: "depop", state: "not_posted" }])),
  'Delete the draft "Green fleece"? Its photos, edits and publish results are removed from this computer.'
);
// A live listing: deleting never ends it.
assert.match(deleteConfirmText(row([{ platform: "ebay", state: "published", url: "https://www.ebay.com/itm/1" }])), /live eBay listing/);
// A market Sam hasn't confirmed (unknown, or a filling the Drafts list shows as unknown): the record is lost.
for (const state of ["unknown", "filling"]) {
  const text = deleteConfirmText(row([{ platform: "depop", state }]));
  assert.match(text, /This draft has a Depop listing you haven't confirmed; deleting it loses that record\./, state);
  assert.doesNotMatch(text, /live Depop listing/);
}

// Top navigation: one view shows at a time, and its nav button is marked current.
{
  const el = (view: string) => ({ dataset: { view }, hidden: false });
  const sections = [el("listing"), el("listing"), el("drafts")];
  const attrs: Record<string, string | null> = {};
  const navButton = (view: string) => ({
    dataset: { nav: view },
    setAttribute: (name: string, value: string) => { attrs[`${view}:${name}`] = value; },
    removeAttribute: (name: string) => { attrs[`${view}:${name}`] = null; },
  });
  const navs = [navButton("listing"), navButton("drafts")];
  const fakeDocument = { querySelectorAll: (sel: string) => (sel === "[data-view]" ? sections : sel === "[data-nav]" ? navs : []) };
  const setView = new Function("document", `${source("function setView(")}\nreturn setView;`)(fakeDocument) as (view: string) => void;
  setView("drafts");
  assert.deepEqual(sections.map((s) => s.hidden), [true, true, false]);
  assert.equal(attrs["drafts:aria-current"], "page");
  assert.equal(attrs["listing:aria-current"], null);
  setView("listing");
  assert.deepEqual(sections.map((s) => s.hidden), [false, false, true]);
  assert.equal(attrs["listing:aria-current"], "page");
  assert.equal(attrs["drafts:aria-current"], null);
}

console.log("gui-client ok");
