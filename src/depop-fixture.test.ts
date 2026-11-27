// The Depop fill script end to end, offline: installed Chrome (or Edge) on a throwaway profile, headless,
// driving the SYNTHETIC sell form in src/fixtures/ from a local server. "Sam" is a second CDP client that
// checks the filled tab and clicks Post (the tool never does). Covers both category paths (E14), submit
// detection, the halt rules, stock banners (E12), the window-close rule (S4), the session-start preflight,
// sign-in, a killed runner's orphan tabs (E11) and a Chrome left open without a port (E3).
// Never touches depop.com, Sam's everyday Chrome profile or the real Depop profile.
// Skips (passes with a message) when no Chrome or Edge is installed. Run: npm test
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromeArgs, findChrome, loadPlaywright, profileInUse } from "./browser-automation.js";
import { CliError } from "./draft-file.js";
import {
  depopSite,
  detectHalt,
  openDepopSession,
  SOLD_BANNER,
  STOCK_RECHECK_MS,
  UNCONFIRMED_BANNER,
  type DepopSession,
  type DepopSessionOptions,
  type StockState,
} from "./depop-fill.js";
import type { DepopFields, ListingDraft } from "./types.js";

function installedBrowser(): string | null {
  try {
    return findChrome();
  } catch {
    const edge = [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
    return edge.find((p) => existsSync(p)) ?? null;
  }
}
const chromePath = installedBrowser();
if (!chromePath) {
  console.log("SKIP depop-fixture: no installed Chrome or Edge found (install one or set CHROME_PATH to run this test).");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const FORM = readFileSync(join(here, "..", "src", "fixtures", "depop-sell-form.html"), "utf8");
const work = mkdtempSync(join(tmpdir(), "resell-depop-fixture-"));
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a80000000049454e44ae426082", "hex");
const photo = (name: string) => {
  const p = join(work, name);
  writeFileSync(p, name.endsWith(".png") ? PNG : "not a photo");
  return p;
};
const photos = [photo("front.png"), photo("back.png")];

// ---- the local stand-in for Depop ----
const fake = { loggedOut: false, state: "", slugless: false, createDelayMs: 0, creates: 0, n: 0 };
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fixture");
  const html = (body: string) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  };
  if (req.method === "GET" && url.pathname === "/products/create/") {
    if (fake.loggedOut) {
      res.writeHead(302, { location: "/login/?next=/products/create/" });
      return res.end();
    }
    return html(FORM.replace("<head>", `<head><script>window.FIXTURE=${JSON.stringify({ state: fake.state })}</script>`));
  }
  if (url.pathname === "/login/") {
    if (req.method === "POST") {
      fake.loggedOut = false;
      res.writeHead(204);
      return res.end();
    }
    return html(`<h1>Log in</h1><button id="signin" onclick="fetch('/login/',{method:'POST'}).then(()=>location.href='/products/create/')">Sign in</button>`);
  }
  if (req.method === "POST" && url.pathname === "/api/v2/products/") {
    req.resume();
    req.on("end", () => {
      fake.creates++;
      setTimeout(() => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(fake.slugless ? { id: 99 } : { slug: `item-${++fake.n}` }));
      }, fake.createDelayMs);
    });
    return;
  }
  if (/^\/products\/item-\d+\/$/.test(url.pathname)) return html("<h1>Your listing</h1>");
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const site = depopSite(origin);

const { chromium } = await loadPlaywright();
/** Real time plus a jump the test controls (capture deadline, 10-min stock re-check). */
let skew = 0;
const logs: string[] = [];
const options = (profileDir: string, extra: Partial<DepopSessionOptions> = {}): DepopSessionOptions => ({
  profileDir,
  chromePath: chromePath!,
  headless: true,
  site,
  log: (l) => logs.push(l),
  timing: { tickMs: 50, captureMs: 3_000, closeBurstMs: 400, settleMs: 300, now: () => Date.now() + skew },
  ...extra,
});

const field = (value: string | null) => ({ value, mapped: value !== null });
function listing(title: string, fields: Partial<Record<keyof DepopFields, string | null>>): ListingDraft {
  const all = { category: null, size: null, brand: null, condition: null, color: null, shipping: null, ...fields };
  return {
    platform: "depop",
    title,
    description: `${title}, described.`,
    price: 42,
    condition: "good",
    marketFields: { depop: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, field(v)])) as DepopFields },
  };
}
const trainers = (title: string) =>
  listing(title, { category: "Menswear > Footwear > Trainers", size: "US 9", brand: "Nike", condition: "Used - Good", color: "Black", shipping: "small" });

async function until<T>(get: () => Promise<T | null | undefined | false>, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get().catch(() => null);
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(50);
  }
}
const portOf = (profileDir: string) =>
  until(async () => existsSync(join(profileDir, "DevToolsActivePort")) && Number(readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0]), "DevToolsActivePort");
const samConnect = async (port: number) => chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const pagesOf = (b: any): any[] => b.contexts()[0].pages();
/** Sam finds the filled tab by the banner the runner put up for that item. */
const filledTab = (sam: any, label: string) =>
  until(async () => {
    for (const p of pagesOf(sam)) {
      const t = await p.evaluate(() => document.getElementById("resell-banner-fill")?.textContent ?? "").catch(() => "");
      if (t.includes(label)) return p;
    }
    return null;
  }, `filled tab ${label}`);
const val = (p: any, sel: string) => p.locator(sel).first().inputValue();
const text = (p: any, sel: string) => p.evaluate((s: string) => document.querySelector(s)?.textContent ?? "", sel);

const sessions: DepopSession[] = [];
const children: ChildProcess[] = [];
try {
  // ---------- session 1: sign-in at session start, then fills ----------
  const profile = join(work, "profile-main");
  fake.loggedOut = true;
  const opening = openDepopSession(options(profile));
  const sam = await samConnect(await portOf(profile));
  const login = await until(async () => pagesOf(sam).find((p) => p.url().includes("/login/")), "the sign-in page");
  await login.click("#signin"); // Sam signs in by hand, once
  const s = await opening;
  sessions.push(s);
  assert.strictEqual(s.haltReason(), null);
  assert.ok(logs.some((l) => /Sign in to Depop/.test(l)), "Sam is told to sign in");

  // Footwear path: every field mapped and filled; the tool never clicks Post.
  const itemDir = join(work, "item-trainers", ".resell");
  const p1 = s.forItem({ label: "Trainers item", logDir: itemDir }).fill("depop", trainers("Trainers item"), photos);
  const t1 = await filledTab(sam, "Trainers item");
  assert.strictEqual(await val(t1, "#title"), "Trainers item");
  assert.strictEqual(await val(t1, "#description"), "Trainers item, described.");
  assert.strictEqual(await val(t1, "#price"), "42");
  assert.strictEqual((await text(t1, '[data-testid="category__select"]')).trim(), "Menswear > Footwear > Trainers");
  assert.strictEqual(await val(t1, "#condition"), "Used - Good");
  assert.strictEqual(await val(t1, "#size"), "US 9");
  assert.strictEqual(await val(t1, "#brand"), "Nike");
  assert.strictEqual(await val(t1, "#colour"), "Black");
  assert.strictEqual(await t1.locator('input[name="parcelSize"][value="small"]').isChecked(), true);
  assert.strictEqual(await text(t1, "#photo-count"), "2 photos");
  assert.match(await text(t1, "#resell-banner-fill"), /Every field is filled/);
  await sleep(300);
  assert.strictEqual(fake.creates, 0, "the tool never clicks Post");
  await t1.click("#post"); // Sam
  const r1 = await p1;
  assert.deepStrictEqual([r1.status, r1.url], ["published", `${origin}/products/item-1/`]);
  assert.strictEqual(fake.creates, 1);

  // Tops path: size and parcel size unmapped are left for Sam, outlined, and named in the banner.
  const p2 = s.forItem({ label: "Tee item" }).fill("depop", listing("Tee item", { category: "Womenswear > Tops > T-shirts", brand: "Patagonia", condition: "Like new", color: "Green" }), photos);
  const t2 = await filledTab(sam, "Tee item");
  assert.strictEqual(await t2.locator("#size").getAttribute("data-resell-needs"), "size");
  assert.ok(await t2.locator('[data-resell-needs="shipping"]').count(), "parcel size outlined");
  assert.match(await text(t2, "#resell-banner-fill"), /Fill these yourself: size, shipping/);
  assert.strictEqual(await val(t2, "#brand"), "Patagonia");
  await t2.close(); // Sam closes the tab without posting
  const r2 = await p2;
  assert.strictEqual(r2.status, "not_posted");

  // E14 stage 2: a mapped size whose control never appears (Decor has none) is an error naming the field,
  // with a screenshot in the item's .resell folder; it is not a halt.
  const decorDir = join(work, "item-decor", ".resell");
  const r3 = await s.forItem({ label: "Decor item", logDir: decorDir }).fill("depop", listing("Decor item", { category: "Everything else > Home > Decor", size: "M", condition: "Used - Good" }), photos);
  assert.strictEqual(r3.status, "error");
  assert.match(r3.message, /couldn't find the size field/);
  assert.ok(readdirSync(decorDir).some((f) => /^error-.*\.png$/.test(f)), "error screenshot saved (D4, E10)");
  assert.strictEqual(s.haltReason(), null, "a category field miss never halts the session");
  // A Decor item with no size mapped fills fine: no false miss on a category without a size control.
  const pDecor = s.forItem({ label: "Decor ok" }).fill("depop", listing("Decor ok", { category: "Everything else > Home > Decor", condition: "Used - Good", shipping: "large" }), photos);
  const tDecor = await filledTab(sam, "Decor ok");
  assert.strictEqual(await tDecor.locator("#size").count(), 0);
  await tDecor.close();
  assert.strictEqual((await pDecor).status, "not_posted");

  // S2: a photo the form rejects is an error.
  const r4 = await s.forItem({ label: "Bad photo" }).fill("depop", trainers("Bad photo"), [photo("notes.txt")]);
  assert.strictEqual(r4.status, "error");
  assert.match(r4.message, /rejected a photo/);

  // S4: a double-click on Post; the first create wins and the second is a warning.
  // The server answers slowly, so both requests are out before the first answer navigates the tab.
  fake.createDelayMs = 400;
  const p5 = s.forItem({ label: "Double" }).fill("depop", trainers("Double"), photos);
  const t5 = await filledTab(sam, "Double");
  const before5 = fake.creates;
  await t5.evaluate(() => {
    const b = document.getElementById("post")!;
    b.click();
    b.click();
  });
  const r5 = await p5;
  fake.createDelayMs = 0;
  assert.strictEqual(fake.creates - before5, 2, "both creates reached the server");
  assert.strictEqual(r5.status, "published");
  assert.match(r5.message, /second listing-create request/);

  // Submit seen, no URL: the tab closed -> unknown; the capture deadline passing -> unknown.
  fake.slugless = true;
  const p6 = s.forItem({ label: "No URL" }).fill("depop", trainers("No URL"), photos);
  const t6 = await filledTab(sam, "No URL");
  const before6 = fake.creates;
  await t6.click("#post");
  await until(async () => fake.creates > before6, "create request");
  await sleep(200);
  await t6.close();
  const r6 = await p6;
  assert.strictEqual(r6.status, "unknown");
  assert.match(r6.message, /submit was seen/);
  const p7 = s.forItem({ label: "Timeout" }).fill("depop", trainers("Timeout"), photos);
  const t7 = await filledTab(sam, "Timeout");
  const before7 = fake.creates;
  await t7.click("#post");
  await until(async () => fake.creates > before7, "create request");
  await sleep(200);
  skew += 3_001;
  const r7 = await p7;
  assert.strictEqual(r7.status, "unknown");
  assert.match(r7.message, /no listing URL was captured/);
  fake.slugless = false;
  await t7.close();

  // E12: a failed pre-fill check opens the tab with "couldn't confirm"; a later re-check that finds it sold
  // puts up the red SOLD ON EBAY banner.
  const stock: StockState[] = ["sold"];
  const p8 = s.forItem({ label: "Stock", stock: async () => stock.shift() ?? "sold", stockUnconfirmed: true }).fill("depop", trainers("Stock"), photos);
  const t8 = await filledTab(sam, "Stock");
  assert.strictEqual(await text(t8, "#resell-banner-stock"), UNCONFIRMED_BANNER);
  skew += STOCK_RECHECK_MS;
  await until(async () => (await text(t8, "#resell-banner-stock")) === SOLD_BANNER, "SOLD ON EBAY banner");
  await t8.close();
  const r8 = await p8;
  assert.strictEqual(r8.status, "not_posted");
  assert.match(r8.message, /SOLD ON EBAY banner was shown/);

  // S4: closing the window (both filled tabs at once) is unknown for each, not not_posted.
  const p9 = s.forItem({ label: "Win A" }).fill("depop", trainers("Win A"), photos);
  const p10 = s.forItem({ label: "Win B" }).fill("depop", trainers("Win B"), photos);
  const [ta, tb] = [await filledTab(sam, "Win A"), await filledTab(sam, "Win B")];
  await Promise.all([ta.close(), tb.close()]);
  assert.deepStrictEqual([(await p9).status, (await p10).status], ["unknown", "unknown"]);

  // Halt signals are read from Depop's notice regions only: the form's policy help text never trips one.
  const probe = await pagesOf(sam)[0].context().newPage();
  for (const [state, want] of [["", null], ["restricted", "an account restriction banner"], ["policy", "a policy or warning notice"], ["captcha", "a captcha or login challenge"]] as const) {
    fake.state = state;
    await probe.goto(site.sellUrl);
    assert.strictEqual(await detectHalt(probe), want, `state=${state || "plain"}`);
  }
  await probe.close();

  // A halt signal while filling stops the market: that item errors, and no further tab is filled.
  fake.state = "restricted";
  const r11 = await s.forItem({ label: "Halted" }).fill("depop", trainers("Halted"), photos);
  assert.strictEqual(r11.status, "error");
  assert.match(r11.message, /Depop halted: an account restriction banner/);
  assert.strictEqual(s.haltReason(), "an account restriction banner");
  fake.state = "";
  const tabsBefore = pagesOf(sam).length;
  const r12 = await s.forItem({ label: "After halt" }).fill("depop", trainers("After halt"), photos);
  assert.match(r12.message, /Depop halted/);
  assert.strictEqual(pagesOf(sam).length, tabsBefore, "no tab opened after a halt");

  // E9: the session closes its Chrome.
  const port1 = s.chrome.port;
  await s.close();
  sessions.pop();
  await until(async () => !profileInUse(profile), "Chrome closed at session end");
  assert.strictEqual(await fetch(`http://127.0.0.1:${port1}/json/version`).then(() => true, () => false), false, "the debug port is gone");

  // ---------- session-start preflight (E14 stage 1) and an expired sign-in mid-session ----------
  fake.state = "noprice";
  await assert.rejects(openDepopSession(options(profile)), (e: unknown) => e instanceof CliError && e.code === "depop_halted" && /couldn't find the price field/.test(e.message));
  await until(async () => !profileInUse(profile), "Chrome closed after a preflight halt");
  fake.state = "";
  const s2 = await openDepopSession(options(profile));
  sessions.push(s2);
  fake.loggedOut = true;
  const r13 = await s2.forItem({ label: "Signed out" }).fill("depop", trainers("Signed out"), photos);
  assert.strictEqual(r13.status, "error");
  assert.match(r13.message, /Sign in again/);
  assert.match(s2.haltReason() ?? "", /Sign in again/);
  fake.loggedOut = false;
  await s2.close();
  sessions.pop();

  // ---------- E11: the runner is killed mid-wait; the re-run closes every tab it didn't open ----------
  // On Windows a killed runner takes the Chrome it spawned with it (libuv's kill-on-close job), so no tab
  // survives there. The case E11 guards is a Chrome that outlives the runner (macOS, or a Chrome the
  // runner attached to): reproduced here by starting the profile Chrome outside the runner.
  const killProfile = join(work, "profile-kill");
  const outlives = spawn(chromePath, chromeArgs(killProfile, true), { stdio: "ignore" });
  children.push(outlives);
  await portOf(killProfile);
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { openDepopSession, depopSite } = await import(${JSON.stringify(pathToFileURL(join(here, "depop-fill.js")).href)});
       const [profileDir, chromePath, origin, listing, photo] = process.argv.slice(1);
       const s = await openDepopSession({ profileDir, chromePath, headless: true, site: depopSite(origin), log: () => {} });
       s.forItem({ label: "Orphan" }).fill("depop", JSON.parse(listing), [photo]);
       for (;;) {
         const filled = await Promise.all(s.chrome.context.pages().map((p) => p.evaluate(() => !!document.getElementById("resell-banner-fill")).catch(() => false)));
         if (filled.some(Boolean)) break;
         await new Promise((r) => setTimeout(r, 50));
       }
       console.log("WAITING");
       setInterval(() => {}, 1000);`,
      killProfile,
      chromePath,
      origin,
      JSON.stringify(trainers("Orphan")),
      photos[0],
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  children.push(child);
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  await until(async () => out.includes("WAITING"), "the child filled a tab", 30_000);
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  assert.ok(profileInUse(killProfile), "Chrome outlived the killed runner, with its filled tab");
  const before = await samConnect(await portOf(killProfile));
  assert.ok(await until(async () => pagesOf(before).some((p) => p.url().includes("/products/create/")), "the orphan tab is still open and postable"));
  const s3 = await openDepopSession(options(killProfile));
  sessions.push(s3);
  assert.strictEqual(s3.chrome.attached, true, "re-attached to the running profile Chrome (E3)");
  assert.strictEqual(s3.orphansClosed, 2, "the old home tab and the old filled tab");
  const sam3 = await samConnect(s3.chrome.port);
  const left = pagesOf(sam3).map((p) => p.url());
  assert.deepStrictEqual(left, ["about:blank"], "no pre-existing tab survives; only the new run's home tab");
  await s3.close();
  sessions.pop();

  // ---------- E3: the profile's Chrome is open without a debug port -> "close the Depop Chrome window" ----------
  const busyProfile = join(work, "profile-busy");
  const plain = spawn(chromePath, [`--user-data-dir=${busyProfile}`, "--headless=new", "--no-first-run", "about:blank"], { stdio: "ignore" });
  children.push(plain);
  await until(async () => profileInUse(busyProfile), "plain Chrome holds the profile");
  await assert.rejects(openDepopSession(options(busyProfile)), (e: unknown) => e instanceof CliError && e.code === "depop_chrome_open" && /Close the Depop Chrome window/.test(e.hint ?? ""));
  assert.ok(!existsSync(`${busyProfile}.lock`), "the profile lock is released when the session can't start");
} finally {
  for (const s of sessions) await s.close();
  for (const c of children) if (c.exitCode === null) c.kill();
  server.close();
}

console.log("depop-fixture ok");
