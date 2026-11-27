// offerStock (O4, E12): is the item's eBay listing still for sale? Stubbed eBay. Run: npm test
import assert from "node:assert";

process.env.EBAY_ENV = "production";
process.env.EBAY_CLIENT_ID = "client";
process.env.EBAY_CLIENT_SECRET = "secret";
process.env.EBAY_USER_REFRESH_TOKEN = "refresh";

const { offerStock } = await import("./sell.js");

const asked: string[] = [];
function stub(offer: unknown, status = 200): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith("/identity/v1/oauth2/token")) return Response.json({ access_token: "t", expires_in: 7200 });
    // eBay rejects Node's default "Accept-Language: *" (errorId 25709).
    const lang = new Headers(init.headers).get("accept-language");
    if (lang !== "en-US") return Response.json({ errors: [{ errorId: 25709 }] }, { status: 400 });
    asked.push(`${init.method ?? "GET"} ${url.replace(/^https:\/\/[^/]+/, "")}`);
    return Response.json(offer, { status });
  }) as typeof fetch;
}

stub({ offerId: "o1", status: "PUBLISHED", listing: { listingId: "l1", listingStatus: "ACTIVE", soldQuantity: 0 } });
assert.strictEqual(await offerStock("o1"), "active");
assert.deepStrictEqual(asked, ["GET /sell/inventory/v1/offer/o1"], "the Inventory API offer lookup, with Accept-Language: en-US");

stub({ offerId: "o1", status: "PUBLISHED", listing: { listingId: "l1", listingStatus: "OUT_OF_STOCK", soldQuantity: 1 } });
assert.strictEqual(await offerStock("o1"), "sold");
stub({ offerId: "o1", status: "PUBLISHED", listing: { listingId: "l1", listingStatus: "ENDED", soldQuantity: 0 } });
assert.strictEqual(await offerStock("o1"), "ended");
stub({ offerId: "o1", status: "UNPUBLISHED" });
assert.strictEqual(await offerStock("o1"), "ended", "a withdrawn offer is not for sale");
stub({ errors: [{ errorId: 25713 }] }, 404);
assert.strictEqual(await offerStock("o1"), "ended", "a deleted offer is not for sale");
stub({ errors: [{ errorId: 2003 }] }, 500);
await assert.rejects(offerStock("o1"), /500/, "an eBay failure is an error (\"couldn't confirm eBay stock\"), not a guess");

console.log("stock.test ok");
