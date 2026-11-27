// The batch runner behind `resell post-batch` and its index behind `resell status --batch`.
//
// Layout: batch/<item>/ holds one item's photos (top level only) and its draft.json;
// batch/<item>/.resell/ holds its run log and error screenshots (D4, E10), which never
// count as photos. batch/batch.json indexes every item's per-market state, rebuilt from
// the drafts. Two phases (O1): the night run publishes eBay unattended and exits; a later
// `--markets depop` run is the interactive Depop session on one long-lived BrowserSession.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { unmappedFields } from "./brain/market-fields.js";
import { cfg } from "./config.js";
import type { DepopItemContext, StockState } from "./depop-fill.js";
import { offerStock } from "./ebay/sell.js";
import {
  CliError,
  draftSku,
  newDraftFile,
  postDraft,
  readDraftFile,
  renameReplacing,
  withDraftLock,
  writeDraftFile,
  type DraftFile,
} from "./draft-file.js";
import { buildDraft as pipelineBuildDraft } from "./pipeline.js";
import {
  isBrowserMarket,
  skipReason,
  type BrowserMarket,
  type BrowserSession,
  type EbayPublishSettings,
  type PlatformPublishResult,
  type PublishDeps,
  type PublishStatus,
} from "./publish.js";
import type { DraftBundle, Platform } from "./types.js";

/** C7: intake drafts every enabled market, whatever `--markets` publishes. Poshmark is deferred (D1). */
export const BATCH_MARKETS: Platform[] = ["ebay", "depop"];
export const PHOTO_EXTENSIONS: ReadonlySet<string> = new Set([".jpg", ".jpeg", ".png", ".webp"]);
export const DRAFT_FILE = "draft.json";
export const RESELL_DIR = ".resell";
export const BATCH_INDEX_FILE = "batch.json";
/** E4: filled Depop tabs open at once; `--tabs N` overrides. */
export const DEFAULT_TABS = 3;
const MIN_PRICING_COMPS = 3;

// ---------- photos, SKU id, hold rule ----------

/** E10: an item's photos are the image files at the top level of its folder, sorted by name. `.resell/` never counts. */
export function itemPhotos(itemDir: string): string[] {
  return readdirSync(itemDir, { withFileTypes: true })
    .filter((e) => e.isFile() && PHOTO_EXTENSIONS.has(e.name.slice(e.name.lastIndexOf(".")).toLowerCase()))
    .map((e) => e.name)
    .sort()
    .map((name) => resolve(itemDir, name));
}

/** E8: a stable id from the photos' bytes in name order. It becomes the draft id, so the eBay SKU survives a re-created draft.json. */
export function photoSetId(photoPaths: string[]): string {
  const hash = createHash("sha256");
  for (const p of [...photoPaths].sort((a, b) => (basename(a) < basename(b) ? -1 : basename(a) > basename(b) ? 1 : 0))) {
    hash.update(createHash("sha256").update(readFileSync(p)).digest("hex"));
  }
  return hash.digest("hex");
}

/** O5, C5: why a new draft is held for Sam's review, or null. Comps that did not set the price do not count. */
export function holdReason(bundle: DraftBundle): string | null {
  const reasons: string[] = [];
  const a = bundle.attributes;
  if (a.brand && a.brandInferred) reasons.push(`brand "${a.brand}" is inferred, not read off a label`);
  if (bundle.price.sampleSize < MIN_PRICING_COMPS) reasons.push(`price rests on ${bundle.price.sampleSize} comps (fewer than ${MIN_PRICING_COMPS})`);
  return reasons.length ? `Held for review: ${reasons.join("; ")}. Check it, then \`mark --approve\`.` : null;
}

// ---------- run log (D4) ----------

/** One JSONL line per state change, in `<item>/.resell/run.log`. `none` = no stored entry; `market: null` = the item itself (intake). */
export interface RunLogLine {
  time: string;
  by: "intake" | "post-batch" | "mark";
  market: Platform | null;
  from: PublishStatus | "none" | null;
  to: PublishStatus | "none" | "drafted";
  reason: string;
  url?: string;
}

export function runLogPath(itemDir: string): string {
  return join(itemDir, RESELL_DIR, "run.log");
}

export function appendRunLog(itemDir: string, line: Omit<RunLogLine, "time">, now: Date = new Date()): void {
  mkdirSync(join(itemDir, RESELL_DIR), { recursive: true });
  const entry: RunLogLine = { time: now.toISOString(), ...line };
  appendFileSync(runLogPath(itemDir), JSON.stringify(entry) + "\n");
}

// ---------- index (batch.json) ----------

export type BatchFlag = "unknown" | "held" | "unmapped";

export interface BatchMarketRow {
  market: Platform;
  status: PublishStatus | "none";
  message: string | null;
  url: string | null;
  /** Depop fields Sam must fill by hand (Task 2's `unmappedFields`). */
  unmapped: string[];
  /** `unknown` covers a `filling` too: with no runner alive, it reads as unknown. */
  flags: BatchFlag[];
}

export interface BatchItemRow {
  item: string;
  dir: string;
  draft: string | null;
  sku: string | null;
  /** `pending`: photos but no draft.json yet; `error`: no photos, or an unreadable draft.json. */
  intake: "drafted" | "pending" | "error";
  error: string | null;
  markets: BatchMarketRow[];
}

export interface BatchIndex {
  version: 1;
  dir: string;
  updated: string;
  items: BatchItemRow[];
}

function usage(message: string, hint: string): CliError {
  return new CliError("usage", message, hint, 2);
}

/** S4: the batch dir must exist and hold at least one item subfolder (dot-folders are not items). */
export function listItemDirs(dir: string): string[] {
  const root = resolve(dir);
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    /* missing */
  }
  const hint = "Pass a folder with one subfolder of photos per item: <dir>/<item>/*.jpg.";
  if (!isDir) throw usage(`Batch folder not found: ${root}`, hint);
  const items = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort()
    .map((name) => join(root, name));
  if (!items.length) throw usage(`${root} has no item subfolders.`, `${hint} Loose photos are not grouped in this version.`);
  return items;
}

function noPhotosMessage(itemDir: string): string {
  return `No photos in ${itemDir} (top-level ${[...PHOTO_EXTENSIONS].join(", ")}).`;
}

function unreadableMessage(e: unknown): string {
  return `draft.json is unreadable and is never overwritten; fix or delete it: ${e instanceof Error ? e.message : e}`;
}

function marketRows(file: DraftFile): BatchMarketRow[] {
  const stored = new Map(file.publishResults.map((r) => [r.platform, r]));
  const markets = [...new Set([...file.listings.map((l) => l.platform), ...stored.keys()])];
  return markets.map((market) => {
    const r = stored.get(market);
    const status = r?.status ?? "none";
    const listing = file.listings.find((l) => l.platform === market);
    const unmapped = listing ? unmappedFields(listing) : [];
    const flags: BatchFlag[] = [];
    if (status === "unknown" || status === "filling") flags.push("unknown");
    if (status === "held") flags.push("held");
    if (unmapped.length) flags.push("unmapped");
    return { market, status, message: r?.message ?? null, url: r?.url ?? null, unmapped, flags };
  });
}

function itemRow(itemDir: string): BatchItemRow {
  const row: BatchItemRow = { item: basename(itemDir), dir: itemDir, draft: null, sku: null, intake: "pending", error: null, markets: [] };
  if (!itemPhotos(itemDir).length) return { ...row, intake: "error", error: noPhotosMessage(itemDir) };
  const draft = join(itemDir, DRAFT_FILE);
  if (!existsSync(draft)) return row;
  try {
    const file = readDraftFile(draft);
    const hasEbay = file.listings.some((l) => l.platform === "ebay");
    return { ...row, draft, sku: hasEbay ? draftSku(file) : null, intake: "drafted", markets: marketRows(file) };
  } catch (e) {
    return { ...row, draft, intake: "error", error: unreadableMessage(e) };
  }
}

/** The index, rebuilt from the drafts on disk. Read-only. */
export function buildBatchIndex(dir: string, now: Date = new Date()): BatchIndex {
  return { version: 1, dir: resolve(dir), updated: now.toISOString(), items: listItemDirs(dir).map(itemRow) };
}

/** Rebuilds the index and writes it to `<dir>/batch.json`. */
export function writeBatchIndex(dir: string, now: Date = new Date()): BatchIndex {
  const index = buildBatchIndex(dir, now);
  writeFileAtomic(join(resolve(dir), BATCH_INDEX_FILE), JSON.stringify(index, null, 2));
  return index;
}

/** Same tmp + rename as writeDraftFile, so a reader never sees half an index. */
function writeFileAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameReplacing(`${path}.tmp`, path);
}

// ---------- the runner ----------

/** A BrowserSession the runner owns for the whole Depop phase and closes when it ends (E2, E9). */
export interface BatchBrowserSession extends BrowserSession {
  close(): Promise<void>;
  /** Binds a fill to its item: the `.resell` folder for screenshots, the banner label, the eBay re-check. */
  forItem?(ctx: DepopItemContext): BrowserSession;
  /** Set once the market halted (S2 halt rules): no further tab is filled, nothing retries. */
  haltReason?(): string | null;
}

export interface BatchDeps {
  /** The model pipeline; tests inject a fake. */
  buildDraft?: (photoPaths: string[], notes: string, platforms?: Platform[]) => Promise<DraftBundle>;
  /** eBay seam for tests. */
  publish?: Pick<PublishDeps, "publishEbay">;
  /**
   * Opens the Depop session for the browser phase. Task 4 supplies the real one (installed Chrome over CDP).
   * Without it, a run that asks for a browser market fails with `depop_unavailable` before any work.
   */
  openBrowserSession?: () => Promise<BatchBrowserSession>;
  /** O4, E12: the item's eBay listing state; null when it has no live eBay listing to check. Default: the eBay offer lookup. */
  ebayStock?: (file: DraftFile) => Promise<StockState | null>;
  now?: () => Date;
}

export interface BatchArgs {
  dir: string;
  /** What publishes this run (default eBay only, the night phase). Intake always drafts BATCH_MARKETS. */
  markets?: Platform[];
  /** eBay policy flags; anything missing falls back to the draft's saved settings, then GUI_DEFAULT_* env. */
  ebay?: Partial<EbayPublishSettings>;
  /** E4: at most this many filled Depop tabs at once (default 3). */
  tabs?: number;
}

export interface BatchItemOutcome {
  item: string;
  dir: string;
  draft: string;
  intake: "created" | "resumed" | "error";
  /** An intake error (no photos, unreadable draft, drafting failed), or a run error (e.g. the draft was locked). */
  error: string | null;
  /** This run's per-market results (`skipped` included); the stored state is in the index. */
  results: PlatformPublishResult[];
}

export interface BatchOutcome {
  dir: string;
  markets: Platform[];
  items: BatchItemOutcome[];
  index: BatchIndex;
  /** O9: every item drafted and every requested market stored `published`. Held, unknown and error rows are incomplete. */
  complete: boolean;
  /** Why the Depop market halted this run (S2), or why its session never opened (F5, E14); null if it didn't. */
  halted: string | null;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** O2: create draft.json only when absent; otherwise resume it. An unreadable one is an error row and is never written. */
async function intakeItem(itemDir: string, deps: BatchDeps): Promise<BatchItemOutcome> {
  const now = deps.now ?? (() => new Date());
  const draft = join(itemDir, DRAFT_FILE);
  const out: BatchItemOutcome = { item: basename(itemDir), dir: itemDir, draft, intake: "error", error: null, results: [] };
  const fail = (error: string): BatchItemOutcome => {
    appendRunLog(itemDir, { by: "intake", market: null, from: null, to: "error", reason: error }, now());
    return { ...out, error };
  };
  const resume = (): BatchItemOutcome => {
    try {
      readDraftFile(draft);
      return { ...out, intake: "resumed" };
    } catch (e) {
      return fail(unreadableMessage(e));
    }
  };

  const photos = itemPhotos(itemDir);
  if (!photos.length) return fail(noPhotosMessage(itemDir));
  if (existsSync(draft)) return resume();

  let bundle: DraftBundle;
  try {
    bundle = await (deps.buildDraft ?? pipelineBuildDraft)(photos, "", BATCH_MARKETS);
  } catch (e) {
    return fail(`Drafting failed: ${errorText(e)}`);
  }
  try {
    return await withDraftLock(draft, async () => {
      if (existsSync(draft)) return resume(); // another run created it while this one drafted
      const file = newDraftFile(bundle, photos);
      file.draftId = photoSetId(photos);
      const hold = holdReason(bundle);
      if (hold) file.publishResults = BATCH_MARKETS.map((platform) => ({ platform, status: "held" as const, message: hold }));
      writeDraftFile(draft, file);
      const t = now();
      appendRunLog(itemDir, { by: "intake", market: null, from: null, to: "drafted", reason: `Drafted from ${photos.length} photo(s); eBay SKU ${draftSku(file)}.` }, t);
      for (const r of file.publishResults) appendRunLog(itemDir, { by: "intake", market: r.platform, from: "none", to: r.status, reason: r.message }, t);
      return { ...out, intake: "created" };
    });
  } catch (e) {
    return fail(errorText(e));
  }
}

/** One postDraft per item; every non-skipped result is a run-log line. A throw (e.g. `draft_locked`) is an item error for this run. */
async function publishItem(item: BatchItemOutcome, platforms: Platform[], args: BatchArgs, publishDeps: PublishDeps, deps: BatchDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  let before: Map<Platform, PlatformPublishResult>;
  try {
    before = new Map(readDraftFile(item.draft).publishResults.map((r) => [r.platform, r]));
    const outcome = await postDraft({ draftPath: item.draft, platforms, ebay: args.ebay }, publishDeps);
    item.results.push(...outcome.results);
  } catch (e) {
    item.error = errorText(e);
    return;
  }
  for (const r of item.results.filter((x) => platforms.includes(x.platform) && x.status !== "skipped")) {
    appendRunLog(
      item.dir,
      { by: "post-batch", market: r.platform, from: before.get(r.platform)?.status ?? "none", to: r.status, reason: r.message, ...(r.url ? { url: r.url } : {}) },
      now()
    );
  }
}

/** O4: the item's live eBay listing state, from its stored eBay offer; null when there is none here to check. */
export async function draftEbayStock(file: DraftFile): Promise<StockState | null> {
  const ebay = file.publishResults.find((r) => r.platform === "ebay");
  if (ebay?.status !== "published" || !ebay.offerId) return null;
  const env = cfg.env === "production" ? "production" : "sandbox";
  if (ebay.env && ebay.env !== env) return null; // a sandbox listing is not stock in production
  return offerStock(ebay.offerId);
}

export type PrefillStock =
  | { sold: string }
  | { stock?: () => Promise<StockState>; stockUnconfirmed?: true };

/**
 * O4 before a Depop fill: a sold or ended eBay listing means no fill (`sold` carries the skip message);
 * otherwise the re-check to run while the tab waits (E12), flagged unconfirmed when this check failed.
 */
export async function prefillStock(
  results: PlatformPublishResult[],
  market: BrowserMarket,
  check: (results: PlatformPublishResult[]) => Promise<StockState | null> = (r) => draftEbayStock({ publishResults: r } as DraftFile)
): Promise<PrefillStock> {
  const recheck = () => check(results).then((s) => s ?? "active");
  try {
    const state = await check(results);
    if (state === "sold" || state === "ended") return { sold: `Skipped: sold on eBay (the eBay listing is ${state}); not filled on ${market}.` };
    return state ? { stock: recheck } : {};
  } catch {
    return { stock: recheck, stockUnconfirmed: true }; // the tab opens with "couldn't confirm eBay stock"
  }
}

/** A market not filled this run (halted, or sold on eBay): reported and logged; nothing is stored. */
function skipItem(item: BatchItemOutcome, market: BrowserMarket, message: string, deps: BatchDeps): void {
  let stored: PublishStatus | undefined;
  try {
    stored = readDraftFile(item.draft).publishResults.find((r) => r.platform === market)?.status;
  } catch {
    stored = undefined;
  }
  item.results.push({ platform: market, status: "skipped", message });
  appendRunLog(item.dir, { by: "post-batch", market, from: stored ?? "none", to: "skipped", reason: message }, (deps.now ?? (() => new Date()))());
}

function errorWithHint(e: unknown): string {
  return e instanceof CliError && e.hint ? `${e.message} ${e.hint}` : errorText(e);
}

/**
 * The browser phase on one session (E2) with a rolling window of `tabs` filled tabs (E4): each slot
 * fills an item and waits for Sam; when he posts or closes it, the slot takes the next item. Each
 * fill locks its draft only to write (E7). Before a fill, the item's eBay listing is checked (O4).
 * Chrome starts only once an item actually needs a fill. Returns why the market halted, if it did.
 */
async function browserPhase(items: BatchItemOutcome[], market: BrowserMarket, args: BatchArgs, deps: BatchDeps): Promise<string | null> {
  const check = deps.ebayStock ?? draftEbayStock;
  let session: BatchBrowserSession | null = null;
  let opening: Promise<BatchBrowserSession> | null = null;
  let halted: string | null = null;
  const queue = [...items];
  // A held, published or verify-first market never reaches a tab: postDraft just reports the skip.
  const noTab: BrowserSession = { fill: async () => ({ status: "error", message: `${market} was not eligible for a fill.` }) };

  const one = async (item: BatchItemOutcome): Promise<void> => {
    halted ??= session?.haltReason?.() ?? null;
    if (halted) return skipItem(item, market, `Depop halted: ${halted} Not filled; list it by hand (Copy listing), or re-run once it's resolved.`, deps);
    let file: DraftFile;
    try {
      file = readDraftFile(item.draft);
    } catch (e) {
      item.error = errorText(e);
      return;
    }
    const stored = file.publishResults.find((r) => r.platform === market);
    if (skipReason(market, stored) || !file.listings.some((l) => l.platform === market)) {
      return publishItem(item, [market], args, { browserSession: noTab }, deps);
    }

    const stock = await prefillStock(file.publishResults, market, () => check(file));
    if ("sold" in stock) return skipItem(item, market, stock.sold, deps);

    try {
      session ??= await (opening ??= deps.openBrowserSession!());
    } catch (e) {
      halted ??= errorWithHint(e);
      return skipItem(item, market, `Depop halted: ${halted}`, deps);
    }
    const ctx: DepopItemContext = { label: item.item, logDir: join(item.dir, RESELL_DIR), ...stock };
    await publishItem(item, [market], args, { browserSession: session.forItem?.(ctx) ?? session }, deps);
    halted ??= session.haltReason?.() ?? null;
  };

  const slot = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) await one(item);
  };
  try {
    await Promise.all(Array.from({ length: Math.min(args.tabs ?? DEFAULT_TABS, items.length) }, slot));
  } finally {
    await (session as BatchBrowserSession | null)?.close();
  }
  return halted;
}

export async function runBatch(args: BatchArgs, deps: BatchDeps = {}): Promise<BatchOutcome> {
  const markets = args.markets?.length ? [...new Set(args.markets)] : (["ebay"] as Platform[]);
  const unsupported = markets.filter((m) => !BATCH_MARKETS.includes(m));
  if (unsupported.length) {
    throw usage(`post-batch does not publish ${unsupported.join(", ")} yet.`, `Use --markets with: ${BATCH_MARKETS.join(", ")}.`);
  }
  const browserMarkets = markets.filter(isBrowserMarket);
  if (args.tabs !== undefined && (!Number.isInteger(args.tabs) || args.tabs < 1)) {
    throw usage(`--tabs must be a whole number of 1 or more (got ${args.tabs}).`, `Default ${DEFAULT_TABS}: ${DEFAULT_TABS} filled Depop tabs at once.`);
  }
  if (browserMarkets.length && !deps.openBrowserSession) {
    throw new CliError(
      "depop_unavailable",
      "Depop fill isn't available in this version of resell yet.",
      "Run the night phase (`post-batch <dir>`, eBay) now; list Depop by hand from the draft for the moment.",
      2
    );
  }
  const dirs = listItemDirs(args.dir);

  const items: BatchItemOutcome[] = [];
  for (const dir of dirs) items.push(await intakeItem(dir, deps));
  const ready = items.filter((i) => i.intake !== "error");

  if (markets.includes("ebay")) {
    for (const item of ready) await publishItem(item, ["ebay"], args, deps.publish ?? {}, deps);
  }
  let halted: string | null = null;
  for (const market of browserMarkets) {
    if (ready.length) halted ??= await browserPhase(ready, market, args, deps);
  }

  const index = writeBatchIndex(args.dir, (deps.now ?? (() => new Date()))());
  const complete = index.items.every(
    (row) => row.intake === "drafted" && markets.every((m) => row.markets.find((r) => r.market === m)?.status === "published")
  );
  return { dir: index.dir, markets, items, index, complete, halted };
}
