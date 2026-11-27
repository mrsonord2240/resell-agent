import { cfg } from "./config.js";
import { publishListing, type PostOptions } from "./ebay/sell.js";
import { descriptionOverLimit, GUI_PLATFORMS, stableGuiSku, validPackageWeightLb } from "./gui-validation.js";

export { validPackageWeightLb };
import type { DraftBundle, ListingDraft, Platform } from "./types.js";

export interface EbayPublishSettings {
  sku?: string;
  imageUrls: string[];
  quantity?: number;
  categoryId?: string;
  /** Overrides the draft's estimated package weight (lb). */
  packageWeightLb?: number;
  merchantLocationKey: string;
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
}

export interface PublishRunOptions {
  draft: DraftBundle;
  photoPaths: string[];
  platforms?: Platform[];
  ebay?: EbayPublishSettings;
  /** Set by the GUI so retries use the same SKU and persisted result state. */
  draftId?: string;
  guiSkuPrefix?: string;
  previousResults?: PlatformPublishResult[];
}

/**
 * Per-market state (spec "Assisted-fill contract"):
 * - `filling`: written before a browser tab is filled; a re-run reads it as `unknown`.
 * - `unknown`: Post may have been clicked; browser markets skip it until Sam verifies (D6).
 * - `not_posted`: tab closed with no submit seen; re-filled next run.
 * - `held`: an uncertain draft no market publishes until `resell mark --approve` (O5).
 * - `skipped`: not attempted this run; never replaces a stored state.
 */
export type PublishStatus = "published" | "error" | "unknown" | "skipped" | "filling" | "not_posted" | "held";

export interface PlatformPublishResult {
  platform: Platform;
  status: PublishStatus;
  message: string;
  offerId?: string;
  listingId?: string;
  url?: string;
  /** eBay only: the environment the result came from, so a sandbox run never stands in for production. */
  env?: "sandbox" | "production";
  /** Browser fills only: ties a result to the `filling` entry its fill wrote (E11). */
  attemptId?: string;
}

export interface PublishRunResult {
  results: PlatformPublishResult[];
}

export type BrowserMarket = Exclude<Platform, "ebay">;

/**
 * What a filled tab ended as. `published` and `unknown` mean a submit was seen; `not_posted` means none;
 * `error` means the fill failed before any submit could happen (so the message is never read as "maybe posted").
 */
export interface BrowserFillOutcome {
  status: "published" | "unknown" | "not_posted" | "error";
  message: string;
  url?: string;
}

/** A long-lived browser the batch runner owns and passes in (E2). A throw records `error` (or `unknown` if the message suggests the request went out). */
export interface BrowserSession {
  fill(platform: BrowserMarket, listing: ListingDraft, photoPaths: string[]): Promise<BrowserFillOutcome>;
}

/** A started fill's attempt id, or the skip to report when the stored state no longer allows a fill. */
export type BeginFillOutcome = { attemptId: string } | { skipped: PlatformPublishResult };

/** Brackets each session fill with durable writes, so the wait itself holds no lock (E7). */
export interface FillRecorder {
  /** Re-checks the stored state, then durably records `filling`; a skip means no fill may start. */
  begin(platform: BrowserMarket): Promise<BeginFillOutcome>;
  /** Records the fill's result and returns the result to report for this run. */
  finish(platform: BrowserMarket, attemptId: string, result: PlatformPublishResult, opts: { submitSeen: boolean }): Promise<PlatformPublishResult>;
}

export interface PublishDeps {
  publishEbay?: typeof publishListing;
  /** Depop fills run only in a session (assisted fill: Sam clicks Post). Without one, Depop is an `error`. */
  browserSession?: BrowserSession;
  fillRecorder?: FillRecorder;
}

export function isBrowserMarket(platform: Platform): platform is BrowserMarket {
  return platform !== "ebay";
}

function uniquePlatforms(platforms: Platform[]): Platform[] {
  const seen = new Set<Platform>();
  const out: Platform[] = [];
  for (const platform of platforms) {
    if (!seen.has(platform)) {
      seen.add(platform);
      out.push(platform);
    }
  }
  return out;
}

function selectedPlatforms(value: Platform[] | undefined, draft: DraftBundle): Platform[] {
  if (value === undefined) return uniquePlatforms(draft.listings.map((listing) => listing.platform));
  if (!Array.isArray(value) || value.length === 0) throw new Error("Select at least one platform.");
  const result: Platform[] = [];
  const seen = new Set<Platform>();
  for (const candidate of value) {
    if (!GUI_PLATFORMS.includes(candidate)) throw new Error(`Unsupported platform: ${String(candidate)}`);
    if (!seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  if (!result.length) throw new Error("Select at least one platform.");
  return result;
}

function listingForPlatform(draft: DraftBundle, platform: Platform): ListingDraft | null {
  return draft.listings.find((listing) => listing.platform === platform) ?? null;
}

function requireText(value: unknown, name: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw new Error(`Missing required ${name}`);
  }
  if (trimmed.length > 256) throw new Error(`${name} is too long`);
  return trimmed;
}

export function validateHttpsImageUrls(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("eBay publish requires at least one public HTTPS image URL.");
  }
  if (value.length > 20) throw new Error("eBay accepts at most 20 image URLs here.");
  const urls: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || candidate.length > 2_048) {
      throw new Error("Each eBay image URL must be a short HTTPS URL.");
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(`Invalid eBay image URL: ${candidate}`);
    }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
      throw new Error("eBay image URLs must use HTTPS and may not contain credentials.");
    }
    urls.push(parsed.toString());
  }
  return [...new Set(urls)];
}

export function toEbayOptions(
  draft: DraftBundle,
  ebay: EbayPublishSettings | undefined,
  draftId?: string,
  guiSkuPrefix = "",
  photoPaths: string[] = []
): PostOptions {
  const listing = listingForPlatform(draft, "ebay");
  const categoryId = ebay?.categoryId ?? listing?.categoryId ?? "";
  // Given URLs win; otherwise the draft's photos are uploaded to eBay at publish time.
  if (!ebay?.imageUrls?.length && !photoPaths.length) {
    throw new Error("eBay publish needs photos or public HTTPS image URLs.");
  }
  const imageUrls = ebay?.imageUrls?.length ? validateHttpsImageUrls(ebay.imageUrls) : [];
  const quantity = ebay?.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    throw new Error("eBay quantity must be an integer between 1 and 100.");
  }
  const category = requireText(categoryId, "eBay categoryId");
  if (!/^\d+$/.test(category)) throw new Error("eBay categoryId must be numeric.");
  // Calculated shipping rejects a publish without it (errorId 25020), after the offer is made.
  const packageWeightLb = validPackageWeightLb(ebay?.packageWeightLb ?? listing?.packageWeightLb);
  if (packageWeightLb === undefined) {
    throw new Error("eBay needs the package weight in pounds (item plus box, up to 150). Enter it on the eBay card, or pass --weight.");
  }

  return {
    sku: draftId ? stableGuiSku(draftId, guiSkuPrefix) : (ebay?.sku?.trim() || `resale-${Date.now()}`),
    imageUrls,
    photoPaths: imageUrls.length ? [] : photoPaths,
    quantity,
    categoryId: category,
    packageWeightLb,
    merchantLocationKey: requireText(ebay?.merchantLocationKey, "eBay merchantLocationKey"),
    fulfillmentPolicyId: requireText(ebay?.fulfillmentPolicyId, "eBay fulfillmentPolicyId"),
    paymentPolicyId: requireText(ebay?.paymentPolicyId, "eBay paymentPolicyId"),
    returnPolicyId: requireText(ebay?.returnPolicyId, "eBay returnPolicyId"),
  };
}

function errorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

function possiblyPublished(message: string): boolean {
  return /possibly published|timed? ?out|timeout|abort|network|fetch failed|econn|socket|connection/i.test(message);
}

function unknownMessage(platform: Platform, message: string): string {
  return `${platform} publish status is unknown; the request may have reached the platform. Verify the listing before retrying. ${message}`;
}

/** Fold a run's results into the stored ones; a "skipped" result never replaces a stored state. */
export function mergePublishResults(previous: PlatformPublishResult[], current: PlatformPublishResult[]): PlatformPublishResult[] {
  const byPlatform = new Map(previous.map((result) => [result.platform, result]));
  for (const result of current) {
    if (result.status === "skipped" && byPlatform.has(result.platform)) continue;
    byPlatform.set(result.platform, result);
  }
  return [...byPlatform.values()];
}

/** O9: done only when every requested market's stored state is `published`; `unknown`, `filling` and `held` are not. */
export function isPublishComplete(stored: PlatformPublishResult[], platforms: Platform[]): boolean {
  const byPlatform = new Map(stored.map((result) => [result.platform, result]));
  return platforms.every((platform) => byPlatform.get(platform)?.status === "published");
}

function currentEbayEnv(): "sandbox" | "production" {
  return cfg.env === "production" ? "production" : "sandbox";
}

/** Why a market is not attempted given its stored state, or null to attempt it. */
export function skipReason(platform: Platform, prior: PlatformPublishResult | undefined, ebayEnv = currentEbayEnv()): string | null {
  if (!prior) return null;
  if (prior.status === "held") {
    return `${platform} is held for review; release the draft with \`resell mark --approve\` first.`;
  }
  // An eBay success counts only in the environment it happened in. One with
  // no env predates this field and goes back to eBay, whose SKU lookup
  // returns an existing live listing instead of making a second one.
  if (prior.status === "published" && (isBrowserMarket(platform) || prior.env === ebayEnv)) {
    return `${platform} was already published successfully; skipped retry.`;
  }
  // Verify-first for browser markets only (D6): eBay's SKU lookup makes its retry safe.
  if (isBrowserMarket(platform) && (prior.status === "unknown" || prior.status === "filling")) {
    return `${platform} may already be posted (${prior.status}); verify it, then mark it posted or not posted before re-running.`;
  }
  return null;
}

async function fillInSession(
  session: BrowserSession,
  recorder: FillRecorder | undefined,
  platform: BrowserMarket,
  listing: ListingDraft,
  photoPaths: string[]
): Promise<PlatformPublishResult> {
  let attemptId: string | undefined;
  try {
    const begun = await recorder?.begin(platform);
    if (begun && "skipped" in begun) return begun.skipped;
    attemptId = begun?.attemptId;
  } catch (error) {
    return { platform, status: "error", message: `${platform} was not filled: ${errorMessage(error)}` };
  }
  let result: PlatformPublishResult;
  try {
    const outcome = await session.fill(platform, listing, photoPaths);
    // `published` means a captured URL; a submit without one is verify-first.
    const status = outcome.status === "published" && !outcome.url ? "unknown" : outcome.status;
    result = { platform, status, message: outcome.message, url: outcome.url };
  } catch (error) {
    const message = errorMessage(error);
    const unknown = possiblyPublished(message);
    result = { platform, status: unknown ? "unknown" : "error", message: unknown ? unknownMessage(platform, message) : message };
  }
  if (!recorder || attemptId === undefined) return result;
  result.attemptId = attemptId;
  return recorder.finish(platform, attemptId, result, { submitSeen: result.status === "published" || result.status === "unknown" });
}

/** Depop through the runner's session; Poshmark has no fill script in this cut (D1). */
async function browserResult(platform: BrowserMarket, listing: ListingDraft, photoPaths: string[], deps: PublishDeps): Promise<PlatformPublishResult> {
  if (platform === "poshmark") {
    return { platform, status: "error", message: "Poshmark assisted fill isn't built yet; use Copy listing and post it by hand." };
  }
  if (!deps.browserSession) {
    return { platform, status: "error", message: `${platform} fills run in a posting session: \`resell post-batch <dir> --markets depop\`, \`resell post\`, or the GUI.` };
  }
  if (!photoPaths.length) {
    return { platform, status: "error", message: `Browser publishing for ${platform} needs the uploaded photo files from the draft step.` };
  }
  // The form would cut it silently; stop before a tab opens instead.
  const over = descriptionOverLimit(platform, listing.description);
  if (over) return { platform, status: "error", message: over };
  return fillInSession(deps.browserSession, deps.fillRecorder, platform, listing, photoPaths);
}

export async function publishDraftBundle(
  opts: PublishRunOptions,
  deps: PublishDeps = {}
): Promise<PublishRunResult> {
  const publishEbay = deps.publishEbay ?? publishListing;
  const targets = selectedPlatforms(opts.platforms, opts.draft);
  const results: PlatformPublishResult[] = [];
  const previous = new Map((opts.previousResults ?? []).map((result) => [result.platform, result]));

  const ebayEnv = currentEbayEnv();

  for (const platform of targets) {
    const prior = previous.get(platform);
    const skip = skipReason(platform, prior, ebayEnv);
    if (skip) {
      results.push({ ...prior!, status: "skipped", message: skip });
      continue;
    }

    const listing = listingForPlatform(opts.draft, platform);
    if (!listing) {
      results.push({
        platform,
        status: "error",
        message: `No draft listing was generated for ${platform}`,
      });
      continue;
    }

    if (platform !== "ebay" && (!Number.isFinite(listing.price) || listing.price <= 0)) {
      results.push({
        platform,
        status: "error",
        message: `${platform} needs a positive price before publishing; set it manually or use Copy listing.`,
      });
      continue;
    }

    if (isBrowserMarket(platform)) {
      results.push(await browserResult(platform, listing, opts.photoPaths, deps));
      continue;
    }

    let externalPublishAttempted = false;
    try {
      if (platform === "ebay") {
        const ebayOpts = toEbayOptions(opts.draft, opts.ebay, opts.draftId, opts.guiSkuPrefix, opts.photoPaths);
        externalPublishAttempted = true;
        const published = await publishEbay(listing, ebayOpts);
        if (!published || typeof published.offerId !== "string" || !published.offerId || typeof published.listingId !== "string" || !published.listingId) {
          throw new Error("eBay returned no offer/listing identifiers after publish.");
        }
        results.push({
          platform,
          status: "published",
          message: `eBay published: offer ${published.offerId}, listing ${published.listingId}`,
          offerId: published.offerId,
          listingId: published.listingId,
          env: ebayEnv,
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      const unknown = possiblyPublished(message);
      const duplicateWarning = platform === "ebay" && externalPublishAttempted && !unknown
        ? " Verify eBay before retrying; an earlier API step may have been accepted."
        : "";
      results.push({
        platform,
        status: unknown ? "unknown" : "error",
        message: unknown ? unknownMessage(platform, message) : `${message}${duplicateWarning}`,
      });
    }
  }

  return { results };
}
