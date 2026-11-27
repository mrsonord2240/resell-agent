// Depop assisted fill, pure parts: the tab state table, window-close detection, the eBay stock
// re-check timing and banner, and the URL rules. No browser, no network.
// Run: npm test
import assert from "node:assert";
import {
  BASE_FIELDS,
  CAPTURE_MS,
  DEPOP,
  PREFLIGHT_CONTROLS,
  STOCK_RECHECK_MS,
  STOCK_REFOCUS_MS,
  StockWatcher,
  TabWatch,
  depopSite,
  isCreateRequest,
  isLoginUrl,
  isSellForm,
  isWindowClose,
  listingUrlFromCreateBody,
  listingUrlOf,
  type StockBanner,
  type StockState,
} from "./depop-fill.js";

const MIN = 60_000;
/** The tab's resolved status, "halt", or null while it still waits. */
const st = (w: TabWatch): string | null => (w.outcome ? ("halt" in w.outcome ? "halt" : w.outcome.status) : null);
const msg = (w: TabWatch): string => (w.outcome && "message" in w.outcome ? w.outcome.message : "");

// --- Tab state table (spec "Wait lifecycle and recorded states", S4) ---
{
  // Submit seen and URL captured -> published with the URL.
  const t = new TabWatch();
  t.handle({ kind: "create" }, 0);
  assert.strictEqual(st(t), null, "a create request alone waits for the URL");
  t.handle({ kind: "listing", url: "https://www.depop.com/products/sam-fleece/" }, 1_000);
  assert.deepStrictEqual([st(t), t.url], ["published", "https://www.depop.com/products/sam-fleece/"]);
}
{
  // Tab closed with no submit -> not_posted.
  const t = new TabWatch();
  t.handle({ kind: "tick" }, 30 * MIN);
  t.handle({ kind: "closed" }, 30 * MIN);
  assert.strictEqual(st(t), "not_posted");
}
{
  // Submit seen, tab closed before the URL -> unknown.
  const t = new TabWatch();
  t.handle({ kind: "create" }, 0);
  t.handle({ kind: "closed" }, 500);
  assert.strictEqual(st(t), "unknown");
}
{
  // Submit seen, URL never captured -> unknown at the capture deadline, not before.
  const t = new TabWatch();
  t.handle({ kind: "create" }, 0);
  t.handle({ kind: "tick" }, CAPTURE_MS - 1);
  assert.strictEqual(st(t), null);
  t.handle({ kind: "tick" }, CAPTURE_MS);
  assert.ok(st(t) === "unknown");
  assert.match(msg(t), /no listing URL was captured/);
}
{
  // Window closed or Chrome gone, no submit -> unknown (every filled, unresolved tab, S4).
  const t = new TabWatch();
  t.handle({ kind: "window-closed" }, 0);
  assert.strictEqual(st(t), "unknown");
}
{
  // Navigation off the sell form counts as a submit; the URL is still awaited.
  const t = new TabWatch();
  t.handle({ kind: "left", url: "https://www.depop.com/sellinghub/" }, 0);
  assert.ok(t.submitSeen);
  t.handle({ kind: "closed" }, 10);
  assert.strictEqual(st(t), "unknown");
}
{
  // Redirect to sign-in before any submit -> halt "sign in again"; after a submit it is just verify-first.
  const t = new TabWatch();
  t.handle({ kind: "login", url: "https://www.depop.com/login/" }, 0);
  assert.strictEqual(st(t), "halt");
  assert.match((t.outcome as { halt: string }).halt, /sign in again/i);
  const u = new TabWatch();
  u.handle({ kind: "create" }, 0);
  u.handle({ kind: "login", url: "https://www.depop.com/login/" }, 1);
  assert.strictEqual(st(u), null);
  u.handle({ kind: "closed" }, 2);
  assert.strictEqual(st(u), "unknown");
}
{
  // Double-click on Post: the first create wins, the second is a warning in the result (S4).
  const t = new TabWatch();
  t.handle({ kind: "create" }, 0);
  t.handle({ kind: "create" }, 200);
  t.handle({ kind: "listing", url: "https://www.depop.com/products/x/" }, 400);
  assert.strictEqual(t.submitAt, 0);
  assert.match(msg(t), /second listing-create request/);
  // The second create arriving after the first one's URL resolved the tab still warns.
  const late = new TabWatch();
  late.handle({ kind: "create" }, 0);
  late.handle({ kind: "listing", url: "https://www.depop.com/products/x/" }, 100);
  late.handle({ kind: "create" }, 150);
  assert.strictEqual(st(late), "published");
  assert.match(msg(late), /second listing-create request/);
  // A lost tab (runner glue failure) is verify-first, never not_posted: it may still be postable.
  const lost = new TabWatch();
  lost.handle({ kind: "lost", why: "target crashed" }, 0);
  assert.strictEqual(st(lost), "unknown");
  // Once resolved, later events change nothing.
  lost.handle({ kind: "listing", url: "https://www.depop.com/products/y/" }, 1);
  assert.strictEqual(st(lost), "unknown");
}

// --- C1: a Post click is a possible submit even when no create request is recognised ---
{
  // Sam clicks Post; the create call doesn't match DEPOP.createRequest and the tab stays on the form.
  const t = new TabWatch();
  t.handle({ kind: "post-clicked" }, 0);
  t.handle({ kind: "tick" }, CAPTURE_MS * 5);
  assert.strictEqual(st(t), null, "a click alone does not start the URL deadline: Sam may be fixing a field");
  t.handle({ kind: "closed" }, CAPTURE_MS * 5);
  assert.strictEqual(st(t), "unknown", "closed after a Post click is verify-first, never not_posted");
  assert.match(msg(t), /Post was clicked/);
  // A click, then the recognised create and the URL: published, and no false double-click warning.
  const u = new TabWatch();
  u.handle({ kind: "post-clicked" }, 0);
  u.handle({ kind: "create" }, 10);
  u.handle({ kind: "listing", url: "https://www.depop.com/products/x/" }, 20);
  assert.strictEqual(st(u), "published");
  assert.doesNotMatch(msg(u), /second listing-create/);
  // A sign-in redirect after a Post click is verify-first too, not a halt.
  const v = new TabWatch();
  v.handle({ kind: "post-clicked" }, 0);
  v.handle({ kind: "login", url: "https://www.depop.com/login/" }, 1);
  v.handle({ kind: "closed" }, 2);
  assert.strictEqual(st(v), "unknown");
  // The session-start preflight checks the Post button too: without it no click can be seen.
  assert.ok(DEPOP.selectors.submit, "the map has a Post-button selector");
  assert.deepStrictEqual(PREFLIGHT_CONTROLS, [...BASE_FIELDS, "submit"]);
}

// --- One tab closed vs the window (S4) ---
assert.strictEqual(isWindowClose(1_000, [1_000], false, 1_500), false, "one tab closed alone");
assert.strictEqual(isWindowClose(1_000, [1_000, 1_200], false, 1_500), true, "two tabs closed together = the window");
assert.strictEqual(isWindowClose(1_000, [1_000, 9_000], false, 1_500), false, "closes far apart are separate tabs");
assert.strictEqual(isWindowClose(1_000, [1_000], true, 1_500), true, "Chrome gone");

// --- eBay stock while a tab waits (E12): every 10 min, and on refocus after 5+ min; mocked status sequence ---
{
  const sequence: (StockState | Error)[] = ["active", "sold"];
  const checks: number[] = [];
  const shown: StockBanner[] = [];
  let clock = 0;
  const w = new StockWatcher(
    async () => {
      checks.push(clock);
      const next = sequence.shift() ?? "sold";
      if (next instanceof Error) throw next;
      return next;
    },
    async (b) => {
      shown.push(b);
    },
    0
  );
  clock = STOCK_RECHECK_MS - 1;
  await w.tick(clock);
  assert.deepStrictEqual(checks, [], "no re-check before 10 min");
  clock = STOCK_RECHECK_MS;
  await w.tick(clock);
  assert.deepStrictEqual(checks, [STOCK_RECHECK_MS], "re-check at 10 min");
  assert.deepStrictEqual(shown, [null], "still active: no banner");
  clock = STOCK_RECHECK_MS + STOCK_REFOCUS_MS - 1;
  await w.focus(clock);
  assert.strictEqual(checks.length, 1, "refocus under 5 min since the last check does nothing");
  clock = STOCK_RECHECK_MS + STOCK_REFOCUS_MS;
  await w.focus(clock);
  assert.strictEqual(checks.length, 2, "refocus after 5+ min re-checks");
  assert.deepStrictEqual(shown, [null, "sold"], "sold puts up the SOLD ON EBAY banner");
  assert.strictEqual(w.soldShown, true);
  await w.tick(clock + STOCK_RECHECK_MS - 1);
  assert.strictEqual(checks.length, 2, "the 10-min clock restarts at the last check, focus included");
}
{
  // A failed check shows "couldn't confirm eBay stock"; a later good check clears it.
  const sequence: (StockState | Error)[] = [new Error("eBay 503"), "active"];
  const shown: StockBanner[] = [];
  const w = new StockWatcher(
    async () => {
      const next = sequence.shift()!;
      if (next instanceof Error) throw next;
      return next;
    },
    async (b) => {
      shown.push(b);
    },
    0
  );
  await w.tick(STOCK_RECHECK_MS);
  await w.tick(2 * STOCK_RECHECK_MS);
  assert.deepStrictEqual(shown, ["unconfirmed", null]);
  // "ended" reads as sold too: the item is no longer for sale.
  const ended = new StockWatcher(async () => "ended", async (b) => void shown.push(b), 0);
  await ended.tick(STOCK_RECHECK_MS);
  assert.strictEqual(shown.at(-1), "sold");
}
{
  // One check at a time: a tick during a slow check is dropped, not queued.
  let calls = 0;
  let release!: () => void;
  const w = new StockWatcher(
    () => {
      calls++;
      return new Promise<StockState>((r) => (release = () => r("active")));
    },
    async () => undefined,
    0
  );
  const first = w.tick(STOCK_RECHECK_MS);
  await w.focus(STOCK_RECHECK_MS + STOCK_REFOCUS_MS + 1);
  release();
  await first;
  assert.strictEqual(calls, 1);
}

// --- URL rules (one map in depop-fill.ts) ---
{
  const live = depopSite();
  assert.strictEqual(live.sellUrl, "https://www.depop.com/products/create/");
  assert.ok(isSellForm(live, "https://www.depop.com/products/create/"));
  assert.ok(isSellForm(live, "https://www.depop.com/products/create?draft=1"));
  assert.ok(!isSellForm(live, "https://www.depop.com/products/sam-fleece/"));
  assert.ok(!isSellForm(live, "https://evil.example/products/create/"));
  assert.strictEqual(listingUrlOf(live, "https://www.depop.com/products/sam-fleece-1a2b/?ref=x"), "https://www.depop.com/products/sam-fleece-1a2b/");
  assert.strictEqual(listingUrlOf(live, "https://www.depop.com/products/create/"), null, "the sell form is not a listing");
  assert.strictEqual(listingUrlOf(live, "https://depop.com.evil.example/products/x/"), null, "look-alike hosts are refused");
  assert.ok(isLoginUrl(live, "https://www.depop.com/login/?next=/products/create/"));
  assert.ok(isCreateRequest(live, "https://webapi.depop.com/api/v2/products/", "POST"));
  assert.ok(!isCreateRequest(live, "https://webapi.depop.com/api/v2/products/", "GET"));
  assert.ok(!isCreateRequest(live, "https://webapi.depop.com/api/v2/products/123/likes/", "POST"));
  assert.strictEqual(listingUrlFromCreateBody(live, { slug: "sam-fleece" }), "https://www.depop.com/products/sam-fleece/");
  assert.strictEqual(listingUrlFromCreateBody(live, { product: { slug: "p2" } }), "https://www.depop.com/products/p2/");
  assert.strictEqual(listingUrlFromCreateBody(live, { slug: "../../x" }), null);
  const local = depopSite("http://127.0.0.1:5555");
  assert.ok(isSellForm(local, "http://127.0.0.1:5555/products/create/"));
  assert.ok(!isSellForm(local, "http://127.0.0.1:6666/products/create/"));
}

console.log("depop-fill ok");
