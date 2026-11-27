// Checks the publish orchestration without hitting live services.
// Run: npm run build && node dist/publish.test.js
import assert from "node:assert";
import { publishDraftBundle, toEbayOptions, validPackageWeightLb, validateHttpsImageUrls } from "./publish.js";
import type { DraftBundle } from "./types.js";

process.env.EBAY_ENV = "sandbox"; // the retry case below stores a sandbox result

const draft: DraftBundle = {
  attributes: {
    brand: "Patagonia",
    brandInferred: false,
    productName: "Synchilla Snap-T",
    category: "Fleece Jacket",
    titleKeywords: ["synchilla"],
    size: "M",
    color: "green",
    material: "fleece",
    condition: "good",
    flaws: [],
    dimensions: null,
    originalRetail: 139,
  },
  price: { suggested: 68, low: 55, high: 82, currency: "USD", basis: "median of 21 active asks", sampleSize: 21 },
  comparison: [],
  retail: [],
  comps: [],
  listings: [
    { platform: "ebay", title: "Patagonia Synchilla Fleece M Green", description: "Green fleece.", price: 68, condition: "good", categoryId: "57988", packageWeightLb: 2 },
    { platform: "poshmark", title: "Cozy Patagonia fleece", description: "So warm.", price: 68, condition: "good" },
    { platform: "depop", title: "Patagonia fleece", description: "Vintage-inspired.", price: 68, condition: "good" },
  ],
};

const calls: string[] = [];

const result = await publishDraftBundle(
  {
    draft,
    photoPaths: ["/tmp/photo1.jpg"],
    platforms: ["ebay", "poshmark", "depop"],
    ebay: {
      imageUrls: ["https://example.com/photo1.jpg"],
      merchantLocationKey: "loc",
      fulfillmentPolicyId: "fulfill",
      paymentPolicyId: "payment",
      returnPolicyId: "return",
    },
  },
  {
    publishEbay: async (listing, opts) => {
      calls.push(`ebay:${listing.platform}:${opts.categoryId}`);
      return { offerId: "offer-1", listingId: "listing-1" };
    },
    browserSession: {
      fill: async (platform, listing) => {
        calls.push(`browser:${platform}:${listing.platform}`);
        return { status: "published", message: `${platform} done`, url: `https://www.depop.com/products/1/` };
      },
    },
  }
);

// Poshmark has no fill script in this cut (D1): a clear error, and the session is never asked.
assert.deepEqual(calls, ["ebay:ebay:57988", "browser:depop:depop"]);
assert.equal(result.results.length, 3);
assert.equal(result.results[0].status, "published");
assert.equal(result.results[1].status, "error");
assert.match(result.results[1].message, /Poshmark assisted fill isn't built yet; use Copy listing/);
assert.equal(result.results[2].status, "published");

// F4: no session, no browser. A leftover ENABLE_BROWSER_AUTOMATION / *_BROWSER_FLOW is ignored (S9).
process.env.ENABLE_BROWSER_AUTOMATION = "1";
process.env.DEPOP_BROWSER_FLOW = '{"url":"https://www.depop.com/products/create/"}';
const noSession = await publishDraftBundle({ draft, photoPaths: ["/tmp/photo1.jpg"], platforms: ["depop", "poshmark"] });
assert.deepEqual(noSession.results.map((r) => r.status), ["error", "error"]);
assert.match(noSession.results[0].message, /posting session/);
delete process.env.ENABLE_BROWSER_AUTOMATION;
delete process.env.DEPOP_BROWSER_FLOW;

const retryCalls: string[] = [];
const retry = await publishDraftBundle(
  {
    draft,
    draftId: "123e4567-e89b-12d3-a456-426614174000",
    photoPaths: ["/tmp/photo1.jpg"],
    platforms: ["ebay", "depop"],
    ebay: {
      imageUrls: ["https://example.com/photo1.jpg"],
      merchantLocationKey: "loc",
      fulfillmentPolicyId: "fulfill",
      paymentPolicyId: "payment",
      returnPolicyId: "return",
    },
    previousResults: [{ platform: "ebay", status: "published", message: "already live", offerId: "o", listingId: "l", env: "sandbox" }],
  },
  {
    publishEbay: async (_listing, opts) => {
      retryCalls.push(`ebay:${opts.sku}`);
      return { offerId: "unexpected", listingId: "unexpected" };
    },
    browserSession: {
      fill: async (platform) => {
        retryCalls.push(`browser:${platform}`);
        return { status: "published", message: "done", url: "https://www.depop.com/products/2/" };
      },
    },
  }
);
assert.equal(retry.results[0].status, "skipped");
assert.match(retry.results[0].message, /already published/);
assert.deepEqual(retryCalls, ["browser:depop"]);

const uncertain = await publishDraftBundle(
  { draft, photoPaths: ["/tmp/photo1.jpg"], platforms: ["depop"] },
  { browserSession: { fill: async () => { throw new Error("request timed out after submit"); } } }
);
assert.equal(uncertain.results[0].status, "unknown");
assert.match(uncertain.results[0].message, /possibly published|status is unknown/);
assert.deepEqual(validateHttpsImageUrls(["https://example.com/a.jpg", "https://example.com/a.jpg"]), ["https://example.com/a.jpg"]);
assert.throws(() => validateHttpsImageUrls(["http://example.com/a.jpg"]), /HTTPS/);
const guiEbay = toEbayOptions(
  draft,
  {
    imageUrls: ["https://example.com/photo1.jpg"],
    merchantLocationKey: "loc",
    fulfillmentPolicyId: "fulfill",
    paymentPolicyId: "payment",
    returnPolicyId: "return",
  },
  "123e4567-e89b-12d3-a456-426614174000"
);
assert.equal(guiEbay.sku, toEbayOptions(draft, { ...guiEbay, sku: "different-prefix" }, "123e4567-e89b-12d3-a456-426614174000").sku);
assert.match(guiEbay.sku, /^resale-gui-/);

// With no image URLs, eBay publishes from the draft's photos (uploaded to eBay).
const settingsNoUrls = { imageUrls: [], merchantLocationKey: "loc", fulfillmentPolicyId: "f", paymentPolicyId: "p", returnPolicyId: "r" };
const fromPhotos = toEbayOptions(draft, settingsNoUrls, undefined, "", ["/tmp/photo1.jpg"]);
assert.deepEqual(fromPhotos.imageUrls, []);
assert.deepEqual(fromPhotos.photoPaths, ["/tmp/photo1.jpg"]);
assert.throws(() => toEbayOptions(draft, settingsNoUrls, undefined, "", []), /photos or public HTTPS image URLs/);

// Depop caps descriptions at 1,000 characters: an over-long one stops before any tab is filled.
{
  const long = { ...draft, listings: draft.listings.map((l) => (l.platform === "depop" ? { ...l, description: "x".repeat(1001) } : l)) };
  let filled = 0;
  const out = await publishDraftBundle(
    { draft: long, photoPaths: ["/tmp/photo1.jpg"], platforms: ["depop"] },
    { browserSession: { fill: async () => { filled++; return { status: "published", message: "", url: "https://www.depop.com/products/1/" }; } } }
  );
  assert.equal(filled, 0);
  assert.equal(out.results[0].status, "error");
  assert.match(out.results[0].message, /1,001 characters; Depop allows 1,000/);
}

// eBay calculated shipping needs the package weight (errorId 25020): the draft's estimate is sent,
// a typed weight wins, and a draft with none stops before anything reaches eBay.
assert.equal(fromPhotos.packageWeightLb, 2);
assert.equal(toEbayOptions(draft, { ...settingsNoUrls, packageWeightLb: 3.5 }, undefined, "", ["/tmp/photo1.jpg"]).packageWeightLb, 3.5);
const weightless = { ...draft, listings: draft.listings.map((l) => (l.platform === "ebay" ? { ...l, packageWeightLb: undefined } : l)) };
assert.throws(() => toEbayOptions(weightless, settingsNoUrls, undefined, "", ["/tmp/photo1.jpg"]), /package weight/);
assert.throws(() => toEbayOptions(draft, { ...settingsNoUrls, packageWeightLb: 0 }, undefined, "", ["/tmp/photo1.jpg"]), /package weight/);
assert.equal(validPackageWeightLb(2.25), 2.25);
assert.equal(validPackageWeightLb("1.5"), undefined, "only numbers count");
assert.equal(validPackageWeightLb(-1), undefined);
assert.equal(validPackageWeightLb(500), undefined, "over eBay's 150 lb");

// eBay results record the environment; a sandbox success never hides a missing production listing.
process.env.EBAY_ENV = "production";
const ebayOnly = (previousResults: Parameters<typeof publishDraftBundle>[0]["previousResults"]) =>
  publishDraftBundle(
    { draft, photoPaths: ["/tmp/photo1.jpg"], platforms: ["ebay"], ebay: settingsNoUrls, previousResults },
    { publishEbay: async () => ({ offerId: "o2", listingId: "l2" }) }
  );
const fresh = await ebayOnly([]);
assert.equal(fresh.results[0].status, "published");
assert.equal(fresh.results[0].env, "production");
const afterSandbox = await ebayOnly([{ platform: "ebay", status: "published", message: "", env: "sandbox", listingId: "s" }]);
assert.equal(afterSandbox.results[0].status, "published");
assert.equal(afterSandbox.results[0].listingId, "l2");
const afterProduction = await ebayOnly([{ platform: "ebay", status: "published", message: "", env: "production", listingId: "p" }]);
assert.equal(afterProduction.results[0].status, "skipped");
// A result written before env was recorded goes back to eBay, whose SKU lookup finds any live listing.
const legacy = await ebayOnly([{ platform: "ebay", status: "published", message: "", listingId: "old" }]);
assert.equal(legacy.results[0].status, "published");

console.log("publish.test ok");
