// Publish state rules (D6, O5, O9, E13) and the browserSession seam (E2), without live services.
// Run: npm test
import assert from "node:assert";
import {
  isPublishComplete,
  mergePublishResults,
  publishDraftBundle,
  type BrowserSession,
  type FillRecorder,
  type PlatformPublishResult,
  type PublishStatus,
} from "./publish.js";
import type { DraftBundle, Platform } from "./types.js";

process.env.EBAY_ENV = "production";

const draft: DraftBundle = {
  attributes: {
    brand: "Patagonia", brandInferred: false, productName: null, category: "Fleece Jacket", titleKeywords: [],
    size: "M", color: "green", material: "fleece", condition: "good", flaws: [], dimensions: null, originalRetail: 139,
  },
  price: { suggested: 68, low: 55, high: 82, currency: "USD", basis: "test", sampleSize: 5 },
  comps: [], comparison: [], retail: [],
  listings: [
    { platform: "ebay", title: "Patagonia Fleece", description: "d", price: 68, condition: "good", categoryId: "57988" },
    { platform: "depop", title: "Fleece", description: "d", price: 68, condition: "good" },
  ],
};
const ebay = { imageUrls: [], merchantLocationKey: "loc", fulfillmentPolicyId: "f", paymentPolicyId: "p", returnPolicyId: "r" };

/** One run over a single market with a given prior state; reports whether the market was attempted. */
async function runOnce(platform: Platform, prior: PlatformPublishResult | undefined) {
  const attempted: string[] = [];
  const session: BrowserSession = {
    fill: async (p) => {
      attempted.push(p);
      return { status: "published", message: "posted", url: "https://www.depop.com/products/x" };
    },
  };
  const run = await publishDraftBundle(
    { draft, photoPaths: ["/tmp/a.jpg"], platforms: [platform], ebay, previousResults: prior ? [prior] : [] },
    {
      publishEbay: async () => {
        attempted.push("ebay");
        return { offerId: "o", listingId: "l" };
      },
      publishBrowser: async () => {
        throw new Error("the legacy browser path must not run when a session is passed");
      },
      browserSession: session,
    }
  );
  return { attempted: attempted.length > 0, result: run.results[0] };
}

const prior = (platform: Platform, status: PublishStatus, extra: Partial<PlatformPublishResult> = {}): PlatformPublishResult =>
  ({ platform, status, message: "prior", ...extra });

// Transition table. true = the market is attempted this run; false = skipped and reported.
const browserTable: [PublishStatus | "none", boolean][] = [
  ["none", true],
  ["published", false],
  ["unknown", false],
  ["filling", false],
  ["not_posted", true],
  ["error", true],
  ["skipped", true],
  ["held", false],
];
for (const [status, attempts] of browserTable) {
  const { attempted, result } = await runOnce("depop", status === "none" ? undefined : prior("depop", status));
  assert.strictEqual(attempted, attempts, `depop prior ${status}: attempted should be ${attempts}`);
  assert.strictEqual(result.status, attempts ? "published" : "skipped", `depop prior ${status}`);
}

const ebayTable: [PublishStatus | "none", Partial<PlatformPublishResult>, boolean][] = [
  ["none", {}, true],
  ["published", { env: "production" }, false],
  ["published", { env: "sandbox" }, true], // E13: a sandbox success never stands in for production
  ["published", {}, true], // no env: written before E13, goes back to eBay's SKU lookup
  ["unknown", {}, true], // D6: eBay keeps its idempotent retry
  ["not_posted", {}, true],
  ["error", {}, true],
  ["skipped", {}, true],
  ["held", {}, false], // O5: held blocks every market, eBay included
];
for (const [status, extra, attempts] of ebayTable) {
  const { attempted, result } = await runOnce("ebay", status === "none" ? undefined : prior("ebay", status, extra));
  assert.strictEqual(attempted, attempts, `ebay prior ${status} ${JSON.stringify(extra)}: attempted should be ${attempts}`);
  assert.strictEqual(result.status, attempts ? "published" : "skipped");
}

// Skip messages say why and what to do.
assert.match((await runOnce("depop", prior("depop", "unknown"))).result.message, /verify/i);
assert.match((await runOnce("ebay", prior("ebay", "held"))).result.message, /mark --approve/);

// mergePublishResults: a new "skipped" never replaces a stored state.
for (const status of ["published", "unknown", "filling", "held"] as const) {
  const merged = mergePublishResults([prior("depop", status)], [prior("depop", "skipped")]);
  assert.strictEqual(merged[0].status, status, `prior ${status} survives a new skipped`);
}
assert.strictEqual(mergePublishResults([prior("depop", "error")], [prior("depop", "published")])[0].status, "published");

// The session seam: outcome states map through, a "published" with no URL is unknown, a throw is an error.
const sessionRun = async (session: BrowserSession, recorder?: FillRecorder) =>
  (await publishDraftBundle(
    { draft, photoPaths: ["/tmp/a.jpg"], platforms: ["depop"] },
    { browserSession: session, fillRecorder: recorder }
  )).results[0];
assert.strictEqual((await sessionRun({ fill: async () => ({ status: "not_posted", message: "tab closed" }) })).status, "not_posted");
assert.strictEqual((await sessionRun({ fill: async () => ({ status: "published", message: "no url" }) })).status, "unknown");
assert.strictEqual((await sessionRun({ fill: async () => { throw new Error("selector missing"); } })).status, "error");

// With a recorder, the fill is bracketed by begin and finish; submitSeen follows the outcome.
const log: string[] = [];
const recorder: FillRecorder = {
  begin: async (p) => {
    log.push(`begin:${p}`);
    return { attemptId: "attempt-1" };
  },
  finish: async (p, attemptId, result, { submitSeen }) => {
    log.push(`finish:${p}:${attemptId}:${result.status}:${submitSeen}`);
    return { ...result, message: "recorded" };
  },
};
const recorded = await sessionRun(
  { fill: async () => { log.push("fill"); return { status: "published", message: "ok", url: "https://www.depop.com/products/y" }; } },
  recorder
);
assert.deepStrictEqual(log, ["begin:depop", "fill", "finish:depop:attempt-1:published:true"]);
assert.strictEqual(recorded.message, "recorded");
assert.strictEqual(recorded.attemptId, "attempt-1");
log.length = 0;
await sessionRun({ fill: async () => ({ status: "not_posted", message: "closed" }) }, recorder);
assert.deepStrictEqual(log, ["begin:depop", "finish:depop:attempt-1:not_posted:false"]);
// A begin that fails (draft locked) fills nothing and reports an error.
let filled = false;
const lockedBegin = await sessionRun(
  { fill: async () => { filled = true; return { status: "not_posted", message: "" }; } },
  { begin: async () => { throw new Error("draft.json is already being published."); }, finish: recorder.finish }
);
assert.strictEqual(lockedBegin.status, "error");
assert.strictEqual(filled, false);
// A begin that finds the stored state changed (published since the caller's read) fills nothing and reports the skip.
const refused = await sessionRun(
  { fill: async () => { filled = true; return { status: "not_posted", message: "" }; } },
  { begin: async (p) => ({ skipped: { platform: p, status: "skipped", message: "already published" } }), finish: recorder.finish }
);
assert.deepStrictEqual([refused.status, refused.message, refused.attemptId], ["skipped", "already published", undefined]);
assert.strictEqual(filled, false);

// O9: completeness comes from the merged state of the requested markets.
const stored = (statuses: [Platform, PublishStatus][]) => statuses.map(([p, s]) => prior(p, s));
assert.strictEqual(isPublishComplete(stored([["ebay", "published"], ["depop", "published"]]), ["ebay", "depop"]), true);
assert.strictEqual(isPublishComplete(stored([["ebay", "published"], ["depop", "unknown"]]), ["ebay", "depop"]), false);
assert.strictEqual(isPublishComplete(stored([["ebay", "held"], ["depop", "published"]]), ["ebay", "depop"]), false);
assert.strictEqual(isPublishComplete(stored([["ebay", "published"], ["depop", "filling"]]), ["ebay", "depop"]), false);
assert.strictEqual(isPublishComplete(stored([["ebay", "published"]]), ["ebay", "depop"]), false, "a requested market with no state is incomplete");
assert.strictEqual(isPublishComplete(stored([["ebay", "published"], ["depop", "unknown"]]), ["ebay"]), true, "only requested markets count");

console.log("publish-states ok");
