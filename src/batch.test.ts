// The batch runner (post-batch), its index (status --batch) and `mark`, without live services.
// Model and eBay calls are injected fakes; the Depop phase runs on a fake BrowserSession.
// Run: npm test
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BATCH_MARKETS,
  buildBatchIndex,
  holdReason,
  itemPhotos,
  photoSetId,
  runBatch,
  runLogPath,
  type BatchBrowserSession,
  type BatchDeps,
  type RunLogLine,
} from "./batch.js";
import {
  applyMark,
  beginFill,
  CliError,
  draftSku,
  markDraft,
  readDraftFile,
  withDraftLock,
  writeDraftFile,
} from "./draft-file.js";
import type { PlatformPublishResult } from "./publish.js";
import type { DraftBundle, ListingDraft, Platform } from "./types.js";

const root = mkdtempSync(join(tmpdir(), "resell-batch-"));
let seq = 0;
/** A batch dir with one subfolder per item; file bodies are written as given. */
function makeBatch(items: Record<string, Record<string, string>>): string {
  const dir = join(root, `batch-${++seq}`);
  mkdirSync(dir, { recursive: true });
  for (const [item, files] of Object.entries(items)) {
    mkdirSync(join(dir, item), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      const p = join(dir, item, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
  }
  return dir;
}

function listing(platform: Platform): ListingDraft {
  return { platform, title: `${platform} title`, description: "d", price: 68, condition: "good", ...(platform === "ebay" ? { categoryId: "57988" } : {}) };
}
function bundle(platforms: Platform[], over: { brandInferred?: boolean; sampleSize?: number } = {}): DraftBundle {
  return {
    attributes: {
      brand: "Patagonia", brandInferred: over.brandInferred ?? false, productName: null, category: "Fleece Jacket", titleKeywords: [],
      size: "M", color: "green", material: "fleece", condition: "good", flaws: [], dimensions: null, originalRetail: 139,
    },
    price: { suggested: 68, low: 55, high: 82, currency: "USD", basis: "test", sampleSize: over.sampleSize ?? 5 },
    comps: [], comparison: [], retail: [],
    listings: platforms.map(listing),
  };
}

const ebayFlags = { merchantLocationKey: "loc", fulfillmentPolicyId: "f", paymentPolicyId: "p", returnPolicyId: "r" };

/** Fakes for one test: the model (buildDraft), eBay, and a Depop session. Records every call. */
function fakes(opts: { brandInferred?: boolean; sampleSize?: number; ebayThrows?: string; depop?: "published" | "not_posted" } = {}) {
  const drafted: { photos: string[]; platforms: Platform[] }[] = [];
  const ebay: { sku: string; photos: string[] }[] = [];
  const fills: { platform: string; photos: string[]; title: string }[] = [];
  let closed = 0;
  const session: BatchBrowserSession = {
    async fill(platform, l, photos) {
      fills.push({ platform, photos, title: l.title });
      return opts.depop === "not_posted"
        ? { status: "not_posted", message: "tab closed" }
        : { status: "published", message: "posted", url: `https://www.depop.com/products/item-${fills.length}` };
    },
    async close() {
      closed++;
    },
  };
  const deps: BatchDeps = {
    buildDraft: async (photos, _notes, platforms = []) => {
      drafted.push({ photos, platforms });
      return bundle(platforms, opts);
    },
    publish: {
      publishEbay: async (_l, o) => {
        ebay.push({ sku: o.sku, photos: o.photoPaths ?? [] });
        if (opts.ebayThrows) throw new Error(opts.ebayThrows);
        return { offerId: "o1", listingId: `l${ebay.length}` };
      },
    },
    openBrowserSession: async () => session,
    ebayStock: async () => "active", // O4 check: still for sale (no eBay call in tests)
  };
  return { deps, drafted, ebay, fills, closed: () => closed };
}

const status = (draft: string, market: Platform) => readDraftFile(draft).publishResults.find((r) => r.platform === market)?.status ?? "none";
const logLines = (itemDir: string): RunLogLine[] =>
  existsSync(runLogPath(itemDir)) ? readFileSync(runLogPath(itemDir), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const isCode = (code: string, exitCode?: number) => (e: unknown) =>
  e instanceof CliError && e.code === code && (exitCode === undefined || e.exitCode === exitCode);

// --- Photos, SKU (E8) and the .resell/ exclusion (E10) ---
{
  const dir = makeBatch({
    a: { "2.jpg": "two", "1.JPG": "one", "notes.txt": "x", "draft.json": "{}" },
    b: { "1.JPG": "one", "2.jpg": "two" },
    c: { "1.JPG": "one", "2.jpg": "TWO (reshot)" },
  });
  const a = itemPhotos(join(dir, "a"));
  assert.deepStrictEqual(a.map((p) => p.slice(-5)), ["1.JPG", "2.jpg"], "top-level photos only, sorted by name");
  assert.strictEqual(photoSetId(a), photoSetId(itemPhotos(join(dir, "b"))), "same photos give the same SKU id");
  assert.notStrictEqual(photoSetId(a), photoSetId(itemPhotos(join(dir, "c"))), "a reshot photo is a new item");
  const before = photoSetId(a);
  mkdirSync(join(dir, "a", ".resell"));
  writeFileSync(join(dir, "a", ".resell", "error-1.png"), "screenshot");
  assert.deepStrictEqual(itemPhotos(join(dir, "a")), a, "a screenshot in .resell/ is not a photo");
  assert.strictEqual(photoSetId(itemPhotos(join(dir, "a"))), before, "a screenshot in .resell/ leaves the SKU alone");
}

// --- Hold rule (O5, C5) ---
assert.strictEqual(holdReason(bundle(["ebay"])), null);
assert.match(holdReason(bundle(["ebay"], { brandInferred: true }))!, /brand/i);
assert.match(holdReason(bundle(["ebay"], { sampleSize: 2 }))!, /comps/i);
{
  // C5: three comps that did not set the price (anchor fallback, sampleSize 0) still hold.
  const b = bundle(["ebay"], { sampleSize: 0 });
  b.comps = [1, 2, 3].map((i) => ({ title: `c${i}`, price: 50, currency: "USD", condition: null, url: "https://x", source: "ebay-sold" as const }));
  assert.ok(holdReason(b), "comps that did not price the item do not count");
}

// --- mark transitions (D3), one per transition, on the pure function ---
{
  const r = (platform: Platform, s: PlatformPublishResult["status"], extra: Partial<PlatformPublishResult> = {}): PlatformPublishResult => ({ platform, status: s, message: s, ...extra });
  const url = "https://www.depop.com/products/x";

  // unknown -> published with the URL
  let out = applyMark([r("depop", "unknown")], { kind: "posted", market: "depop", url });
  assert.deepStrictEqual(out.publishResults.map((x) => [x.status, x.url]), [["published", url]]);
  assert.deepStrictEqual(out.changes.map((c) => [c.market, c.from, c.to]), [["depop", "unknown", "published"]]);
  // filling (stale) -> published
  out = applyMark([r("depop", "filling", { attemptId: "a1" })], { kind: "posted", market: "depop", url });
  assert.strictEqual(out.publishResults[0].status, "published");
  // unknown -> not_posted
  out = applyMark([r("ebay", "published"), r("depop", "unknown")], { kind: "not_posted", market: "depop" });
  assert.deepStrictEqual(out.publishResults.map((x) => x.status), ["published", "not_posted"]);
  assert.deepStrictEqual(out.changes.map((c) => [c.from, c.to]), [["unknown", "not_posted"]]);
  // error -> not_posted, none -> published
  assert.strictEqual(applyMark([r("depop", "error")], { kind: "not_posted", market: "depop" }).publishResults[0].status, "not_posted");
  out = applyMark([], { kind: "posted", market: "depop", url });
  assert.deepStrictEqual(out.changes.map((c) => [c.from, c.to]), [["none", "published"]]);
  // held -> (approve) -> none, for every held market; others untouched
  out = applyMark([r("ebay", "held"), r("depop", "held"), r("poshmark", "error")], { kind: "approve" });
  assert.deepStrictEqual(out.publishResults.map((x) => [x.platform, x.status]), [["poshmark", "error"]]);
  assert.deepStrictEqual(out.changes.map((c) => [c.market, c.from, c.to]), [["ebay", "held", "none"], ["depop", "held", "none"]]);
  // approve with nothing held: no change
  assert.deepStrictEqual(applyMark([r("ebay", "published")], { kind: "approve" }).changes, []);
  // Invalid: published -> anything; held -> not_posted (approve first)
  assert.throws(() => applyMark([r("depop", "published", { url })], { kind: "posted", market: "depop", url }), isCode("invalid_transition", 1));
  assert.throws(() => applyMark([r("depop", "published", { url })], { kind: "not_posted", market: "depop" }), isCode("invalid_transition", 1));
  assert.throws(() => applyMark([r("depop", "held")], { kind: "not_posted", market: "depop" }), isCode("invalid_transition", 1));
}

// --- Usage errors (S4): missing dir, empty dir, a dir with no item subfolders ---
await assert.rejects(runBatch({ dir: join(root, "nope") }, fakes().deps), isCode("usage", 2));
await assert.rejects(runBatch({ dir: makeBatch({}) }, fakes().deps), isCode("usage", 2));
{
  const flat = makeBatch({});
  writeFileSync(join(flat, "loose.jpg"), "x");
  await assert.rejects(runBatch({ dir: flat }, fakes().deps), isCode("usage", 2), "a flat pile is not grouped in this cut");
  await assert.rejects(runBatch({ dir: makeBatch({ a: { "1.jpg": "x" } }), markets: ["poshmark"] }, fakes().deps), isCode("usage", 2));
}

// --- E2E: night eBay phase, then the Depop phase, on one folder (O1, C7, O2, E8, E10) ---
{
  const dir = makeBatch({ coat: { "1.jpg": "front", "2.jpg": "back" } });
  const item = join(dir, "coat");
  const draft = join(item, "draft.json");
  mkdirSync(join(item, ".resell"));
  writeFileSync(join(item, ".resell", "error-old.png"), "a screenshot from an earlier session");
  const f = fakes();

  const night = await runBatch({ dir, ebay: ebayFlags }, f.deps);
  assert.deepStrictEqual(night.markets, ["ebay"]);
  assert.deepStrictEqual(f.drafted.map((d) => d.platforms), [[...BATCH_MARKETS]], "intake drafts every enabled market (C7)");
  assert.strictEqual(f.drafted[0].photos.length, 2, "intake reads top-level photos only (E10)");
  assert.deepStrictEqual(f.ebay.map((e) => e.photos.length), [2], "the screenshot is not uploaded (E10)");
  const file = readDraftFile(draft);
  assert.strictEqual(file.draftId, photoSetId(itemPhotos(item)), "SKU id from the photo hash (E8)");
  assert.strictEqual(f.ebay[0].sku, draftSku(file));
  assert.ok(file.listings.some((l) => l.platform === "depop"), "phase 2 will find a Depop listing");
  assert.strictEqual(status(draft, "ebay"), "published");
  assert.strictEqual(status(draft, "depop"), "none");
  assert.strictEqual(night.complete, true, "the requested market (eBay) is published");
  assert.strictEqual(f.fills.length, 0, "the night phase never touches Depop");
  assert.ok(existsSync(join(dir, "batch.json")));
  const index = JSON.parse(readFileSync(join(dir, "batch.json"), "utf8"));
  assert.deepStrictEqual(index.items.map((i: any) => [i.item, i.intake, i.markets.map((m: any) => [m.market, m.status])]), [
    ["coat", "drafted", [["ebay", "published"], ["depop", "none"]]],
  ]);
  assert.deepStrictEqual(
    logLines(item).map((l) => [l.by, l.market, l.from, l.to]),
    [["intake", null, null, "drafted"], ["post-batch", "ebay", "none", "published"]]
  );

  // Phase 2: the interactive Depop session. A mark made while a tab waits is not blocked (E7).
  let markedDuringWait = false;
  const session = await f.deps.openBrowserSession!();
  const depop = await runBatch(
    { dir, markets: ["depop"] },
    {
      ...f.deps,
      openBrowserSession: async () => ({
        async fill(platform, l, photos) {
          assert.strictEqual(status(draft, "depop"), "filling", "filling is on disk before the wait");
          await markDraft(draft, { kind: "approve" }, { waitMs: 0 });
          markedDuringWait = true;
          return session.fill(platform, l, photos);
        },
        close: session.close,
      }),
    }
  );
  assert.ok(markedDuringWait);
  assert.strictEqual(f.drafted.length, 1, "intake resumed the existing draft (O2)");
  assert.strictEqual(f.ebay.length, 1, "the Depop phase does not publish eBay");
  assert.deepStrictEqual(f.fills.map((x) => [x.platform, x.photos.length, x.title]), [["depop", 2, "depop title"]]);
  assert.strictEqual(f.closed(), 1, "the session is closed when the phase ends");
  assert.strictEqual(depop.complete, true);
  assert.deepStrictEqual(readDraftFile(draft).publishResults.map((r) => r.status), ["published", "published"]);
  assert.strictEqual(readDraftFile(draft).draftId, file.draftId, "SKU survives the resume");
  assert.deepStrictEqual(logLines(item).at(-1)?.to, "published");
  assert.match(logLines(item).at(-1)?.url ?? "", /depop\.com/);

  // A third run has nothing left to do.
  const again = await runBatch({ dir, markets: ["ebay", "depop"] }, f.deps);
  assert.strictEqual(again.complete, true);
  assert.strictEqual(f.ebay.length + f.fills.length, 2, "nothing is re-published");
  assert.ok(again.items[0].results.every((r) => r.status === "skipped"));
}

// --- Error rows: no photos, an unparseable draft.json (never overwritten); the batch continues ---
{
  const dir = makeBatch({ empty: { "notes.txt": "no photos here" }, bad: { "1.jpg": "x", "draft.json": "{ not json" }, good: { "1.jpg": "y" } });
  const f = fakes();
  const out = await runBatch({ dir, ebay: ebayFlags }, f.deps);
  const row = (name: string) => out.items.find((i) => i.item === name)!;
  assert.strictEqual(row("empty").intake, "error");
  assert.match(row("empty").error!, /no photos/i);
  assert.strictEqual(row("bad").intake, "error");
  assert.match(row("bad").error!, /never overwritten/i);
  assert.strictEqual(readFileSync(join(dir, "bad", "draft.json"), "utf8"), "{ not json", "unparseable draft.json is left as is");
  assert.strictEqual(row("good").intake, "created");
  assert.strictEqual(status(join(dir, "good", "draft.json"), "ebay"), "published", "the batch continues past error rows");
  assert.strictEqual(out.complete, false, "error rows make the batch incomplete");
  assert.strictEqual(f.drafted.length, 1, "only the good folder is drafted");
  const idx = buildBatchIndex(dir);
  assert.deepStrictEqual(idx.items.map((i) => [i.item, i.intake]), [["bad", "error"], ["empty", "error"], ["good", "drafted"]]);
}

// --- Two folders with byte-identical photos share a SKU: the first proceeds, every later one is an error row ---
{
  const dir = makeBatch({ coat: { "1.jpg": "front", "2.jpg": "back" }, "coat copy": { "1.jpg": "front", "2.jpg": "back" }, hat: { "1.jpg": "hat" } });
  const f = fakes();
  const out = await runBatch({ dir, ebay: ebayFlags }, f.deps);
  const row = (name: string) => out.items.find((i) => i.item === name)!;
  assert.strictEqual(row("coat").intake, "created");
  assert.strictEqual(row("coat copy").intake, "error");
  assert.strictEqual(row("coat copy").error, "same photos as coat; reshoot one photo or delete the copy");
  assert.strictEqual(f.ebay.length, 2, "one publish for the coat (and one for the hat), none for the copy");
  assert.strictEqual(f.drafted.length, 2, "the copy is never drafted");
  assert.ok(!existsSync(join(dir, "coat copy", "draft.json")));
  assert.strictEqual(out.complete, false, "the copy's error row makes the batch incomplete");
  const idx = buildBatchIndex(dir);
  assert.deepStrictEqual(idx.items.map((i) => [i.item, i.intake, i.error]), [
    ["coat", "drafted", null],
    ["coat copy", "error", "same photos as coat; reshoot one photo or delete the copy"],
    ["hat", "drafted", null],
  ]);
  // A copy that already has its own draft.json (from before this rule) is an error row too, and is never published.
  writeFileSync(join(dir, "coat copy", "draft.json"), readFileSync(join(dir, "coat", "draft.json")));
  const again = await runBatch({ dir, ebay: ebayFlags }, f.deps);
  assert.strictEqual(again.items.find((i) => i.item === "coat copy")!.intake, "error");
  assert.strictEqual(f.ebay.length, 2, "nothing re-published");
}

// --- Held (O5): no market publishes until `mark --approve`; then the next night publishes it ---
{
  const dir = makeBatch({ bag: { "1.jpg": "logo-less bag" } });
  const draft = join(dir, "bag", "draft.json");
  const f = fakes({ brandInferred: true });
  const out = await runBatch({ dir, ebay: ebayFlags }, f.deps);
  assert.strictEqual(out.complete, false, "held = incomplete");
  assert.deepStrictEqual(f.ebay, [], "a held draft never reaches eBay");
  assert.deepStrictEqual(readDraftFile(draft).publishResults.map((r) => [r.platform, r.status]), [["ebay", "held"], ["depop", "held"]]);
  const idx = buildBatchIndex(dir);
  assert.deepStrictEqual(idx.items[0].markets.map((m) => m.flags), [["held"], ["held", "unmapped"]], "held and unmapped rows are flagged");
  // The Depop phase skips a held draft too.
  await runBatch({ dir, markets: ["depop"] }, f.deps);
  assert.strictEqual(f.fills.length, 0);

  const approved = await markDraft(draft, { kind: "approve" });
  assert.deepStrictEqual(approved.changes.map((c) => [c.market, c.from, c.to]), [["ebay", "held", "none"], ["depop", "held", "none"]]);
  const next = await runBatch({ dir, ebay: ebayFlags }, f.deps);
  assert.strictEqual(next.complete, true);
  assert.strictEqual(f.ebay.length, 1);
}

// --- Interrupted runs recovered ---
{
  // (1) eBay dies mid-request: `unknown`; the next run retries under the same SKU and publishes.
  const dir = makeBatch({ boots: { "1.jpg": "boots" } });
  const item = join(dir, "boots");
  const draft = join(item, "draft.json");
  const broken = fakes({ ebayThrows: "socket hang up" });
  const first = await runBatch({ dir, ebay: ebayFlags }, broken.deps);
  assert.strictEqual(first.complete, false);
  assert.strictEqual(status(draft, "ebay"), "unknown");
  const ok = fakes();
  const second = await runBatch({ dir, ebay: ebayFlags }, ok.deps);
  assert.strictEqual(second.complete, true);
  assert.strictEqual(ok.drafted.length, 0, "the draft is resumed, not rebuilt");
  assert.strictEqual(ok.ebay[0].sku, broken.ebay[0].sku, "the retry uses the same SKU, so eBay finds the first attempt");

  // (2) The Depop runner is killed mid-wait: `filling` on disk and its lock left behind by a dead pid.
  await beginFill(draft, "depop");
  const dead = 2_147_483_644; // no real pid: an exited child's pid can be reused on Windows while Chrome tests run alongside
  writeFileSync(`${draft}.lock`, JSON.stringify({ pid: dead, time: Date.now() }));
  const resumed = await runBatch({ dir, markets: ["depop"] }, ok.deps);
  assert.strictEqual(ok.fills.length, 0, "a stale filling is never re-filled (it reads as unknown)");
  assert.strictEqual(resumed.complete, false);
  assert.ok(!existsSync(`${draft}.lock`), "the dead runner's lock was broken");
  assert.deepStrictEqual(buildBatchIndex(dir).items[0].markets.find((m) => m.market === "depop")?.flags, ["unknown", "unmapped"]);
  // Sam checks Depop: not posted. The next session fills it again.
  await markDraft(draft, { kind: "not_posted", market: "depop" });
  const refilled = await runBatch({ dir, markets: ["depop"] }, ok.deps);
  assert.strictEqual(ok.fills.length, 1);
  assert.strictEqual(refilled.complete, true);

  // (3) draft.json deleted and re-created: same photos, same SKU, so eBay finds the live listing (E8).
  rmSync(draft);
  const rebuilt = fakes();
  await runBatch({ dir, ebay: ebayFlags }, rebuilt.deps);
  assert.strictEqual(rebuilt.drafted.length, 1);
  assert.strictEqual(rebuilt.ebay[0].sku, broken.ebay[0].sku);
}
{
  // (4) The SKU is stored at intake: a changed GUI_DEFAULT_SKU before an `unknown` retry still publishes under the first SKU.
  const saved = process.env.GUI_DEFAULT_SKU;
  try {
    const dir = makeBatch({ scarf: { "1.jpg": "scarf" } });
    const draft = join(dir, "scarf", "draft.json");
    process.env.GUI_DEFAULT_SKU = "NIGHT";
    const broken = fakes({ ebayThrows: "socket hang up" });
    await runBatch({ dir, ebay: ebayFlags }, broken.deps);
    assert.strictEqual(status(draft, "ebay"), "unknown");
    assert.match(broken.ebay[0].sku, /^NIGHT-/);
    process.env.GUI_DEFAULT_SKU = "DAY";
    const ok = fakes();
    await runBatch({ dir, ebay: ebayFlags }, ok.deps);
    assert.strictEqual(ok.ebay[0].sku, broken.ebay[0].sku, "the retry publishes under the stored SKU, not a new prefix");
    assert.strictEqual(draftSku(readDraftFile(draft)), broken.ebay[0].sku, "status reports the stored SKU");
  } finally {
    if (saved === undefined) delete process.env.GUI_DEFAULT_SKU;
    else process.env.GUI_DEFAULT_SKU = saved;
  }
}

// --- The batch folder moved between runs: photos are re-read from the draft's own folder at publish (E10) ---
{
  const dir = makeBatch({ coat: { "1.jpg": "front", "2.jpg": "back" } });
  const broken = fakes({ ebayThrows: "eBay is down" });
  await runBatch({ dir, ebay: ebayFlags }, broken.deps);
  const moved = `${dir}-moved`;
  renameSync(dir, moved);
  const ok = fakes();
  const out = await runBatch({ dir: moved, markets: ["ebay", "depop"], ebay: ebayFlags }, ok.deps);
  assert.strictEqual(out.complete, true);
  assert.strictEqual(ok.drafted.length, 0, "resumed, not re-drafted");
  const uploaded = [...ok.ebay[0].photos, ...ok.fills[0].photos];
  assert.strictEqual(uploaded.length, 4);
  assert.ok(uploaded.every((p) => p.startsWith(join(moved, "coat")) && existsSync(p)), "eBay and Depop get the photos where they are now");
  assert.ok(readDraftFile(join(moved, "coat", "draft.json")).photos.every((p) => existsSync(p)), "draft.json follows the move");
}

// --- A draft locked by another writer is an item error for this run; the batch continues ---
{
  const dir = makeBatch({ a: { "1.jpg": "a" }, b: { "1.jpg": "b" } });
  const f = fakes();
  await runBatch({ dir, markets: ["ebay"], ebay: ebayFlags }, { ...f.deps, publish: { publishEbay: async () => { throw new Error("eBay is down"); } } });
  const a = join(dir, "a", "draft.json");
  const out = await withDraftLock(a, () => runBatch({ dir, ebay: ebayFlags }, f.deps));
  assert.match(out.items[0].error ?? "", /already being published/);
  assert.strictEqual(status(join(dir, "b", "draft.json"), "ebay"), "published");
  assert.strictEqual(out.complete, false);
}

// --- Depop phase with no session available: a clear usage-style error, nothing touched ---
{
  const dir = makeBatch({ a: { "1.jpg": "a" } });
  const { openBrowserSession: _none, ...noSession } = fakes().deps;
  await assert.rejects(runBatch({ dir, markets: ["depop"] }, noSession), isCode("depop_unavailable", 2));
  assert.ok(!existsSync(join(dir, "a", "draft.json")), "fails before intake");
}

// --- CLI (spawned; no network: every case fails or finishes before a model or eBay call) ---
{
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const cwd = mkdtempSync(join(tmpdir(), "resell-batch-cli-"));
  const run = (...args: string[]) => {
    // Never a real Chrome or the real Depop profile from a test: a missing CHROME_PATH and a temp profile root.
    const env = { ...process.env, CHROME_PATH: join(cwd, "no-chrome.exe"), BROWSER_AUTOMATION_PROFILE_DIR: join(cwd, "profiles") };
    const r = spawnSync(process.execPath, [cli, ...args, "--json"], { cwd, encoding: "utf8", env });
    return { code: r.status, env: JSON.parse(r.stdout) };
  };

  const help = run("help");
  assert.strictEqual(help.code, 0);
  const names = help.env.data.commands.map((c: { name: string }) => c.name);
  for (const n of ["post-batch", "mark"]) assert.ok(names.includes(n), `help lists ${n}`);
  assert.ok(help.env.data.commands.find((c: any) => c.name === "status").flags["--batch"], "help lists status --batch");

  const empty = run("post-batch", makeBatch({}));
  assert.strictEqual(empty.code, 2);
  assert.strictEqual(empty.env.error.code, "usage");
  assert.strictEqual(run("post-batch").code, 2, "the dir is required");

  // A held draft: post-batch resumes it, skips eBay without a call, and exits 3.
  const dir = makeBatch({ bag: { "1.jpg": "bag" } });
  const draft = join(dir, "bag", "draft.json");
  const held = { ...bundle(["ebay", "depop"], { brandInferred: true }), draftId: "d1", photos: [join(dir, "bag", "1.jpg")], publishResults: [] as PlatformPublishResult[] };
  held.publishResults = [{ platform: "ebay", status: "held", message: "held" }, { platform: "depop", status: "held", message: "held" }];
  writeDraftFile(draft, held);
  const night = run("post-batch", dir);
  assert.strictEqual(night.code, 3);
  assert.strictEqual(night.env.error.code, "publish_incomplete");
  assert.strictEqual(night.env.data.items[0].results[0].status, "skipped");

  // A held draft never starts Chrome: nothing to fill, so CHROME_PATH is never looked at.
  const depop = run("post-batch", dir, "--markets", "depop");
  assert.strictEqual(depop.code, 3);
  assert.strictEqual(depop.env.error.code, "publish_incomplete");
  assert.strictEqual(depop.env.data.halted, null);
  assert.strictEqual(run("post-batch", dir, "--markets", "depop", "--tabs", "0").code, 2, "--tabs 0 is a usage error");

  // F5: a fillable item with no Chrome halts Depop up front with the fix, and nothing is written.
  const shoes = makeBatch({ shoes: { "1.jpg": "shoes" } });
  const shoesDraft = join(shoes, "shoes", "draft.json");
  writeDraftFile(shoesDraft, { ...bundle(["ebay", "depop"]), draftId: "d2", photos: [join(shoes, "shoes", "1.jpg")], publishResults: [] });
  const noChrome = run("post-batch", shoes, "--markets", "depop");
  assert.strictEqual(noChrome.code, 3);
  assert.match(noChrome.env.data.halted, /CHROME_PATH/);
  assert.deepStrictEqual(readDraftFile(shoesDraft).publishResults, [], "no `filling` before Chrome is found");
  const post = run("post", "--draft", shoesDraft, "--platforms", "depop");
  assert.strictEqual(post.code, 3);
  assert.match(post.env.data.results[0].message, /Depop session didn't start: CHROME_PATH/);

  const st = run("status", "--batch", dir);
  assert.strictEqual(st.code, 0);
  assert.deepStrictEqual(st.env.data.items[0].markets.map((m: any) => [m.market, m.status, m.flags]), [["ebay", "held", ["held"]], ["depop", "held", ["held", "unmapped"]]]);

  // mark transitions through the CLI, each written to the draft and the run log.
  const approve = run("mark", "--draft", draft, "--approve");
  assert.strictEqual(approve.code, 0);
  assert.deepStrictEqual(readDraftFile(draft).publishResults, []);
  const url = "https://www.depop.com/products/bag";
  assert.strictEqual(run("mark", "--draft", draft, "--market", "depop", "--not-posted").code, 0);
  assert.strictEqual(status(draft, "depop"), "not_posted");
  const posted = run("mark", "--draft", draft, "--market", "depop", "--posted", url);
  assert.strictEqual(posted.code, 0);
  assert.deepStrictEqual([status(draft, "depop"), readDraftFile(draft).publishResults[0].url], ["published", url]);
  const again = run("mark", "--draft", draft, "--market", "depop", "--not-posted");
  assert.strictEqual(again.code, 1);
  assert.strictEqual(again.env.error.code, "invalid_transition");
  assert.deepStrictEqual(logLines(join(dir, "bag")).filter((l) => l.by === "mark").map((l) => [l.market, l.from, l.to]), [
    ["ebay", "held", "none"], ["depop", "held", "none"], ["depop", "none", "not_posted"], ["depop", "not_posted", "published"],
  ]);
  const idx = JSON.parse(readFileSync(join(dir, "batch.json"), "utf8"));
  assert.strictEqual(idx.items[0].markets.find((m: any) => m.market === "depop").status, "published", "mark refreshes batch.json");

  for (const bad of [
    ["mark", "--draft", draft],
    ["mark", "--draft", draft, "--posted", url],
    ["mark", "--draft", draft, "--market", "ebay", "--not-posted"],
    ["mark", "--draft", draft, "--market", "depop", "--posted", "not-a-url"],
    ["mark", "--draft", draft, "--market", "depop", "--posted", "https://evil.example/products/bag"], // off the market's host, as the GUI refuses
    ["mark", "--draft", draft, "--market", "depop", "--posted", "http://www.depop.com/products/bag"],
    ["mark", "--draft", draft, "--approve", "--not-posted", "--market", "depop"],
  ]) {
    const r = run(...bad);
    assert.strictEqual(r.code, 2, `${bad.slice(3).join(" ")} is a usage error`);
    assert.strictEqual(r.env.error.code, "usage");
  }
}

console.log("batch ok");
