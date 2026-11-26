// eBay Media API: upload local photos to eBay Picture Services (EPS) so a
// listing needs no public image hosting. createImageFromFile is still v1_beta.
// Contract (eBay OpenAPI commerce_media_v1_beta): POST multipart/form-data
// with the file in field "image"; 201 returns { imageUrl, expirationDate,
// maxDimensionImageUrl } and a Location header for getImage. Scope:
// sell.inventory. Limit: 50 POSTs per 5 s per user, so uploads run one at a
// time and back off on 429.

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { cfg } from "../config.js";
import { getUserToken } from "./auth.js";

const MEDIA_PATH = "/commerce/media/v1_beta/image";
const MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 60_000;

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".avif": "image/avif",
};

export interface MediaDeps {
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  /** Media API host, e.g. https://apim.ebay.com. Defaults to the configured eBay environment. */
  base?: string;
}

function mimeFor(path: string): string {
  const mime = MIME_BY_EXT[extname(path).toLowerCase()];
  if (!mime) {
    throw new Error(`eBay photo upload: ${basename(path)} is not a supported image (use JPG, PNG, GIF, BMP, TIFF, WEBP, HEIC or AVIF).`);
  }
  return mime;
}

function retryDelayMs(res: Response): number {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_MS;
}

async function withTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function imageUrlFrom(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const url = (JSON.parse(text) as { imageUrl?: unknown }).imageUrl;
    return typeof url === "string" && url ? url : undefined;
  } catch {
    return undefined;
  }
}

function failure(name: string, res: Response, text: string): Error {
  if (res.status === 401 || res.status === 403) {
    return new Error(
      `eBay photo upload: ${res.status} for ${name}. The user token needs the sell.inventory scope; re-authorize with auth-url. ${text}`.trim()
    );
  }
  return new Error(`eBay photo upload: ${name} was rejected (${res.status}). ${text}`.trim());
}

async function uploadOne(path: string, mime: string, deps: Required<MediaDeps>): Promise<string> {
  const name = basename(path);
  const bytes = await readFile(path);
  for (let attempt = 1; ; attempt++) {
    const form = new FormData();
    form.append("image", new File([bytes], name, { type: mime }));
    const token = await deps.getToken();
    // No Content-Type header: fetch sets multipart/form-data with its boundary.
    const res = await withTimeout(deps.fetchImpl, `${deps.base}${MEDIA_PATH}/create_image_from_file`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const text = await res.text();
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      await deps.sleep(retryDelayMs(res));
      continue;
    }
    if (!res.ok) throw failure(name, res, text);

    const direct = imageUrlFrom(text);
    if (direct) return direct;
    const location = res.headers.get("location");
    if (!location) throw new Error(`eBay photo upload: ${name} returned no imageUrl and no Location header.`);
    const info = await withTimeout(deps.fetchImpl, location, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const infoText = await info.text();
    if (!info.ok) throw failure(name, info, infoText);
    const fetched = imageUrlFrom(infoText);
    if (!fetched) throw new Error(`eBay photo upload: getImage for ${name} returned no imageUrl.`);
    return fetched;
  }
}

/** Upload photos in order and return their eBay-hosted URLs, ready for product.imageUrls. */
export async function uploadEbayImages(paths: string[], deps: MediaDeps = {}): Promise<string[]> {
  const mimes = paths.map(mimeFor); // reject unsupported files before sending anything
  const resolved: Required<MediaDeps> = {
    fetchImpl: deps.fetchImpl ?? fetch,
    getToken: deps.getToken ?? getUserToken,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    base: deps.base ?? cfg.mediaBase,
  };
  const urls: string[] = [];
  for (const [i, path] of paths.entries()) urls.push(await uploadOne(path, mimes[i], resolved));
  return urls;
}
