// The Depop phase of post-batch: the rolling window of tabs (E4), the pre-fill eBay stock check (O4),
// the per-item context handed to the session (D4, E10, E12), halts (S2) and a session that won't open.
// All fakes: no browser, no network. Run: npm test
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBatch, runLogPath, type BatchBrowserSession, type BatchDeps, type RunLogLine } from "./batch.js";
import { CliError, readDraftFile, writeDraftFile, type DraftFile } from "./draft-file.js";
import type { DepopItemContext, StockState } from "./depop-fill.js";
import type { BrowserFillOutcome, PlatformPublishResult } from "./publish.js";
import type { DraftBundle, Platform } from "./types.js";

process.env.EBAY_ENV = "production";
const root = mkdtempSync(join(tmpdir(), "resell-batch-depop-"));
let seq = 0;

function bundle(): DraftBundle {
  return {
    attributes: {
      brand: "Patagonia", brandInferred: false, productName: null, category: "Fleece", titleKeywords: [],
      size: "M", color: "green", material: "fleece", condition: "good", flaws: [], dimensions: null, originalRetail: 139,
    },
    price: { suggested: 68, low: 55, high: 82, currency: "USD", basis: "test", sampleSize: 5 },
    comps: [], comparison: [], retail: [],
    listings: (["ebay", "depop"] as Platform[]).map((platform) => ({ platform, title: `${platform} title`, description: "d", price: 68, condition: "good" as const })),
  };
}

/** A batch of already-drafted items (no model call), each with optional stored results. */
function makeBatch(items: Record<string, PlatformPublishResult[]>): string {
  const dir = join(root, `b${++seq}`);
  for (const [name, results] of Object.entries(items)) {
    const item = join(dir, name);
    mkdirSync(item, { recursive: true });
    writeFileSync(join(item, "1.jpg"), `${name} photo`);
    const file: DraftFile = { ...bundle(), draftId: `id-${name}`, photos: [join(item, "1.jpg")], publishResults: results };
    writeDraftFile(join(item, "draft.json"), file);
  }
  return dir;
}

const ebayLive: PlatformPublishResult = { platform: "ebay", status: "published", message: "live", offerId: "offer-1", listingId: "l1", env: "production" };
const depopOf = (dir: string, item: string) => readDraftFile(join(dir, item, "draft.json")).publishResults.find((r) => r.platform === "depop");
const logLines = (itemDir: string): RunLogLine[] =>
  existsSync(runLogPath(itemDir)) ? readFileSync(runLogPath(itemDir), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

/** A session whose tabs stay open until the test resolves them, like Sam taking his time. */
function heldSession(opts: { halt?: { after: number; reason: string } } = {}) {
  const open: { item: string; ctx: DepopItemContext; done: (o: BrowserFillOutcome) => void }[] = [];
  const started: string[] = [];
  let concurrent = 0;
  let peak = 0;
  let opens = 0;
  let closed = 0;
  let halted: string | null = null;
  const session: BatchBrowserSession = {
    fill: async () => {
      throw new Error("the batch must bind each fill to its item (forItem)");
    },
    forItem: (ctx) => ({
      fill: (_platform, _listing) =>
        new Promise<BrowserFillOutcome>((resolve) => {
          started.push(ctx.label);
          peak = Math.max(peak, ++concurrent);
          open.push({
            item: ctx.label,
            ctx,
            done: (o) => {
              concurrent--;
              if (opts.halt && started.length >= opts.halt.after) halted = opts.halt.reason;
              resolve(o);
            },
          });
        }),
    }),
    haltReason: () => halted,
    close: async () => void closed++,
  };
  const factory = async () => {
    opens++;
    return session;
  };
  return { factory, open, started, peak: () => peak, opens: () => opens, closed: () => closed };
}

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 2_000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); // generous: npm test runs files in parallel
  assert.ok(cond(), `timed out waiting for: ${what}`);
};
const posted = (n: number): BrowserFillOutcome => ({ status: "published", message: "posted", url: `https://www.depop.com/products/p${n}/` });

// --- E4: a rolling window of 3 tabs; the 4th item fills only when Sam posts or closes one ---
{
  const dir = makeBatch({ a: [], b: [], c: [], d: [], e: [] });
  const s = heldSession();
  const deps: BatchDeps = { openBrowserSession: s.factory, ebayStock: async () => null };
  const run = runBatch({ dir, markets: ["depop"] }, deps);
  await until(() => s.started.length === 3, "three tabs filled");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(s.started, ["a", "b", "c"], "three tabs at once, in name order");
  assert.strictEqual(depopOf(dir, "d"), undefined, "the 4th item waits for a free slot");
  s.open.shift()!.done(posted(1)); // Sam posts a
  await until(() => s.started.length === 4, "d fills after a slot frees");
  assert.deepStrictEqual(s.started, ["a", "b", "c", "d"]);
  s.open.shift()!.done({ status: "not_posted", message: "tab closed" }); // closes b
  await until(() => s.started.length === 5, "e fills");
  while (s.open.length) s.open.shift()!.done(posted(9));
  const out = await run;
  assert.strictEqual(s.peak(), 3, "never more than 3 tabs");
  assert.strictEqual(s.opens(), 1, "one session for the whole phase");
  assert.strictEqual(s.closed(), 1, "closed at the end");
  assert.strictEqual(depopOf(dir, "a")?.status, "published");
  assert.strictEqual(depopOf(dir, "b")?.status, "not_posted");
  assert.strictEqual(out.complete, false, "b is not posted");
  // D4/E10: each fill knows its item's .resell folder (screenshots) and name (banner).
  assert.deepStrictEqual(s.open.length, 0);
}
{
  // --tabs 1: one at a time.
  const dir = makeBatch({ a: [], b: [] });
  const s = heldSession();
  const run = runBatch({ dir, markets: ["depop"], tabs: 1 }, { openBrowserSession: s.factory, ebayStock: async () => null });
  await until(() => s.started.length === 1, "first tab");
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(s.started.length, 1);
  s.open.shift()!.done(posted(1));
  await until(() => s.started.length === 2, "second tab");
  s.open.shift()!.done(posted(2));
  assert.strictEqual((await run).complete, true);
  assert.strictEqual(s.peak(), 1);
}
await assert.rejects(runBatch({ dir: makeBatch({ a: [] }), markets: ["depop"], tabs: 0 }, { openBrowserSession: heldSession().factory }), (e: unknown) => e instanceof CliError && e.code === "usage" && e.exitCode === 2);

// --- O4: the eBay listing is checked before each fill; sold or ended is skipped "sold on eBay" ---
{
  const dir = makeBatch({ sold: [ebayLive], ended: [ebayLive], live: [ebayLive], flaky: [ebayLive], nobay: [] });
  const s = heldSession();
  const asked: string[] = [];
  const stock: Record<string, StockState | Error> = { sold: "sold", ended: "ended", live: "active", flaky: new Error("eBay 503") };
  const deps: BatchDeps = {
    openBrowserSession: s.factory,
    ebayStock: async (file) => {
      const name = file.draftId.slice(3);
      if (!file.publishResults.some((r) => r.platform === "ebay" && r.status === "published")) return null;
      asked.push(name);
      const v = stock[name];
      if (v instanceof Error) throw v;
      return v;
    },
  };
  const run = runBatch({ dir, markets: ["depop"] }, deps);
  await until(() => s.started.length === 3, "live, flaky and nobay fill");
  const ctx = (item: string) => s.open.find((o) => o.item === item)!.ctx;
  assert.deepStrictEqual(s.started.sort(), ["flaky", "live", "nobay"], "sold and ended items are never filled");
  assert.strictEqual(ctx("flaky").stockUnconfirmed, true, "a failed pre-fill check shows the warning banner");
  assert.strictEqual(ctx("live").stockUnconfirmed, undefined);
  assert.strictEqual(typeof ctx("live").stock, "function", "a live eBay listing is re-checked while the tab waits (E12)");
  assert.strictEqual(ctx("nobay").stock, undefined, "nothing to re-check without an eBay listing");
  assert.strictEqual(ctx("live").logDir, join(dir, "live", ".resell"), "screenshots go to <item>/.resell (E10)");
  // The E12 re-check asks eBay again for the same item.
  assert.strictEqual(await ctx("live").stock!(), "active");
  assert.ok(asked.filter((n) => n === "live").length >= 2);
  while (s.open.length) s.open.shift()!.done(posted(1));
  const out = await run;
  const res = (item: string) => out.items.find((i) => i.item === item)!.results.find((r) => r.platform === "depop")!;
  assert.strictEqual(res("sold").status, "skipped");
  assert.match(res("sold").message, /sold on eBay/);
  assert.match(res("ended").message, /sold on eBay/);
  assert.strictEqual(depopOf(dir, "sold"), undefined, "nothing written for a sold item");
  assert.deepStrictEqual(logLines(join(dir, "sold")).map((l) => [l.by, l.market, l.to]), [["post-batch", "depop", "skipped"]], "the skip and its reason are logged (D4)");
  assert.strictEqual(depopOf(dir, "live")?.status, "published");
}

// --- Halt rules (S2): once the session halts, no further tab is filled and nothing retries ---
{
  const dir = makeBatch({ a: [], b: [], c: [], d: [] });
  const s = heldSession({ halt: { after: 1, reason: "an account restriction banner" } });
  const run = runBatch({ dir, markets: ["depop"], tabs: 1 }, { openBrowserSession: s.factory, ebayStock: async () => null });
  await until(() => s.started.length === 1, "first tab");
  s.open.shift()!.done({ status: "error", message: "Depop halted: an account restriction banner." });
  const out = await run;
  assert.deepStrictEqual(s.started, ["a"], "no tab after the halt");
  assert.strictEqual(out.halted, "an account restriction banner");
  for (const item of ["b", "c", "d"]) {
    const r = out.items.find((i) => i.item === item)!.results.find((x) => x.platform === "depop")!;
    assert.strictEqual(r.status, "skipped");
    assert.match(r.message, /Depop halted: an account restriction banner/);
    assert.strictEqual(depopOf(dir, item), undefined, "a halted market writes nothing for the rest");
  }
  assert.strictEqual(depopOf(dir, "a")?.status, "error");
  assert.strictEqual(out.complete, false);
}

// --- A session that won't open (Chrome missing, preflight miss, profile busy) halts before any write ---
{
  const dir = makeBatch({ a: [], b: [] });
  const out = await runBatch(
    { dir, markets: ["depop"] },
    {
      openBrowserSession: async () => {
        throw new CliError("chrome_missing", "Google Chrome wasn't found on this computer.", "Install Google Chrome, or set CHROME_PATH to the chrome executable.");
      },
      ebayStock: async () => null,
    }
  );
  assert.match(out.halted ?? "", /Chrome wasn't found.*CHROME_PATH/);
  assert.deepStrictEqual([depopOf(dir, "a"), depopOf(dir, "b")], [undefined, undefined], "no `filling` written");
  assert.ok(out.items.every((i) => i.results.some((r) => r.status === "skipped" && /CHROME_PATH/.test(r.message))));
  assert.ok(existsSync(join(dir, "batch.json")));
  assert.strictEqual(out.complete, false);
}

// --- Nothing to fill: no Chrome is started ---
{
  const url = "https://www.depop.com/products/x/";
  const dir = makeBatch({
    done: [{ platform: "depop", status: "published", message: "p", url }],
    held: [{ platform: "ebay", status: "held", message: "h" }, { platform: "depop", status: "held", message: "h" }],
    verify: [{ platform: "depop", status: "unknown", message: "u" }],
  });
  const s = heldSession();
  const out = await runBatch({ dir, markets: ["depop"] }, { openBrowserSession: s.factory, ebayStock: async () => "active" });
  assert.strictEqual(s.opens(), 0, "no session when no item is eligible");
  assert.ok(out.items.every((i) => i.results.every((r) => r.status === "skipped")));
}

console.log("batch-depop ok");
