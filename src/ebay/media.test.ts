// eBay Media API photo upload, with fetch stubbed. Run: npm test
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uploadEbayImages, type MediaDeps } from "./media.js";

const dir = mkdtempSync(join(tmpdir(), "media-test-"));
const front = join(dir, "front.jpg");
const back = join(dir, "back.png");
writeFileSync(front, Buffer.from([0xff, 0xd8, 0xff, 0x01]));
writeFileSync(back, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

const BASE = "https://apim.ebay.com";
const CREATE = `${BASE}/commerce/media/v1_beta/image/create_image_from_file`;

interface Seen { url: string; method: string; auth: string; field?: File | null }

function deps(responses: Array<() => Response>, seen: Seen[], slept: number[] = []): MediaDeps {
  return {
    base: BASE,
    getToken: async () => "user-token",
    sleep: async (ms) => { slept.push(ms); },
    fetchImpl: async (input, init) => {
      const body = init?.body;
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        auth: new Headers(init?.headers).get("authorization") ?? "",
        field: body instanceof FormData ? (body.get("image") as File | null) : undefined,
      });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request ${String(input)}`);
      return next();
    },
  };
}

const created = (url: string) => () => new Response(JSON.stringify({ imageUrl: url, expirationDate: "2027-01-01T00:00:00Z" }), { status: 201 });

// Each photo goes up as multipart field "image", in order, with the user token.
{
  const seen: Seen[] = [];
  const urls = await uploadEbayImages([front, back], deps([created("https://i.ebayimg.com/a.jpg"), created("https://i.ebayimg.com/b.jpg")], seen));
  assert.deepEqual(urls, ["https://i.ebayimg.com/a.jpg", "https://i.ebayimg.com/b.jpg"]);
  assert.deepEqual(seen.map((s) => [s.method, s.url]), [["POST", CREATE], ["POST", CREATE]]);
  assert.equal(seen[0].auth, "Bearer user-token");
  assert.equal(seen[0].field?.name, "front.jpg");
  assert.equal(seen[0].field?.type, "image/jpeg");
  assert.equal(seen[1].field?.type, "image/png");
  assert.equal(seen[0].field?.size, 4);
}

// HTTP 429 waits for Retry-After, then retries the same photo.
{
  const seen: Seen[] = [];
  const slept: number[] = [];
  const urls = await uploadEbayImages(
    [front],
    deps([() => new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }), created("https://i.ebayimg.com/a.jpg")], seen, slept)
  );
  assert.deepEqual(urls, ["https://i.ebayimg.com/a.jpg"]);
  assert.equal(seen.length, 2);
  assert.deepEqual(slept, [2000]);
}

// A 201 body without imageUrl falls back to getImage on the Location URI.
{
  const seen: Seen[] = [];
  const location = `${BASE}/commerce/media/v1_beta/image/img-123`;
  const urls = await uploadEbayImages(
    [front],
    deps([
      () => new Response("", { status: 201, headers: { Location: location } }),
      () => new Response(JSON.stringify({ imageUrl: "https://i.ebayimg.com/c.jpg" }), { status: 200 }),
    ], seen)
  );
  assert.deepEqual(urls, ["https://i.ebayimg.com/c.jpg"]);
  assert.deepEqual(seen.map((s) => [s.method, s.url]), [["POST", CREATE], ["GET", location]]);
}

// 401/403 name the missing scope so the fix is obvious.
await assert.rejects(
  uploadEbayImages([front], deps([() => new Response('{"errors":[{"errorId":190013}]}', { status: 403 })], [])),
  /sell\.inventory/
);

// A rejected photo is named in the error.
await assert.rejects(
  uploadEbayImages([back], deps([() => new Response('{"errors":[{"errorId":190201}]}', { status: 400 })], [])),
  /back\.png.*400/
);

// Unsupported files fail before anything is sent.
{
  const psd = join(dir, "layered.psd");
  writeFileSync(psd, "x");
  const seen: Seen[] = [];
  await assert.rejects(uploadEbayImages([front, psd], deps([], seen)), /layered\.psd/);
  assert.equal(seen.length, 0);
}

console.log("media.test ok");
