// Checks the CLI's draft file + multi-platform post without hitting live services.
// Run: npm test
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CliError, newDraftFile, parsePlatforms, postDraft, readDraftFile, resolveEbaySettings, withDraftLock, writeDraftFile } from "./draft-file.js";
import type { DraftBundle } from "./types.js";

const bundle: DraftBundle = {
  attributes: {
    brand: "Patagonia", brandInferred: false, productName: null, category: "Fleece Jacket", titleKeywords: [],
    size: "M", color: "green", material: "fleece", condition: "good", flaws: [], dimensions: null, originalRetail: 139,
  },
  price: { suggested: 68, low: 55, high: 82, currency: "USD", basis: "test", sampleSize: 3 },
  comps: [], comparison: [], retail: [],
  listings: [
    { platform: "ebay", title: "Patagonia Fleece", description: "d", price: 68, condition: "good", categoryId: "57988" },
    { platform: "poshmark", title: "Cozy fleece", description: "d", price: 68, condition: "good" },
    { platform: "depop", title: "Fleece", description: "d", price: 68, condition: "good" },
  ],
};

const dir = mkdtempSync(join(tmpdir(), "resell-draftfile-"));
const path = join(dir, "draft.json");
const ebayFlags = {
  imageUrls: ["https://example.com/a.jpg"], merchantLocationKey: "loc", fulfillmentPolicyId: "f", paymentPolicyId: "p", returnPolicyId: "r",
};

// parsePlatforms: validates, dedupes, undefined passes through.
assert.deepStrictEqual(parsePlatforms("ebay, Depop,ebay"), ["ebay", "depop"]);
assert.strictEqual(parsePlatforms(undefined), undefined);
assert.throws(() => parsePlatforms("ebay,etsy"), (e: unknown) => e instanceof CliError && e.code === "usage" && e.exitCode === 2);

// resolveEbaySettings: flag > saved > env.
const env = { GUI_DEFAULT_MERCHANT_LOCATION_KEY: "env-loc", GUI_DEFAULT_RETURN_POLICY_ID: "env-r" } as NodeJS.ProcessEnv;
const resolved = resolveEbaySettings({ merchantLocationKey: "", returnPolicyId: "flag-r" }, { ...ebayFlags, merchantLocationKey: "" }, env);
assert.strictEqual(resolved.merchantLocationKey, "env-loc");
assert.strictEqual(resolved.returnPolicyId, "flag-r");
assert.deepStrictEqual(resolved.imageUrls, ["https://example.com/a.jpg"]);

// Old drafts without the new fields still read, and get a draftId.
writeFileSync(path, JSON.stringify(bundle));
const legacy = readDraftFile(path);
assert.ok(legacy.draftId);
assert.deepStrictEqual(legacy.publishResults, []);

// First post: eBay publishes, Poshmark fails, Depop unknown -> incomplete, results saved.
writeDraftFile(path, newDraftFile(bundle, [join(dir, "a.jpg")]));
const calls: string[] = [];
const first = await postDraft(
  { draftPath: path, ebay: ebayFlags },
  {
    publishEbay: async (_l, opts) => {
      calls.push(`ebay:${opts.sku}`);
      return { offerId: "o1", listingId: "l1" } as any;
    },
    publishBrowser: async (platform) => {
      calls.push(platform);
      if (platform === "poshmark") throw new Error("selector not found");
      return { status: "unknown", message: "no success marker" };
    },
  }
);
assert.strictEqual(first.complete, false);
assert.deepStrictEqual(first.results.map((r) => r.status), ["published", "error", "unknown"]);
const saved = readDraftFile(path);
assert.deepStrictEqual(saved.publishResults.map((r) => r.status), ["published", "error", "unknown"]);
assert.strictEqual(saved.ebay?.merchantLocationKey, "loc", "eBay settings persist for retries");
const sku = calls[0];

// Retry with no flags: eBay skipped (settings came from the file), others retried.
calls.length = 0;
const second = await postDraft(
  { draftPath: path },
  {
    publishEbay: async () => {
      throw new Error("must not republish eBay");
    },
    publishBrowser: async (platform) => {
      calls.push(platform);
      return { status: "published", message: "ok", url: `https://${platform}.example/1` };
    },
  }
);
assert.strictEqual(second.complete, true);
assert.deepStrictEqual(second.results.map((r) => r.status), ["skipped", "published", "published"]);
assert.deepStrictEqual(readDraftFile(path).publishResults.map((r) => r.status), ["published", "published", "published"]);
assert.deepStrictEqual(calls, ["poshmark", "depop"]);
assert.ok(sku.startsWith("ebay:resale-gui-"), "stable per-draft SKU");

// Lock: a second concurrent post is refused, and the lock is released afterwards.
await withDraftLock(path, async () => {
  await assert.rejects(postDraft({ draftPath: path }), (e: unknown) => e instanceof CliError && e.code === "draft_locked");
});
assert.ok(!existsSync(`${path}.lock`));

// CLI envelope: stdout is exactly one JSON object, exit codes per contract.
const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, "--json"], { cwd: dir, encoding: "utf8" });

const help = run("help");
assert.strictEqual(help.status, 0);
const helpEnv = JSON.parse(help.stdout);
assert.strictEqual(helpEnv.ok, true);
assert.ok(helpEnv.data.commands.some((c: { name: string }) => c.name === "post"));

const missing = run("post", "--draft", join(dir, "nope.json"));
assert.strictEqual(missing.status, 1);
assert.strictEqual(JSON.parse(missing.stdout).error.code, "draft_unreadable");

const bad = run("post", "--draft", path, "--platforms", "etsy");
assert.strictEqual(bad.status, 2);
assert.strictEqual(JSON.parse(bad.stdout).error.code, "usage");

const status = run("status", "--draft", path);
assert.strictEqual(status.status, 0);
const statusData = JSON.parse(status.stdout).data;
assert.deepStrictEqual(statusData.listings.map((l: any) => l.publish.status), ["published", "published", "published"]);
assert.ok(!readFileSync(path, "utf8").includes("lock"));

console.log("draft-file ok");
