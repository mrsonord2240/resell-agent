// The on-disk draft the CLI writes and posts from. A DraftBundle plus what a
// retry needs: a stable id (stable eBay SKU), the photo paths (browser flows
// upload them), the last eBay settings, and every platform's publish result.
// Same retry contract as the GUI: a platform already published is skipped.

import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  mergePublishResults,
  publishDraftBundle,
  type EbayPublishSettings,
  type PlatformPublishResult,
  type PublishDeps,
} from "./publish.js";
import { GUI_PLATFORMS } from "./gui-validation.js";
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
  renameSync(tmp, path);
}

/** One publish per draft at a time, across processes (two agents, or agent + retry). */
export async function withDraftLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  try {
    closeSync(openSync(lock, "wx"));
  } catch (e: any) {
    if (e?.code === "EEXIST") {
      throw new CliError(
        "draft_locked",
        `${path} is already being published.`,
        `Wait for that run. If no run is active (a crash), delete ${lock}.`
      );
    }
    throw e;
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
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
  headful?: boolean;
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

export async function postDraft(args: PostArgs, deps: PublishDeps = {}): Promise<PostOutcome> {
  return withDraftLock(args.draftPath, async () => {
    const file = readDraftFile(args.draftPath);
    const platforms = args.platforms ?? [...new Set(file.listings.map((l) => l.platform))];
    const ebay = platforms.includes("ebay") ? resolveEbaySettings(args.ebay, file.ebay) : undefined;
    if (ebay) file.ebay = ebay;
    // Persist the id and settings before anything reaches a platform, so a
    // crash mid-publish still retries under the same SKU.
    writeDraftFile(args.draftPath, file);

    const run = await publishDraftBundle(
      {
        draft: file,
        photoPaths: file.photos,
        platforms,
        ebay,
        // An explicit --sku is the stable id; otherwise derive one from the draft.
        draftId: ebay?.sku ? undefined : file.draftId,
        guiSkuPrefix: process.env.GUI_DEFAULT_SKU ?? "",
        previousResults: file.publishResults,
        browser: { headless: !args.headful },
      },
      deps
    );
    file.publishResults = mergePublishResults(file.publishResults, run.results);
    writeDraftFile(args.draftPath, file);
    return {
      draftId: file.draftId,
      results: run.results,
      publishResults: file.publishResults,
      complete: run.results.every((r) => r.status === "published" || r.status === "skipped"),
    };
  });
}
