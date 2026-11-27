// The batch runner behind `resell post-batch` and its index behind `resell status --batch`.
//
// Layout: batch/<item>/ holds one item's photos (top level only) and its draft.json;
// batch/<item>/.resell/ holds its run log and error screenshots (D4, E10), which never
// count as photos. batch/batch.json indexes every item's per-market state, rebuilt from
// the drafts. Two phases (O1): the night run publishes eBay unattended and exits; a later
// `--markets depop` run is the interactive Depop session on one long-lived BrowserSession.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { unmappedFields } from "./brain/market-fields.js";
import {
  CliError,
  draftSku,
  newDraftFile,
  postDraft,
  readDraftFile,
  withDraftLock,
  writeDraftFile,
  type DraftFile,
} from "./draft-file.js";
import { buildDraft as pipelineBuildDraft } from "./pipeline.js";
import {
  isBrowserMarket,
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
  renameSync(`${path}.tmp`, path);
}

// ---------- the runner ----------

/** A BrowserSession the runner owns for the whole Depop phase and closes when it ends (E2, E9). */
export interface BatchBrowserSession extends BrowserSession {
  close(): Promise<void>;
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
  now?: () => Date;
}

export interface BatchArgs {
  dir: string;
  /** What publishes this run (default eBay only, the night phase). Intake always drafts BATCH_MARKETS. */
  markets?: Platform[];
  /** eBay policy flags; anything missing falls back to the draft's saved settings, then GUI_DEFAULT_* env. */
  ebay?: Partial<EbayPublishSettings>;
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

/**
 * The browser phase: one session, each eligible item in turn, each fill under the short lock (E7).
 * Task 4 replaces this sequential loop with the rolling window of tabs (E4); the session and
 * per-item postDraft call stay the same.
 */
async function browserPhase(items: BatchItemOutcome[], markets: BrowserMarket[], session: BrowserSession, args: BatchArgs, deps: BatchDeps): Promise<void> {
  for (const item of items) await publishItem(item, markets, args, { browserSession: session }, deps);
}

export async function runBatch(args: BatchArgs, deps: BatchDeps = {}): Promise<BatchOutcome> {
  const markets = args.markets?.length ? [...new Set(args.markets)] : (["ebay"] as Platform[]);
  const unsupported = markets.filter((m) => !BATCH_MARKETS.includes(m));
  if (unsupported.length) {
    throw usage(`post-batch does not publish ${unsupported.join(", ")} yet.`, `Use --markets with: ${BATCH_MARKETS.join(", ")}.`);
  }
  const browserMarkets = markets.filter(isBrowserMarket);
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
  if (browserMarkets.length && ready.length) {
    const session = await deps.openBrowserSession!();
    try {
      await browserPhase(ready, browserMarkets, session, args, deps);
    } finally {
      await session.close();
    }
  }

  const index = writeBatchIndex(args.dir, (deps.now ?? (() => new Date()))());
  const complete = index.items.every(
    (row) => row.intake === "drafted" && markets.every((m) => row.markets.find((r) => r.market === m)?.status === "published")
  );
  return { dir: index.dir, markets, items, index, complete };
}
