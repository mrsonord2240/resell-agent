// publishListing against a stubbed eBay. Run: npm test
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.EBAY_ENV = "production";
process.env.EBAY_CLIENT_ID = "client";
process.env.EBAY_CLIENT_SECRET = "secret";
process.env.EBAY_USER_REFRESH_TOKEN = "refresh";

const { publishListing } = await import("./sell.js");
import type { ListingDraft } from "../types.js";

const dir = mkdtempSync(join(tmpdir(), "sell-test-"));
const photo = join(dir, "front.jpg");
writeFileSync(photo, Buffer.from([0xff, 0xd8]));

const listing: ListingDraft = { platform: "ebay", title: "Patagonia Fleece", description: "Green.", price: 68, condition: "good", categoryId: "57988" };
const baseOpts = {
  sku: "resale-sku-1",
  imageUrls: [] as string[],
  photoPaths: [photo],
  categoryId: "57988",
  merchantLocationKey: "loc",
  fulfillmentPolicyId: "f",
  paymentPolicyId: "p",
  returnPolicyId: "r",
};

type Route = (url: string, init: RequestInit) => Response | undefined;
let calls: string[] = [];
let bodies: Record<string, unknown> = {};

function stub(offers: unknown[]): void {
  calls = [];
  bodies = {};
  const routes: Route[] = [
    (url) => (url.endsWith("/identity/v1/oauth2/token") ? Response.json({ access_token: "t", expires_in: 7200 }) : undefined),
    // Like eBay: a SKU with no offers is a 404 (errorId 25713), not an empty list.
    (url, init) => (url.includes("/sell/inventory/v1/offer?sku=") && init.method === "GET"
      ? (offers.length
        ? Response.json({ offers })
        : Response.json({ errors: [{ errorId: 25713, message: "This Offer is not available." }] }, { status: 404 }))
      : undefined),
    (url) => (url.endsWith("/create_image_from_file") ? Response.json({ imageUrl: "https://i.ebayimg.com/front.jpg" }, { status: 201 }) : undefined),
    (url, init) => (url.includes("/inventory_item/") && init.method === "PUT" ? new Response(null, { status: 204 }) : undefined),
    (url, init) => (/\/offer\/[^/]+$/.test(url) && init.method === "PUT" ? new Response(null, { status: 204 }) : undefined),
    (url, init) => (url.endsWith("/sell/inventory/v1/offer") && init.method === "POST" ? Response.json({ offerId: "new-offer" }) : undefined),
    (url, init) => (url.endsWith("/publish") && init.method === "POST" ? Response.json({ listingId: "listing-9" }) : undefined),
  ];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    if (!url.endsWith("/oauth2/token")) calls.push(`${method} ${url.replace(/^https:\/\/[^/]+/, "")}`);
    if (typeof init.body === "string") bodies[`${method} ${url.replace(/^https:\/\/[^/]+/, "")}`] = JSON.parse(init.body);
    // Like eBay: Node's fetch sends "Accept-Language: *" unless told otherwise, and eBay rejects that (errorId 25709).
    const lang = new Headers(init.headers).get("accept-language");
    if (!url.endsWith("/oauth2/token") && (!lang || lang === "*")) {
      return Response.json({ errors: [{ errorId: 25709, message: "Invalid value for header Accept-Language." }] }, { status: 400 });
    }
    for (const route of routes) {
      const res = route(url, init);
      if (res) return res;
    }
    throw new Error(`unrouted ${method} ${url}`);
  }) as typeof fetch;
}

// No offer yet: photos upload after the offer check, and their eBay URLs go on the inventory item.
{
  stub([]);
  const out = await publishListing(listing, baseOpts);
  assert.deepEqual(out, { offerId: "new-offer", listingId: "listing-9" });
  assert.deepEqual(calls, [
    "GET /sell/inventory/v1/offer?sku=resale-sku-1",
    "POST /commerce/media/v1_beta/image/create_image_from_file",
    "PUT /sell/inventory/v1/inventory_item/resale-sku-1",
    "POST /sell/inventory/v1/offer",
    "POST /sell/inventory/v1/offer/new-offer/publish",
  ]);
  const item = bodies["PUT /sell/inventory/v1/inventory_item/resale-sku-1"] as { product: { imageUrls: string[] } };
  assert.deepEqual(item.product.imageUrls, ["https://i.ebayimg.com/front.jpg"]);
}

// A published offer for the SKU is returned as-is: no upload, no second listing.
{
  stub([{ offerId: "old", listingId: "live-1", status: "PUBLISHED" }]);
  const out = await publishListing(listing, baseOpts);
  assert.deepEqual(out, { offerId: "old", listingId: "live-1" });
  assert.deepEqual(calls, ["GET /sell/inventory/v1/offer?sku=resale-sku-1"]);
}

// One unpublished offer (a run that died before publish) is updated and published, not duplicated.
{
  stub([{ offerId: "stranded", status: "UNPUBLISHED" }]);
  const out = await publishListing(listing, baseOpts);
  assert.deepEqual(out, { offerId: "stranded", listingId: "listing-9" });
  assert.deepEqual(calls, [
    "GET /sell/inventory/v1/offer?sku=resale-sku-1",
    "POST /commerce/media/v1_beta/image/create_image_from_file",
    "PUT /sell/inventory/v1/inventory_item/resale-sku-1",
    "PUT /sell/inventory/v1/offer/stranded",
    "POST /sell/inventory/v1/offer/stranded/publish",
  ]);
}

// More than one unpublished offer is ambiguous: stop and name them.
{
  stub([{ offerId: "a", status: "UNPUBLISHED" }, { offerId: "b", status: "UNPUBLISHED" }]);
  await assert.rejects(publishListing(listing, baseOpts), /a, b/);
  assert.deepEqual(calls, ["GET /sell/inventory/v1/offer?sku=resale-sku-1"]);
}

// Given image URLs are used as-is; nothing uploads.
{
  stub([]);
  await publishListing(listing, { ...baseOpts, imageUrls: ["https://example.com/a.jpg"] });
  assert.ok(!calls.some((c) => c.includes("create_image_from_file")));
}

console.log("sell.test ok");
