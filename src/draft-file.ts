// The on-disk draft the CLI writes and posts from. A DraftBundle plus what a
// retry needs: a stable id (stable eBay SKU), the photo paths (Depop fills
// upload them), the last eBay settings, and every platform's publish result.
// Same retry contract as the GUI: a platform already published is skipped.

import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  isBrowserMarket,
  isPublishComplete,
  mergePublishResults,
  publishDraftBundle,
  skipReason,
  type BeginFillOutcome,
  type BrowserMarket,
  type EbayPublishSettings,
  type FillRecorder,
  type PlatformPublishResult,
  type PublishDeps,
  type PublishStatus,
} from "./publish.js";
import { GUI_PLATFORMS, stableGuiSku } from "./gui-validation.js";
import type { DraftBundle, Platform } from "./types.js";

export interface DraftFile extends DraftBundle {
  draftId: string;
  photos: string[];
  ebay?: EbayPublishSettings;
  publishResults: PlatformPublishResult[];
}

/** An error with a stable machine-readable code and a fix an agent can act on. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly exitCode = 1
  ) {
    super(message);
  }
}

export function newDraftFile(bundle: DraftBundle, photos: string[]): DraftFile {
  return { ...bundle, draftId: randomUUID(), photos: photos.map((p) => resolve(p)), publishResults: [] };
}

export function readDraftFile(path: string): DraftFile {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CliError("draft_unreadable", `Cannot read draft ${path}: ${e instanceof Error ? e.message : e}`, "Run `draft` first, or pass --draft <path>.");
  }
  if (!raw || !Array.isArray(raw.listings)) {
    throw new CliError("draft_invalid", `${path} is not a draft file (no listings).`, "Pass a draft.json written by the `draft` command.");
  }
  return {
    ...raw,
    // Drafts written before these fields existed get them on first post.
    draftId: typeof raw.draftId === "string" && raw.draftId ? raw.draftId : randomUUID(),
    photos: Array.isArray(raw.photos) ? raw.photos : [],
    publishResults: Array.isArray(raw.publishResults) ? raw.publishResults : [],
  };
}

export function writeDraftFile(path: string, draft: DraftFile): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(draft, null, 2));
  renameReplacing(tmp, path);
}

/**
 * tmp -> final rename. On Windows the rename fails with EPERM/EBUSY/EACCES while another process (a virus
 * scanner, an indexer, a reader) briefly holds the destination, so it retries for up to about a second.
 */
export function renameReplacing(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e: any) {
      if (attempt >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(e?.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

export interface DraftLockOptions {
  /** How long to keep retrying a live lock; 0 (the default) fails at once with `draft_locked`. */
  waitMs?: number;
  /** Injectable for tests: the clock and sleep that pace the wait. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** How long a Depop fill's result write waits for the draft lock before reporting the result unrecorded (C2). */
export const FILL_RESULT_WAIT_MS = 30_000;
const LOCK_POLL_MS = 250;
/** A lock file from before O8 holds no pid, so it is judged by age. */
const LEGACY_LOCK_STALE_MS = 10 * 60_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM"; // exists, owned by someone else
  }
}

function lockPid(raw: string): number | null {
  try {
    const pid = JSON.parse(raw)?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** O8: a lock is stale when its pid is dead, or (old empty format) when it is older than 10 minutes. */
function lockState(lock: string): "live" | "stale" | "gone" {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(lock, "utf8");
    mtimeMs = statSync(lock).mtimeMs;
  } catch (e: any) {
    if (e?.code === "ENOENT") return "gone";
    throw e;
  }
  const pid = lockPid(raw);
  if (pid !== null) return pidAlive(pid) ? "live" : "stale";
  // Also covers the instant between another holder's create and its pid write: fresh, so live.
  return Date.now() - mtimeMs > LEGACY_LOCK_STALE_MS ? "stale" : "live";
}

async function acquireDraftLock(lock: string, opts: DraftLockOptions): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const deadline = now() + (opts.waitMs ?? 0);
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, time: Date.now() }));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }
    const state = lockState(lock);
    if (state === "stale") {
      try {
        unlinkSync(lock);
      } catch (e: any) {
        if (e?.code !== "ENOENT") throw e;
      }
      continue;
    }
    if (state === "gone") continue;
    const left = deadline - now();
    if (left <= 0) return false;
    await sleep(Math.min(LOCK_POLL_MS, left));
  }
}

/** The same pid-and-time lock for any file (the Depop profile's one-runner lock): true when acquired. */
export function acquireLockFile(lock: string, opts: DraftLockOptions = {}): Promise<boolean> {
  return acquireDraftLock(lock, opts);
}

export function releaseLockFile(lock: string): void {
  try {
    unlinkSync(lock);
  } catch {
    /* already gone */
  }
}

/** One writer per draft at a time, across processes (two agents, agent + retry, or a fill + `mark`). */
export async function withDraftLock<T>(path: string, fn: () => Promise<T>, opts: DraftLockOptions = {}): Promise<T> {
  const lock = `${path}.lock`;
  if (!(await acquireDraftLock(lock, opts))) {
    throw new CliError(
      "draft_locked",
      `${path} is already being published.`,
      `Wait for that run. A lock left by a run that died clears itself; if ${lock} persists, delete it.`
    );
  }
  try {
    return await fn();
  } finally {
    releaseLockFile(lock);
  }
}

/**
 * E7: lock, re-read, write `filling` with a fresh attempt id, unlock. The tab's wait then runs unlocked.
 * The skip rule is applied again to the stored entry under the lock: the caller decided from an older
 * read (possibly hours old, behind another market's wait), so a `published`, `unknown`, `filling` or
 * `held` set since then is reported as a skip and never overwritten.
 */
export async function beginFill(draftPath: string, platform: BrowserMarket, lock: DraftLockOptions = {}): Promise<BeginFillOutcome> {
  return withDraftLock(
    draftPath,
    async () => {
      const file = readDraftFile(draftPath);
      const stored = file.publishResults.find((r) => r.platform === platform);
      const skip = skipReason(platform, stored);
      if (skip) return { skipped: { ...stored!, status: "skipped" as const, message: skip } };
      const attemptId = randomUUID();
      file.publishResults = mergePublishResults(file.publishResults, [
        { platform, status: "filling", message: `${platform} tab filled; waiting for Post.`, attemptId },
      ]);
      writeDraftFile(draftPath, file);
      return { attemptId };
    },
    lock
  );
}

export type FinishFillOutcome =
  | { recorded: true; result: PlatformPublishResult }
  /** Not written: the caller keeps `result` in the run log; the stored `filling` reads as `unknown` next run. */
  | { recorded: false; result: PlatformPublishResult; reason: string };

function verifyFirst(platform: BrowserMarket, attemptId: string, result: PlatformPublishResult, why: string): PlatformPublishResult {
  return {
    platform,
    status: "unknown",
    message: `${platform} tab ended ${result.status}, but ${why}. Verify the listing, then mark it posted or not posted. ${result.message}`.trim(),
    url: result.url,
    attemptId,
  };
}

/** Which entry a finished fill leaves on disk, given the entry stored now (E7, E11). */
function settleFill(
  platform: BrowserMarket,
  stored: PlatformPublishResult | undefined,
  attemptId: string,
  result: PlatformPublishResult,
  submitSeen: boolean
): PlatformPublishResult {
  if (stored?.status === "filling" && stored.attemptId === attemptId) return { ...result, attemptId };
  // Settled during the wait (Sam's `mark`, or a later attempt's result): it stands unless this tab saw a submit.
  if (stored && stored.status !== "filling") {
    return submitSeen ? verifyFirst(platform, attemptId, result, `the entry was set to ${stored.status} during the wait`) : stored;
  }
  return verifyFirst(platform, attemptId, result, "a different fill attempt owns the stored entry");
}

/** E7, C2: wait up to 30 s for the lock, re-read the file, and merge only this market's result. Never throws the result away. */
export async function finishFill(
  draftPath: string,
  platform: BrowserMarket,
  attemptId: string,
  result: PlatformPublishResult,
  opts: { submitSeen: boolean; lock?: DraftLockOptions }
): Promise<FinishFillOutcome> {
  try {
    return await withDraftLock(
      draftPath,
      async () => {
        const file = readDraftFile(draftPath);
        const stored = file.publishResults.find((r) => r.platform === platform);
        const settled = settleFill(platform, stored, attemptId, result, opts.submitSeen);
        file.publishResults = mergePublishResults(file.publishResults, [settled]);
        writeDraftFile(draftPath, file);
        return { recorded: true as const, result: settled };
      },
      { waitMs: FILL_RESULT_WAIT_MS, ...opts.lock }
    );
  } catch (e) {
    return { recorded: false, result, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Binds the fill helpers to one draft file for `publishDraftBundle`. */
function draftFillRecorder(draftPath: string, lock: DraftLockOptions = {}): FillRecorder {
  return {
    begin: (platform) => beginFill(draftPath, platform, { waitMs: FILL_RESULT_WAIT_MS, ...lock }),
    finish: async (platform, attemptId, result, { submitSeen }) => {
      const out = await finishFill(draftPath, platform, attemptId, result, { submitSeen, lock });
      if (out.recorded) return out.result;
      return {
        ...result,
        status: "unknown",
        message: `${platform} result not recorded (${out.reason}); the draft still reads filling, so verify it. Tab ended ${result.status}: ${result.message}`,
      };
    },
  };
}

export function parsePlatforms(value: string | undefined): Platform[] | undefined {
  if (value === undefined) return undefined;
  const list = value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((p) => !GUI_PLATFORMS.includes(p as Platform));
  if (!list.length || bad.length) {
    throw new CliError("usage", `Unknown platform(s): ${bad.join(", ") || "(none given)"}`, `Use any of: ${GUI_PLATFORMS.join(", ")}.`, 2);
  }
  return [...new Set(list)] as Platform[];
}

export interface PostArgs {
  draftPath: string;
  platforms?: Platform[];
  /** Flag values; anything missing falls back to the draft's last settings, then GUI_DEFAULT_* env. */
  ebay?: Partial<EbayPublishSettings>;
  /** Lock-wait pacing for session fills; tests inject a clock. */
  fillLock?: DraftLockOptions;
}

function pick<T>(...values: (T | undefined)[]): T | undefined {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    if (Array.isArray(v) && !v.length) continue;
    return v;
  }
  return undefined;
}

export function resolveEbaySettings(
  flags: Partial<EbayPublishSettings> = {},
  saved: EbayPublishSettings | undefined,
  env: NodeJS.ProcessEnv = process.env
): EbayPublishSettings {
  return {
    sku: pick(flags.sku, saved?.sku),
    imageUrls: pick(flags.imageUrls, saved?.imageUrls) ?? [],
    quantity: pick(flags.quantity, saved?.quantity),
    categoryId: pick(flags.categoryId, saved?.categoryId),
    merchantLocationKey: pick(flags.merchantLocationKey, saved?.merchantLocationKey, env.GUI_DEFAULT_MERCHANT_LOCATION_KEY) ?? "",
    fulfillmentPolicyId: pick(flags.fulfillmentPolicyId, saved?.fulfillmentPolicyId, env.GUI_DEFAULT_FULFILLMENT_POLICY_ID) ?? "",
    paymentPolicyId: pick(flags.paymentPolicyId, saved?.paymentPolicyId, env.GUI_DEFAULT_PAYMENT_POLICY_ID) ?? "",
    returnPolicyId: pick(flags.returnPolicyId, saved?.returnPolicyId, env.GUI_DEFAULT_RETURN_POLICY_ID) ?? "",
  };
}

export interface PostOutcome {
  draftId: string;
  results: PlatformPublishResult[];
  publishResults: PlatformPublishResult[];
  complete: boolean;
}

/** The eBay SKU this draft publishes under: an explicit `ebay.sku`, else the stable id (same rule as `runPublish`). */
export function draftSku(file: DraftFile, prefix = process.env.GUI_DEFAULT_SKU ?? ""): string {
  return file.ebay?.sku?.trim() || stableGuiSku(file.draftId, prefix);
}

function runPublish(file: DraftFile, platforms: Platform[], ebay: EbayPublishSettings | undefined, deps: PublishDeps) {
  return publishDraftBundle(
    {
      draft: file,
      photoPaths: file.photos,
      platforms,
      ebay,
      // An explicit --sku is the stable id; otherwise derive one from the draft.
      draftId: ebay?.sku ? undefined : file.draftId,
      guiSkuPrefix: process.env.GUI_DEFAULT_SKU ?? "",
      previousResults: file.publishResults,
    },
    deps
  );
}

/**
 * Without a `browserSession`, every market runs under one draft lock, as before.
 * With one, browser markets run after that lock is released: each fill locks only
 * to write `filling` and again to merge its result (E7), so a tab can wait for hours.
 * `complete` comes from the merged state of the requested markets (O9).
 */
export async function postDraft(args: PostArgs, deps: PublishDeps = {}): Promise<PostOutcome> {
  const session = deps.browserSession;
  const locked = await withDraftLock(args.draftPath, async () => {
    const file = readDraftFile(args.draftPath);
    const platforms = args.platforms ?? [...new Set(file.listings.map((l) => l.platform))];
    const ebay = platforms.includes("ebay") ? resolveEbaySettings(args.ebay, file.ebay) : undefined;
    if (ebay) file.ebay = ebay;
    // Persist the id and settings before anything reaches a platform, so a
    // crash mid-publish still retries under the same SKU.
    writeDraftFile(args.draftPath, file);

    const now = session ? platforms.filter((p) => !isBrowserMarket(p)) : platforms;
    const run = now.length ? (await runPublish(file, now, ebay, deps)).results : [];
    file.publishResults = mergePublishResults(file.publishResults, run);
    writeDraftFile(args.draftPath, file);
    return { file, platforms, ebay, results: run };
  });

  const { platforms, ebay } = locked;
  let file = locked.file;
  const results = [...locked.results];
  const waiting = session ? platforms.filter(isBrowserMarket) : [];
  if (waiting.length) {
    const run = await runPublish(file, waiting, ebay, { ...deps, fillRecorder: draftFillRecorder(args.draftPath, args.fillLock) });
    results.push(...run.results);
    // Fills recorded their own results. The rest (no listing, no photos, a failed begin, skips) merge into
    // the latest file, but never over a state set since the first read that a re-run must honor (the same
    // skip rule beginFill applies). If the lock stays busy they are dropped, which is safe for the same reason.
    const unfilled = run.results.filter((r) => r.attemptId === undefined);
    if (unfilled.length) {
      await withDraftLock(
        args.draftPath,
        async () => {
          const latest = readDraftFile(args.draftPath);
          const stored = new Map(latest.publishResults.map((r) => [r.platform, r]));
          const writable = unfilled.filter((r) => !skipReason(r.platform, stored.get(r.platform)));
          latest.publishResults = mergePublishResults(latest.publishResults, writable);
          writeDraftFile(args.draftPath, latest);
        },
        { waitMs: FILL_RESULT_WAIT_MS, ...args.fillLock }
      ).catch((e) => {
        if (!(e instanceof CliError && e.code === "draft_locked")) throw e;
      });
    }
    file = readDraftFile(args.draftPath);
    results.sort((a, b) => platforms.indexOf(a.platform) - platforms.indexOf(b.platform));
  }
  return {
    draftId: file.draftId,
    results,
    publishResults: file.publishResults,
    complete: isPublishComplete(file.publishResults, platforms),
  };
}

/** How long `mark` waits for the draft lock; an eBay publish can hold it while photos upload. */
export const MARK_LOCK_WAIT_MS = 30_000;

/** Sam's hand resolution of a draft's state (D3, O5). `posted` and `not_posted` apply to browser markets only (D6). */
export type MarkAction =
  | { kind: "posted"; market: BrowserMarket; url: string }
  | { kind: "not_posted"; market: BrowserMarket }
  | { kind: "approve" };

/** One state change a mark made; `none` means no stored entry. */
export interface MarkChange {
  market: Platform;
  from: PublishStatus | "none";
  to: PublishStatus | "none";
  message: string;
  url?: string;
}

function invalidTransition(message: string, hint: string): CliError {
  return new CliError("invalid_transition", message, hint);
}

/**
 * The mark transitions, on the stored results (pure):
 * - `posted`: any state but `published` -> `published` with the URL (resolves `unknown`, a stale `filling`, ...).
 * - `not_posted`: any state but `published` or `held` -> `not_posted`, which the next session fills again.
 * - `approve`: every `held` entry is removed, so each market is eligible again; nothing held is a no-op.
 * `published` is final: no mark changes it.
 */
export function applyMark(results: PlatformPublishResult[], action: MarkAction): { publishResults: PlatformPublishResult[]; changes: MarkChange[] } {
  if (action.kind === "approve") {
    const changes = results
      .filter((r) => r.status === "held")
      .map((r): MarkChange => ({ market: r.platform, from: "held", to: "none", message: "Approved by hand; eligible to publish." }));
    return { publishResults: results.filter((r) => r.status !== "held"), changes };
  }
  const { market } = action;
  const stored = results.find((r) => r.platform === market);
  if (stored?.status === "published") {
    throw invalidTransition(
      `${market} is already published${stored.url ? ` (${stored.url})` : ""}; a published market is final.`,
      "Nothing to mark. If the listing was removed, handle it on the site."
    );
  }
  let next: PlatformPublishResult;
  if (action.kind === "posted") {
    next = { platform: market, status: "published", message: "Marked posted by hand.", url: action.url };
  } else {
    if (stored?.status === "held") {
      throw invalidTransition(`${market} is held for review.`, "Release the draft with `mark --approve` first.");
    }
    next = { platform: market, status: "not_posted", message: "Marked not posted by hand; the next session fills it again." };
  }
  return {
    publishResults: mergePublishResults(results, [next]),
    changes: [{ market, from: stored?.status ?? "none", to: next.status, message: next.message, url: next.url }],
  };
}

/** `resell mark`: applies one mark under the draft lock (taken briefly, so a waiting Depop tab never blocks it, E7). */
export async function markDraft(
  draftPath: string,
  action: MarkAction,
  lock: DraftLockOptions = { waitMs: MARK_LOCK_WAIT_MS }
): Promise<{ publishResults: PlatformPublishResult[]; changes: MarkChange[] }> {
  return withDraftLock(
    draftPath,
    async () => {
      const file = readDraftFile(draftPath);
      const out = applyMark(file.publishResults, action);
      if (out.changes.length) {
        file.publishResults = out.publishResults;
        writeDraftFile(draftPath, file);
      }
      return out;
    },
    lock
  );
}
