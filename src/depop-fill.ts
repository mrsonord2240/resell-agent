// Depop assisted fill: the sell-form script, its selector map, and submit detection.
//
// The runner fills one Depop sell form per tab from the item's draft and waits. Sam reviews the
// tab and clicks Post himself; the tool never clicks it. It watches the tab for the listing-create
// request or a navigation off the sell form, captures the listing URL, and reports what the tab
// ended as (the state table in the spec's "Assisted-fill contract"):
//   submit + URL -> published; submit, no URL -> unknown; tab closed, no submit -> not_posted;
//   window closed / Chrome gone -> unknown. Once a submit is seen, nothing here throws (Task 3 rule).
//
// EVERY Depop selector, URL rule and halt pattern lives in DEPOP below, so a live mismatch is a
// one-place fix. They are best-known values, NOT verified against the live form: the session-start
// preflight (E14) is the real check, and Sam's first live session confirms the create request.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchOrAttachChrome, acquireProfileLock, findChrome, marketProfileDir, isExpectedPlatformUrl, type ChromeHandle } from "./browser-automation.js";
import { CliError } from "./draft-file.js";
import type { BrowserFillOutcome, BrowserMarket, BrowserSession } from "./publish.js";
import type { DepopFieldName, ListingDraft } from "./types.js";

// ---------- the one Depop map ----------

export const DEPOP = {
  origin: "https://www.depop.com",
  sellPath: "/products/create/",
  /** The listing-create call (POST). Unverified: Depop's web app posts to webapi.depop.com/api/v<n>/products/. */
  createRequest: /\/api\/v\d+\/products\/?(\?.*)?$/i,
  /** A listing page: /products/<slug>/ (anything but the sell form). */
  listingPath: /^\/products\/(?!create\/?$)([a-z0-9][a-z0-9_-]*)\/?$/i,
  loginPath: /^\/(login|signup|sign-in|auth)(\/|$)/i,
  maxPhotos: 8,
  selectors: {
    photos: 'input[type="file"]',
    photoError: '[data-testid="photo-upload__error"]',
    title: '[data-testid="title__input"], input[name="title"]',
    description: '[data-testid="description__input"], textarea[name="description"]',
    price: '[data-testid="price__input"], input[name="price"]',
    category: '[data-testid="category__select"], [aria-label="Category"]',
    condition: '[data-testid="condition__select"], [aria-label="Condition"]',
    size: '[data-testid="size__select"], [aria-label="Size"]',
    brand: '[data-testid="brand__input"], [aria-label="Brand"]',
    color: '[data-testid="colour__select"], [aria-label="Colour"]',
    shipping: '[data-testid="parcel-size__radio"], input[name="parcelSize"]',
    /** Never clicked by the tool: a click on it (by Sam) is a possible submit even when no create request is recognised. */
    submit: '[data-testid="submit__button"], form button[type="submit"]',
    option: '[role="option"]',
  },
  halt: {
    /** A captcha or challenge frame the runner didn't expect. */
    captcha: 'iframe[src*="captcha" i], iframe[title*="challenge" i], #px-captcha, [data-testid="captcha"]',
    /** Where Depop shows notices; only these are read, so the form's help text never trips a halt. */
    notices: '[role="alert"], [role="alertdialog"], [role="dialog"], [data-testid*="banner" i]',
    patterns: [
      { re: /captcha|verify (that )?you('| a)re (a )?human|are you a robot|security check/i, reason: "a captcha or login challenge" },
      { re: /account (has been |is |was )?(restricted|suspended|limited|banned|disabled)/i, reason: "an account restriction banner" },
      { re: /listing (has been |was |is )?removed|removed (your|this) listing/i, reason: "a removed-listing notice" },
      { re: /violat\w* (our|depop'?s?) (polic|terms|guidelines)|policy (warning|violation)|final warning/i, reason: "a policy or warning notice" },
    ],
  },
} as const;

type FieldName = "photos" | "title" | "description" | "price" | DepopFieldName;
/** E14 stage 1: on a blank form, checked once at session start (a miss halts Depop). */
export const BASE_FIELDS: readonly FieldName[] = ["photos", "title", "description", "price", "category", "condition"];
/** The session-start check: the blank-form fields plus the Post button, whose click is the fail-safe submit signal. */
export const PREFLIGHT_CONTROLS: readonly (FieldName | "submit")[] = [...BASE_FIELDS, "submit"];
/** E14 stage 2: appear once a category is chosen; checked per tab (a miss is an `error` on that item). */
export const CATEGORY_FIELDS: readonly DepopFieldName[] = ["size", "brand", "color", "shipping"];

const SIGN_IN = "Depop signed this browser out (redirected to sign-in). Sign in again in the Depop Chrome window, then re-run.";

// ---------- the site (tests point it at a local fixture server) ----------

export interface DepopSite {
  origin: string;
  sellUrl: string;
}

export function depopSite(origin: string = DEPOP.origin): DepopSite {
  const o = origin.replace(/\/+$/, "");
  return { origin: o, sellUrl: `${o}${DEPOP.sellPath}` };
}

function parse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** depop.com and its subdomains for the real site; the exact host for a local fixture. */
function onSite(site: DepopSite, url: URL): boolean {
  const { hostname: host, host: hostPort } = new URL(site.origin);
  if (/^(127\.0\.0\.1|localhost)$/.test(host)) return url.host === hostPort;
  const base = host.split(".").slice(-2).join(".");
  return url.hostname === base || url.hostname.endsWith(`.${base}`);
}

export function isSellForm(site: DepopSite, value: string): boolean {
  const url = parse(value);
  return !!url && onSite(site, url) && `${url.pathname.replace(/\/+$/, "")}/`.startsWith(DEPOP.sellPath);
}

export function isLoginUrl(site: DepopSite, value: string): boolean {
  const url = parse(value);
  return !!url && onSite(site, url) && DEPOP.loginPath.test(url.pathname);
}

/** The canonical listing URL when `value` is a listing page on the site, else null. */
export function listingUrlOf(site: DepopSite, value: string): string | null {
  const url = parse(value);
  if (!url || !onSite(site, url)) return null;
  const m = DEPOP.listingPath.exec(url.pathname);
  if (!m) return null;
  const out = `${site.origin}/products/${m[1]}/`;
  return site.origin === DEPOP.origin && !isExpectedPlatformUrl("depop", out) ? null : out;
}

export function isCreateRequest(site: DepopSite, value: string, method: string): boolean {
  const url = parse(value);
  return method.toUpperCase() === "POST" && !!url && onSite(site, url) && DEPOP.createRequest.test(url.pathname + url.search);
}

/** A listing URL from the create response body: `slug` at the top, or under `product`/`data`. */
export function listingUrlFromCreateBody(site: DepopSite, body: unknown): string | null {
  const b = body as Record<string, any> | null;
  const slug = [b?.slug, b?.product?.slug, b?.data?.slug].find((s) => typeof s === "string" && /^[a-z0-9][a-z0-9_-]*$/i.test(s));
  return slug ? `${site.origin}/products/${slug}/` : null;
}

// ---------- what a waiting tab ends as (pure) ----------

export const CAPTURE_MS = 60_000;

export type TabEvent =
  | { kind: "create" }
  /** Sam clicked Post (or the form submitted). Counted even when the create call isn't recognised. */
  | { kind: "post-clicked" }
  | { kind: "listing"; url: string }
  | { kind: "login"; url: string }
  | { kind: "left"; url: string }
  | { kind: "closed" }
  | { kind: "window-closed" }
  /** The runner lost track of the tab (a glue failure); it may still be open and postable. */
  | { kind: "lost"; why: string }
  | { kind: "tick" };

export type TabOutcome = BrowserFillOutcome | { halt: string };

const SECOND_CREATE = "Warning: a second listing-create request was seen (double-click on Post?); the first one counts. Check Depop for a duplicate.";
const VERIFY = "Verify it on Depop, then `resell mark` it posted (with the URL) or not posted.";

/** The state table for one filled tab. Fed events by the browser glue; tests feed it directly. */
export class TabWatch {
  submitAt: number | null = null;
  url: string | null = null;
  outcome: TabOutcome | null = null;
  private creates = 0;
  private postClicked = false;
  private leftTo: string | null = null;
  private readonly notes: string[] = [];

  constructor(private readonly captureMs = CAPTURE_MS) {}

  get submitSeen(): boolean {
    return this.submitAt !== null;
  }

  note(text: string): void {
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  private done(status: BrowserFillOutcome["status"], message: string, url?: string): void {
    const tail = this.notes.length ? ` ${this.notes.join(" ")}` : "";
    this.outcome = { status, message: `${message}${tail}`, ...(url ? { url } : {}) };
  }

  handle(ev: TabEvent, now: number): void {
    if (this.outcome) {
      // S4: a second create can arrive after the first one's URL resolved the tab; it still warns.
      if (ev.kind === "create" && ++this.creates === 2 && "message" in this.outcome) this.outcome.message += ` ${SECOND_CREATE}`;
      return;
    }
    switch (ev.kind) {
      case "create":
        // S4: a double-click on Post; the first create request seen wins.
        if (++this.creates === 2) this.note(SECOND_CREATE);
        this.submitAt ??= now;
        return;
      case "post-clicked":
        // Not a deadline start: a click Depop rejects (a missing field) leaves Sam fixing the form.
        this.postClicked = true;
        return;
      case "listing":
        this.submitAt ??= now;
        this.url = ev.url;
        this.done("published", "Posted on Depop by Sam; listing URL captured.", ev.url);
        return;
      case "login":
        if (!this.submitSeen && !this.postClicked) {
          this.outcome = { halt: SIGN_IN };
          return;
        }
        this.leftTo = ev.url;
        return;
      case "left":
        // Off the sell form with no listing URL: treat it as a submit and wait for the URL (verify-first).
        this.submitAt ??= now;
        this.leftTo = ev.url;
        return;
      case "closed":
        if (this.submitSeen) this.done("unknown", `A submit was seen, but the tab closed before the listing URL was captured. ${VERIFY}`);
        else if (this.postClicked) this.done("unknown", `Post was clicked, but no listing-create request or listing page was seen before the tab closed. ${VERIFY}`);
        else this.done("not_posted", "Tab closed with no submit seen; the next session fills it again.");
        return;
      case "window-closed":
        this.done("unknown", `The Depop window closed (or Chrome exited) while this tab waited${this.submitSeen ? ", after a submit" : ""}. ${VERIFY}`);
        return;
      case "lost":
        this.done("unknown", `The runner lost track of this tab (${ev.why}); it may still be open and postable. ${VERIFY}`);
        return;
      case "tick":
        if (this.submitAt !== null && now - this.submitAt >= this.captureMs) {
          const where = this.leftTo ? `the tab left the sell form for ${this.leftTo}` : "a submit was seen";
          this.done("unknown", `Depop: ${where}, but no listing URL was captured within ${Math.round(this.captureMs / 1000)} s. ${VERIFY}`);
        }
        return;
    }
  }
}

/** S4: several of the session's tabs closing together (or Chrome gone) is the window, not one tab. */
export function isWindowClose(closedAt: number, allCloses: number[], disconnected: boolean, burstMs: number): boolean {
  return disconnected || allCloses.filter((t) => Math.abs(t - closedAt) <= burstMs).length >= 2;
}

// ---------- eBay stock while a tab waits (O4, E12; pure but for the injected calls) ----------

export type StockState = "active" | "sold" | "ended";
export const STOCK_RECHECK_MS = 10 * 60_000;
export const STOCK_REFOCUS_MS = 5 * 60_000;
export type StockBanner = "sold" | "unconfirmed" | null;
export const SOLD_BANNER = "SOLD ON EBAY, don't post";
export const UNCONFIRMED_BANNER = "Couldn't confirm eBay stock. Check eBay before you post.";

/** Re-checks every 10 min, and on refocus after 5+ min since the last check (E12). One check at a time. */
export class StockWatcher {
  banner: StockBanner;
  soldShown = false;
  private last: number;
  private busy = false;

  constructor(
    private readonly check: () => Promise<StockState>,
    private readonly show: (banner: StockBanner) => Promise<void>,
    lastCheck: number,
    initial: StockBanner = null
  ) {
    this.last = lastCheck;
    this.banner = initial;
  }

  tick(now: number): Promise<void> {
    return now - this.last >= STOCK_RECHECK_MS ? this.run(now) : Promise.resolve();
  }

  focus(now: number): Promise<void> {
    return now - this.last >= STOCK_REFOCUS_MS ? this.run(now) : Promise.resolve();
  }

  private async run(now: number): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.last = now;
    try {
      let next: StockBanner;
      try {
        const state = await this.check();
        next = state === "active" ? null : "sold";
      } catch {
        next = "unconfirmed";
      }
      if (next === "sold") this.soldShown = true;
      this.banner = next;
      await this.show(next).catch(() => undefined);
    } finally {
      this.busy = false;
    }
  }
}

// ---------- the form script (Playwright page; plain code, no selector DSL) ----------

/** A fill error that names the field, e.g. "Depop: couldn't find the size field". */
export class FillError extends Error {}

const ALL_FIELDS = DEPOP.selectors;

async function present(page: any, selector: string, waitMs = 0): Promise<boolean> {
  if (waitMs > 0) {
    try {
      await page.locator(selector).first().waitFor({ state: "attached", timeout: waitMs });
      return true;
    } catch {
      return false;
    }
  }
  return (await page.locator(selector).count()) > 0;
}

/** E14 stage 1: which blank-form controls are missing. Waits for the form to render first. */
export async function missingBaseControls(page: any, waitMs = 15_000): Promise<string[]> {
  await present(page, ALL_FIELDS.photos, waitMs);
  const missing: string[] = [];
  for (const f of PREFLIGHT_CONTROLS) if (!(await present(page, ALL_FIELDS[f]))) missing.push(f);
  return missing;
}

/** A halt condition on the page (S2 halt rules), or null. `includeCaptcha: false` while Sam is mid-post. */
export async function detectHalt(page: any, includeCaptcha = true): Promise<string | null> {
  if (includeCaptcha && (await present(page, DEPOP.halt.captcha))) return "a captcha or login challenge";
  const texts: string[] = await page
    .locator(DEPOP.halt.notices)
    .evaluateAll((els: Element[]) => els.filter((e) => (e as HTMLElement).offsetParent !== null || e.getClientRects().length).map((e) => (e as HTMLElement).innerText ?? ""))
    .catch(() => []);
  for (const { re, reason } of DEPOP.halt.patterns) {
    if (!includeCaptcha && reason.startsWith("a captcha")) continue;
    if (texts.some((t) => re.test(t))) return reason;
  }
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Picks `value` in a select, radio group or combobox. Returns why it couldn't (left for Sam), or null. */
async function pick(page: any, field: string, selector: string, value: string): Promise<string | null> {
  const el = page.locator(selector).first();
  const { tag, type } = await el.evaluate((e: HTMLInputElement) => ({ tag: e.tagName.toLowerCase(), type: (e.type ?? "").toLowerCase() }));
  const want = value.trim().toLowerCase();
  if (tag === "select") {
    const labels: string[] = await el.evaluate((e: HTMLSelectElement) => [...e.options].map((o) => o.label.trim()));
    const hit = labels.find((l) => l.toLowerCase() === want);
    if (!hit) return `${field}: "${value}" isn't one of Depop's options`;
    await el.selectOption({ label: hit });
    return null;
  }
  if (tag === "input" && type === "radio") {
    const radios = page.locator(selector);
    const n = await radios.count();
    for (let i = 0; i < n; i++) {
      const r = radios.nth(i);
      const label: string = await r.evaluate((e: HTMLInputElement) => `${e.value}|${e.labels?.[0]?.innerText ?? ""}`.toLowerCase());
      if (label.split("|").some((t) => t.trim() === want)) {
        await r.check({ force: true });
        return null;
      }
    }
    return `${field}: "${value}" isn't one of Depop's options`;
  }
  // A combobox / menu button: open it, then click each level of the path ("Menswear > Footwear > Trainers").
  // Clicks are forced: a tab filling in the background (E4) has throttled animation frames, which
  // Playwright's stability wait depends on. Each target's presence or visibility is checked first.
  await el.click({ force: true });
  for (const part of value.split(">").map((p) => p.trim()).filter(Boolean)) {
    const opt = page.locator(DEPOP.selectors.option).filter({ hasText: new RegExp(`^\\s*${escapeRe(part)}\\s*$`, "i") }).first();
    try {
      await opt.waitFor({ state: "visible", timeout: 3_000 });
    } catch {
      await page.keyboard.press("Escape").catch(() => undefined);
      return `${field}: "${part}" isn't one of Depop's options`;
    }
    await opt.click({ force: true });
  }
  return null;
}

/** A typeahead text field (brand): type the value; take the exact suggestion when one appears. */
async function typeahead(page: any, selector: string, value: string): Promise<void> {
  const el = page.locator(selector).first();
  await el.fill(value);
  const opt = page.locator(DEPOP.selectors.option).filter({ hasText: new RegExp(`^\\s*${escapeRe(value.trim())}\\s*$`, "i") }).first();
  try {
    await opt.waitFor({ state: "visible", timeout: 1_000 });
    await opt.click({ force: true });
  } catch {
    /* free text stays as typed */
  }
}

/** Outlines a control Sam must fill himself (success criteria: unmapped fields highlighted in the tab). */
async function highlight(page: any, selector: string, field: string): Promise<void> {
  await page
    .locator(selector)
    .first()
    .evaluate((e: HTMLElement, name: string) => {
      const target = (e as HTMLInputElement).type === "file" || (e as HTMLInputElement).type === "radio" ? e.parentElement ?? e : e;
      target.style.outline = "3px solid #f59e0b";
      target.style.outlineOffset = "2px";
      target.setAttribute("data-resell-needs", name);
    }, field)
    .catch(() => undefined);
}

/** Sets (or clears) one banner in a fixed strip at the top of the tab. */
export async function setBanner(page: any, id: string, text: string | null, tone: "red" | "amber" | "blue" = "amber"): Promise<void> {
  await page
    .evaluate(
      ({ id, text, tone }: { id: string; text: string | null; tone: string }) => {
        let strip = document.getElementById("resell-banners");
        if (!strip) {
          strip = document.createElement("div");
          strip.id = "resell-banners";
          strip.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;font:600 15px/1.35 system-ui,sans-serif;pointer-events:none";
          document.documentElement.appendChild(strip);
        }
        const old = document.getElementById(`resell-banner-${id}`);
        if (!text) {
          old?.remove();
          return;
        }
        const el = old ?? document.createElement("div");
        el.id = `resell-banner-${id}`;
        const bg = tone === "red" ? "#c62828" : tone === "blue" ? "#1d4ed8" : "#b45309";
        el.style.cssText = `background:${bg};color:#fff;padding:10px 16px;text-align:center;${tone === "red" ? "font-size:20px;" : ""}`;
        el.textContent = text;
        if (!old) strip.appendChild(el);
      },
      { id, text, tone }
    )
    .catch(() => undefined);
}

export interface FillReport {
  /** Fields left for Sam (unmapped, or a value Depop doesn't offer). Each is highlighted in the tab. */
  needsSam: string[];
  notes: string[];
}

/**
 * Fills one sell form from the listing. Throws FillError naming the field for a missing control
 * (E14 stage 2 after the category is chosen) or a rejected photo (S2). Never clicks Post.
 */
export async function fillDepopForm(page: any, listing: ListingDraft, photoPaths: string[]): Promise<FillReport> {
  const fields = listing.marketFields?.depop;
  const needsSam: string[] = [];
  const notes: string[] = [];
  const S = DEPOP.selectors;
  const need = async (field: FieldName, waitMs = 0) => {
    if (!(await present(page, S[field], waitMs))) throw new FillError(`Depop: couldn't find the ${field} field on the sell form.`);
  };

  for (const f of BASE_FIELDS) await need(f);
  // Without the Post button no click can be seen, and a missed submit would read as not_posted (C1).
  if (!(await present(page, S.submit))) throw new FillError("Depop: couldn't find the Post button on the sell form.");

  const photos = photoPaths.slice(0, DEPOP.maxPhotos);
  if (photoPaths.length > photos.length) notes.push(`Only the first ${DEPOP.maxPhotos} of ${photoPaths.length} photos were added.`);
  await page.locator(S.photos).first().setInputFiles(photos);

  await page.locator(S.title).first().fill(listing.title);
  await page.locator(S.description).first().fill(listing.description);
  await page.locator(S.price).first().fill(String(listing.price));

  const leave = async (field: DepopFieldName, why?: string) => {
    needsSam.push(field);
    if (why) notes.push(why);
    if (await present(page, S[field])) await highlight(page, S[field], field);
  };

  const category = fields?.category;
  let categoryChosen = false;
  if (category?.mapped && category.value) {
    const why = await pick(page, "category", S.category, category.value);
    if (why) await leave("category", why);
    else categoryChosen = true;
  } else {
    await leave("category");
  }

  const condition = fields?.condition;
  if (condition?.mapped && condition.value) {
    const why = await pick(page, "condition", S.condition, condition.value);
    if (why) await leave("condition", why);
  } else {
    await leave("condition");
  }

  // E14 stage 2: these controls exist only once a category is chosen. A mapped value whose control
  // never appears is an error naming the field; an unmapped one is just left (and outlined if present).
  if (categoryChosen) await present(page, CATEGORY_FIELDS.map((f) => S[f]).join(", "), 5_000);
  for (const field of CATEGORY_FIELDS) {
    const f = fields?.[field];
    if (!f?.mapped || !f.value) {
      await leave(field);
      continue;
    }
    if (!categoryChosen) {
      await leave(field, `${field}: pick the category first, then ${field}.`);
      continue;
    }
    await need(field, 500);
    if (field === "brand") await typeahead(page, S.brand, f.value);
    else {
      const why = await pick(page, field, S[field], f.value);
      if (why) await leave(field, why);
    }
  }
  // S2: a photo the form rejected. Checked last, so the upload had the whole fill to report it.
  const photoError = page.locator(S.photoError).first();
  if (await photoError.waitFor({ state: "visible", timeout: 500 }).then(() => true, () => false)) {
    const why = ((await photoError.innerText().catch(() => "")) as string).trim();
    throw new FillError(`Depop rejected a photo${why ? `: ${why}` : "."}`);
  }
  return { needsSam, notes };
}

async function readEdits(page: any): Promise<Record<string, string>> {
  const S = DEPOP.selectors;
  const out: Record<string, string> = {};
  for (const f of ["title", "description", "price"] as const) {
    out[f] = await page.locator(S[f]).first().inputValue({ timeout: 1_000 });
  }
  return out;
}

// ---------- the session ----------

export interface DepopItemContext {
  /** Shown in the tab's banner and the session log. */
  label: string;
  /** `<item>/.resell`: where an error screenshot goes (D4, E10). */
  logDir?: string;
  /** The item's eBay stock (O4/E12); absent when the item has no live eBay listing to check. */
  stock?: () => Promise<StockState>;
  /** The pre-fill check failed: show "couldn't confirm eBay stock" from the start. */
  stockUnconfirmed?: boolean;
}

export interface DepopSessionOptions {
  profileDir?: string;
  chromePath?: string;
  /** Tests only. */
  headless?: boolean;
  site?: DepopSite;
  log?: (line: string) => void;
  /** Tests only: pacing of the wait loop. */
  timing?: { tickMs?: number; captureMs?: number; closeBurstMs?: number; settleMs?: number; now?: () => number };
}

/** The runner's long-lived Depop session (E2): one Chrome, many tabs, each filled and left for Sam. */
export interface DepopSession extends BrowserSession {
  forItem(ctx: DepopItemContext): BrowserSession;
  /** Set once the market halted (S2); no further tab is filled and nothing retries. */
  haltReason(): string | null;
  /** How many tabs the session closed on attach because it hadn't opened them (E11). */
  readonly orphansClosed: number;
  /** The Chrome the session drives; tests read its port. */
  readonly chrome: ChromeHandle;
  close(): Promise<void>;
}

/**
 * One draft's Depop session (`resell post`, the GUI): Chrome opens only if a fill actually starts.
 * `fill` never throws: a session that won't open (no Chrome, profile busy, preflight) is an `error`.
 */
export function lazyDepopSession(
  ctx: Omit<DepopItemContext, "label">,
  open: () => Promise<DepopSession> = () => openDepopSession()
): { session: BrowserSession; close: () => Promise<void> } {
  let opened: Promise<DepopSession> | null = null;
  return {
    session: {
      async fill(platform, listing, photoPaths) {
        let s: DepopSession;
        try {
          s = await (opened ??= open());
        } catch (e) {
          const hint = e instanceof CliError && e.hint ? ` ${e.hint}` : "";
          return { status: "error", message: `Depop session didn't start: ${e instanceof Error ? e.message : String(e)}${hint}` };
        }
        return s.forItem({ ...ctx, label: listing.title }).fill(platform, listing, photoPaths);
      },
    },
    close: async () => {
      if (opened) await (await opened.catch(() => null))?.close();
    },
  };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Starts (or attaches to) the profile Chrome, closes every tab it didn't open (E11), and runs the
 * session-start preflight (E14 stage 1). A preflight miss or halt signal throws `depop_halted`.
 * When the sell form redirects to sign-in, it waits for Sam to sign in by hand in that window.
 */
export async function openDepopSession(opts: DepopSessionOptions = {}): Promise<DepopSession> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const site = opts.site ?? depopSite();
  const now = opts.timing?.now ?? Date.now;
  const tickMs = opts.timing?.tickMs ?? 5_000;
  const captureMs = opts.timing?.captureMs ?? CAPTURE_MS;
  const burstMs = opts.timing?.closeBurstMs ?? 1_500;
  const settleMs = opts.timing?.settleMs ?? 2_000;
  const chromePath = opts.chromePath ?? findChrome(); // F5: fail up front, before any lock or launch
  const profileDir = opts.profileDir ?? marketProfileDir("depop");
  const release = await acquireProfileLock(profileDir);

  let chrome: ChromeHandle;
  try {
    chrome = await launchOrAttachChrome({ profileDir, chromePath, headless: opts.headless });
  } catch (e) {
    release();
    throw e;
  }

  let halted: string | null = null;
  let disconnected = false;
  let closing = false;
  const ours = new Set<any>();
  const waiting = new Set<{ watch: TabWatch; wake: () => void }>();
  const closes: number[] = [];
  let homeGone = false;

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    process.off("SIGINT", onSigint);
    await chrome.close();
    release();
  };
  // E9: Ctrl-C closes the Depop Chrome too. Tabs still waiting stay `filling`, which a re-run reads as unknown.
  const onSigint = () => {
    log("Interrupted: closing the Depop Chrome window.");
    void shutdown().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSigint);

  chrome.browser.on("disconnected", () => {
    disconnected = true;
    if (!closing) halt("the Depop Chrome window was closed (or Chrome exited)");
    for (const w of waiting) {
      w.watch.handle({ kind: "window-closed" }, now());
      w.wake();
    }
  });

  const halt = (reason: string) => {
    if (halted) return;
    halted = reason;
    log(`Depop halted: ${reason}. No more tabs will be filled; list the rest by hand (Copy listing).`);
  };

  let home: any;
  let orphansClosed = 0;
  try {
    // E11: open our own tab first (so Chrome keeps a window), then close every tab this run didn't open.
    home = await chrome.context.newPage();
    ours.add(home);
    for (const p of chrome.context.pages()) {
      if (ours.has(p)) continue;
      await p.close().catch(() => undefined);
      orphansClosed++;
    }
    if (orphansClosed) log(`Closed ${orphansClosed} Depop tab(s) left open by an earlier run.`);

    await home.goto(site.sellUrl, { waitUntil: "domcontentloaded" });
    if (isLoginUrl(site, home.url())) {
      log("Sign in to Depop in the Chrome window that just opened; the session starts once the sell form loads.");
      await setBanner(home, "signin", "resell-agent: sign in to Depop here. The session starts once the sell form loads.", "blue");
      // Sign-in may pass through Google or Apple pages; once back on Depop (and settled), go to the sell form.
      let seen = home.url();
      let since = now();
      while (!isSellForm(site, home.url())) {
        if (disconnected) throw new CliError("depop_halted", "The Depop Chrome window closed before sign-in.", "Re-run and sign in.");
        await new Promise((r) => setTimeout(r, 500));
        const url = home.url();
        if (url !== seen) [seen, since] = [url, now()];
        const back = parse(url);
        if (back && onSite(site, back) && !isLoginUrl(site, url) && !isSellForm(site, url) && now() - since >= 3_000) {
          await home.goto(site.sellUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
        }
      }
    }
    const signal = await detectHalt(home);
    if (signal) throw new CliError("depop_halted", `Depop halted at session start: ${signal}.`, "Check the Depop window by hand. List these items by hand (Copy listing) until it's resolved.");
    const missing = await missingBaseControls(home);
    if (missing.length) {
      throw new CliError(
        "depop_halted",
        `Depop preflight: couldn't find the ${missing.join(", ")} field${missing.length > 1 ? "s" : ""} on a blank sell form.`,
        "Depop changed its form. Update DEPOP.selectors in src/depop-fill.ts; list by hand meanwhile."
      );
    }
    await home.goto("about:blank").catch(() => undefined);
    // I1: the home tab closing is the window closing too (macOS keeps Chrome running with no window, and a
    // slow exit can lose the race with `disconnected`), so a lone filled tab closed with it reads as unknown.
    home.on("close", () => {
      if (!closing) homeGone = true;
    });
    await setBanner(home, "home", "resell-agent: Depop session running. Leave this tab open; filled forms open in new tabs.", "blue");
  } catch (e) {
    await shutdown();
    throw e;
  }

  async function screenshot(page: any, ctx: DepopItemContext): Promise<string | null> {
    if (!ctx.logDir) return null;
    try {
      mkdirSync(ctx.logDir, { recursive: true });
      const path = join(ctx.logDir, `error-${stamp()}-depop.png`);
      await page.screenshot({ path, fullPage: true });
      return path;
    } catch {
      return null;
    }
  }

  async function fillTab(ctx: DepopItemContext, listing: ListingDraft, photoPaths: string[]): Promise<BrowserFillOutcome> {
    if (halted) return { status: "error", message: `Depop halted: ${halted}. Not filled.` };
    if (disconnected) return { status: "error", message: "Depop: the Chrome window is gone; re-run to start a new session. Not filled." };
    const checkedAt = now(); // the pre-fill eBay check (O4) ran just before this fill; E12's 10 minutes count from it
    const page = await chrome.context.newPage();
    ours.add(page);

    // ---- fill (no submit can have happened yet: a throw here is an `error`) ----
    let report: FillReport;
    try {
      await page.goto(site.sellUrl, { waitUntil: "domcontentloaded" });
      if (isLoginUrl(site, page.url())) {
        halt(SIGN_IN);
        throw new FillError(SIGN_IN);
      }
      const before = await detectHalt(page);
      if (before) {
        halt(before);
        throw new FillError(`Depop halted: ${before}.`);
      }
      report = await fillDepopForm(page, listing, photoPaths);
      const after = await detectHalt(page);
      if (after) {
        halt(after);
        throw new FillError(`Depop halted: ${after}.`);
      }
    } catch (e) {
      // A half-filled tab is closed so it can't be posted; `error` is re-filled next run.
      const shot = await screenshot(page, ctx);
      await page.close().catch(() => undefined);
      const msg = e instanceof FillError || /^Depop/.test(String((e as Error)?.message)) ? (e as Error).message : `Depop fill failed: ${e instanceof Error ? e.message : String(e)}`;
      return { status: "error", message: `${msg}${shot ? ` Screenshot: ${shot}` : ""}` };
    }

    // ---- wait for Sam (from here on, nothing throws) ----
    const watch = new TabWatch(captureMs);
    let wake = () => {};
    const entry = { watch, wake: () => wake() };
    waiting.add(entry);
    let filled: Record<string, string> = {};
    let edits: Record<string, string> = {};
    let stock: StockWatcher | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const head = report.needsSam.length
        ? `resell-agent: ${ctx.label}. Fill these yourself: ${report.needsSam.join(", ")} (outlined). Then review and click Post.`
        : `resell-agent: ${ctx.label}. Every field is filled; review and click Post.`;
      await setBanner(page, "fill", head, "blue");
      if (ctx.stockUnconfirmed) await setBanner(page, "stock", UNCONFIRMED_BANNER, "amber");
      filled = await readEdits(page).catch(() => ({}));
      edits = filled;

      // S4: Sam may edit before posting. Compared against the latest snapshot (taken every tick) at the
      // create request itself, so the note is in place before the URL can resolve the tab.
      const checkEdits = () => {
        const names = Object.keys(filled).filter((k) => edits[k] !== undefined && edits[k] !== filled[k]);
        if (names.length) watch.note(`Posted values may differ: ${names.join(", ")} edited in the tab.`);
      };
      page.on("request", (req: any) => {
        if (!isCreateRequest(site, req.url(), req.method())) return;
        checkEdits();
        watch.handle({ kind: "create" }, now());
        wake();
      });
      page.on("response", (res: any) => {
        const req = res.request();
        if (!isCreateRequest(site, req.url(), req.method())) return;
        void res
          .json()
          .then((body: unknown) => {
            const url = listingUrlFromCreateBody(site, body);
            if (url) watch.handle({ kind: "listing", url }, now());
          })
          .catch(() => undefined)
          .finally(() => wake());
      });
      page.on("framenavigated", (frame: any) => {
        if (frame !== page.mainFrame()) return;
        const url = frame.url();
        const listingUrl = listingUrlOf(site, url);
        if (listingUrl) watch.handle({ kind: "listing", url: listingUrl }, now());
        else if (isLoginUrl(site, url)) watch.handle({ kind: "login", url }, now());
        else if (!isSellForm(site, url)) watch.handle({ kind: "left", url }, now());
        wake();
      });
      page.on("close", () => {
        if (watch.outcome) return; // the runner closing a resolved tab is not Sam closing one
        const at = now();
        closes.push(at);
        // Wait a moment: closing the window closes every tab at once, and that reads as unknown (S4).
        setTimeout(() => {
          watch.handle({ kind: isWindowClose(at, closes, disconnected || homeGone, burstMs) ? "window-closed" : "closed" }, now());
          wake();
        }, burstMs);
      });

      // C1 fail-safe: a click on Post (or a form submit) is reported from the page, so a create call that
      // doesn't match DEPOP.createRequest still makes a closed tab verify-first.
      await page
        .exposeBinding("__resellPost", () => {
          watch.handle({ kind: "post-clicked" }, now());
          wake();
        })
        .then(() =>
          page.evaluate((selector: string) => {
            const call = () => (window as any).__resellPost?.();
            document.addEventListener("click", (e) => (e.target as Element | null)?.closest?.(selector) && call(), true);
            document.addEventListener("submit", call, true);
          }, DEPOP.selectors.submit)
        )
        .catch((e: unknown) => log(`Depop tab for ${ctx.label}: couldn't watch the Post button (${e instanceof Error ? e.message : e}).`));

      if (ctx.stock) {
        const show = async (b: StockBanner) => {
          await setBanner(page, "stock", b === "sold" ? SOLD_BANNER : b === "unconfirmed" ? UNCONFIRMED_BANNER : null, b === "sold" ? "red" : "amber");
        };
        stock = new StockWatcher(ctx.stock, show, checkedAt, ctx.stockUnconfirmed ? "unconfirmed" : null);
        await page
          .exposeBinding("__resellFocus", () => void stock!.focus(now()))
          .then(() =>
            page.evaluate(() => {
              const call = () => (window as any).__resellFocus?.();
              window.addEventListener("focus", call);
              document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && call());
            })
          )
          .catch(() => undefined);
      }

      timer = setInterval(() => {
        const t = now();
        watch.handle({ kind: "tick" }, t);
        void stock?.tick(t);
        if (!watch.submitSeen && !halted) {
          void readEdits(page).then((v) => (edits = v)).catch(() => undefined);
          void detectHalt(page, false).then((r) => r && halt(r)).catch(() => undefined);
        }
        wake();
      }, tickMs);

      if (disconnected) watch.handle({ kind: "window-closed" }, now());
      while (!watch.outcome) await new Promise<void>((r) => (wake = r));
      // A posted tab stays watched a moment longer, so a double-click's second create is still seen (S4).
      if ("status" in watch.outcome && watch.outcome.status === "published") await new Promise((r) => setTimeout(r, settleMs));
    } catch (e) {
      // Glue failure after the fill: the tab may still be postable, so it is verify-first.
      const why = e instanceof Error ? e.message : String(e);
      watch.handle({ kind: "lost", why }, now());
      log(`Depop tab for ${ctx.label}: ${why}`);
    } finally {
      if (timer) clearInterval(timer);
      waiting.delete(entry);
    }

    const outcome = watch.outcome!;
    if ("halt" in outcome) {
      // Only reachable before any submit, so nothing was posted from this tab.
      halt(outcome.halt);
      await page.close().catch(() => undefined);
      return { status: "error", message: outcome.halt };
    }
    if (outcome.status === "published") await page.close().catch(() => undefined);
    return stock?.soldShown ? { ...outcome, message: `${outcome.message} The SOLD ON EBAY banner was shown while it waited.` } : outcome;
  }

  const forItem = (ctx: DepopItemContext): BrowserSession => ({
    async fill(platform: BrowserMarket, listing: ListingDraft, photoPaths: string[]) {
      if (platform !== "depop") return { status: "error", message: `${platform} assisted fill isn't built yet; use Copy listing.` };
      return fillTab(ctx, listing, photoPaths);
    },
  });

  return {
    forItem,
    fill: (platform, listing, photoPaths) => forItem({ label: listing.title }).fill(platform, listing, photoPaths),
    haltReason: () => halted,
    orphansClosed,
    chrome,
    close: shutdown,
  };
}
