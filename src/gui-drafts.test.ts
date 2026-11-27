// GUI Drafts list: list, open, edit item specifics, delete, and the TTL that keeps live-listing records.
// Temp GUI_DATA_DIR only; nothing here reaches eBay or Depop (eBay is already published, Poshmark has no fill).
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "resell-agent-gui-drafts-"));
process.env.GUI_DATA_DIR = dir;
process.env.GUI_ALLOW_REMOTE = "";
process.env.GUI_HOST = "";
process.env.EBAY_ENV = "sandbox";

const { startGui, cleanupExpiredDrafts, activePublishes, GUI_DRAFT_TTL_MS } = await import("./gui.js");

const ids = {
  old: "c0000000-0000-4000-8000-000000000001",
  mid: "c0000000-0000-4000-8000-000000000002",
  fresh: "c0000000-0000-4000-8000-000000000003",
  busy: "c0000000-0000-4000-8000-000000000004",
};

const listing = (platform: string, title: string, price: number, extra: object = {}) => ({
  platform, title, description: `${title} description`, price, condition: "good", ...extra,
});
const mapped = (value: string) => ({ value, mapped: true });
const unmapped = { value: null, mapped: false };

function fixture(id: string, createdAt: string, listings: unknown[], publishResults: unknown[], photoFiles: { file: string; present: boolean }[]): void {
  mkdirSync(join(dir, id), { recursive: true });
  const photos = photoFiles.map(({ file, present }, i) => {
    const path = join(dir, id, file);
    if (present) writeFileSync(path, Buffer.from(`jpeg-${id}-${i}`));
    return { name: `photo-${i + 1}.jpg`, path, mimeType: "image/jpeg" };
  });
  writeFileSync(join(dir, id, "draft.json"), JSON.stringify({
    draftId: id,
    draft: { attributes: { productName: "Thing" }, price: { suggested: 1 }, comps: [], comparison: [], retail: [], listings },
    photos,
    photoPaths: photos.map((p) => p.path),
    createdAt,
    updatedAt: createdAt,
    publishResults,
  }));
}

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
fixture(ids.old, iso(30), [
  listing("ebay", "Old eBay title", 40, { categoryId: "123", itemSpecifics: { Brand: ["Example"], Size: ["M"] } }),
  listing("depop", "Old Depop title", 38, { marketFields: { depop: { category: mapped("Women > Tops"), size: unmapped, brand: mapped("Example"), condition: mapped("Used - Good"), color: mapped("blue"), shipping: unmapped } } }),
], [{ platform: "ebay", status: "published", message: "eBay published", offerId: "9", listingId: "110012345", env: "sandbox" }],
[{ file: "01-a.jpg", present: true }]);
fixture(ids.mid, iso(20), [listing("ebay", "Mid eBay title", 25), listing("depop", "Mid Depop title", 22)], [
  { platform: "ebay", status: "error", message: "eBay said no" },
  { platform: "depop", status: "unknown", message: "verify", url: "https://www.depop.com/products/mid/" },
], [{ file: "01-gone.jpg", present: false }, { file: "02-b.jpg", present: true }]);
fixture(ids.fresh, iso(10), [listing("depop", "Fresh Depop title", 15), listing("poshmark", "Fresh Posh title", 16)], [
  { platform: "depop", status: "not_posted", message: "not posted" },
], []);
fixture(ids.busy, iso(5), [listing("poshmark", "Busy title", 10)], [], []);

const handle = await startGui(0);
try {
  const first = await fetch(handle.url);
  const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${handle.url}${path}`, { ...init, headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers ?? {}) } });

  // 1. List: every stored draft, newest first, with thumbnail, title, price, created time and per-market state.
  let res = await api("/api/drafts");
  assert.equal(res.status, 200);
  type Row = { draftId: string; title: string; price: number | null; createdAt: string; thumbnailUrl: string | null; markets: { platform: string; state: string; url?: string }[] };
  const list = (await res.json()) as { drafts: Row[] };
  assert.deepEqual(list.drafts.map((d) => d.draftId), [ids.busy, ids.fresh, ids.mid, ids.old], "newest first; a missing photo does not hide a draft");
  const byId = Object.fromEntries(list.drafts.map((d) => [d.draftId, d]));
  assert.equal(byId[ids.old].title, "Old eBay title");
  assert.equal(byId[ids.old].price, 40);
  assert.equal(byId[ids.old].createdAt, iso(30));
  assert.equal(byId[ids.old].thumbnailUrl, `/api/draft/${ids.old}/photo/0`);
  assert.deepEqual(byId[ids.old].markets, [
    { platform: "ebay", state: "published", url: "https://sandbox.ebay.com/itm/110012345" },
    { platform: "depop", state: "none" },
  ]);
  assert.deepEqual(byId[ids.mid].markets, [
    { platform: "ebay", state: "error" },
    { platform: "depop", state: "unknown" },
  ]);
  assert.equal(byId[ids.mid].thumbnailUrl, `/api/draft/${ids.mid}/photo/0`, "the thumbnail is the first photo still on disk");
  const thumb = await api(byId[ids.mid].thumbnailUrl!);
  assert.equal(thumb.status, 200);
  assert.equal(Buffer.from(await thumb.arrayBuffer()).toString(), `jpeg-${ids.mid}-1`);
  assert.deepEqual(byId[ids.fresh].markets, [{ platform: "depop", state: "not_posted" }, { platform: "poshmark", state: "none" }]);
  assert.equal(byId[ids.fresh].thumbnailUrl, null);
  assert.equal(byId[ids.fresh].title, "Fresh Depop title");

  // 2. Open: the same record the publish view renders, including Depop's fill-these-yourself fields (S11).
  res = await api(`/api/draft/${ids.old}`);
  assert.equal(res.status, 200);
  type Opened = { draftId: string; draft: { listings: { platform: string; title: string; price: number; itemSpecifics?: Record<string, string[]> }[] }; photos: unknown[]; publishResults: { platform: string; status: string }[]; unmapped: Record<string, string[]> };
  const opened = (await res.json()) as Opened;
  assert.equal(opened.draftId, ids.old);
  assert.equal(opened.photos.length, 1);
  assert.equal(opened.publishResults[0].status, "published");
  assert.deepEqual(opened.unmapped, { depop: ["size", "shipping"] });
  const midOpened = (await (await api(`/api/draft/${ids.mid}`)).json()) as Opened;
  assert.deepEqual(midOpened.unmapped, { depop: ["category", "size", "brand", "condition", "color", "shipping"] }, "no marketFields reads as all unmapped");
  assert.equal(midOpened.photos.length, 1, "a photo that is gone is dropped, not fatal");

  // Publishing an opened draft reuses its id: results land on the same record, no new draft folder appears.
  const foldersBefore = readdirSync(dir).sort();
  res = await api("/api/publish", { method: "POST", body: JSON.stringify({ draftId: ids.old, platforms: ["ebay"], edits: [] }) });
  assert.equal(res.status, 200);
  const pub = (await res.json()) as { results: { platform: string; status: string }[]; publishResults: { platform: string; status: string }[] };
  assert.equal(pub.results[0].status, "skipped", "the already-published eBay listing is not re-sent");
  res = await api("/api/publish", { method: "POST", body: JSON.stringify({ draftId: ids.fresh, platforms: ["poshmark"], edits: [] }) });
  assert.equal(res.status, 200);
  assert.deepEqual(readdirSync(dir).sort(), foldersBefore, "no new draft id minted");
  const freshStored = JSON.parse(readFileSync(join(dir, ids.fresh, "draft.json"), "utf8"));
  assert.equal(freshStored.draftId, ids.fresh);
  assert.ok(freshStored.publishResults.some((r: { platform: string }) => r.platform === "poshmark"), "the result is stored on the opened draft");

  // 3. Edit item specifics (and title/price) and they persist to the stored draft.
  res = await api(`/api/draft/${ids.old}`, {
    method: "PATCH",
    body: JSON.stringify({ edits: [{ platform: "ebay", title: "Edited title", price: 42, itemSpecifics: { Brand: ["Example"], Color: ["Blue"] } }] }),
  });
  assert.equal(res.status, 200);
  let stored = JSON.parse(readFileSync(join(dir, ids.old, "draft.json"), "utf8"));
  const ebayStored = stored.draft.listings.find((l: { platform: string }) => l.platform === "ebay");
  assert.deepEqual(ebayStored.itemSpecifics, { Brand: ["Example"], Color: ["Blue"] }, "Size removed, Color added");
  assert.equal(ebayStored.title, "Edited title");
  assert.equal(ebayStored.price, 42);
  res = await api(`/api/draft/${ids.old}`, { method: "PATCH", body: JSON.stringify({ edits: [{ platform: "ebay", itemSpecifics: { Brand: "x" } }] }) });
  assert.equal(res.status, 400, "malformed specifics are refused");
  stored = JSON.parse(readFileSync(join(dir, ids.old, "draft.json"), "utf8"));
  assert.deepEqual(stored.draft.listings[0].itemSpecifics, { Brand: ["Example"], Color: ["Blue"] }, "a refused edit changes nothing");

  // 4. Delete: removes the folder; bad ids, unknown ids, other origins and mid-publish drafts are refused.
  res = await api("/api/draft/..%2F..", { method: "DELETE" });
  assert.equal(res.status, 400, "path traversal is not a draft id");
  res = await api("/api/draft/C0000000-0000-4000-8000-00000000000Z", { method: "DELETE" });
  assert.equal(res.status, 400, "only the server's own UUID format");
  res = await api("/api/draft/c0000000-0000-4000-8000-0000000000ff", { method: "DELETE" });
  assert.equal(res.status, 404);
  res = await api(`/api/draft/${ids.mid}`, { method: "DELETE", headers: { Origin: "http://evil.example" } });
  assert.equal(res.status, 403);
  res = await fetch(`${handle.url}/api/draft/${ids.mid}`, { method: "DELETE" });
  assert.equal(res.status, 401);
  activePublishes.add(ids.busy);
  res = await api(`/api/draft/${ids.busy}`, { method: "DELETE" });
  assert.equal(res.status, 409, "a draft being published is not deleted");
  assert.ok(existsSync(join(dir, ids.busy)));
  activePublishes.delete(ids.busy);

  res = await api(`/api/draft/${ids.mid}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.ok(!existsSync(join(dir, ids.mid)), "the stored folder is gone");
  assert.equal((await api(`/api/draft/${ids.mid}`)).status, 404);
  assert.equal((await api(`/api/draft/${ids.mid}/photo/0`)).status, 404);
  const after = (await (await api("/api/drafts")).json()) as { drafts: Row[] };
  assert.ok(!after.drafts.some((d) => d.draftId === ids.mid));
  res = await api(`/api/draft/${ids.mid}`, { method: "PATCH", body: JSON.stringify({ edits: [] }) });
  assert.equal(res.status, 404, "a deleted draft is not re-created by a late save");
  assert.ok(!existsSync(join(dir, ids.mid)));

  // A save already in flight when the draft is deleted (body still arriving) does not re-create its folder.
  {
    const body = JSON.stringify({ edits: [{ platform: "poshmark", title: "Late save" }] });
    const late = request(`${handle.url}/api/draft/${ids.busy}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), Cookie: cookie },
    });
    const answered = new Promise<number>((resolveStatus, reject) => {
      late.on("response", (r) => { r.resume(); r.on("end", () => resolveStatus(r.statusCode ?? 0)); });
      late.on("error", reject);
    });
    late.write(body.slice(0, 10));
    await new Promise((r) => setTimeout(r, 100));
    res = await api(`/api/draft/${ids.busy}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    late.end(body.slice(10));
    await answered;
    assert.ok(!existsSync(join(dir, ids.busy)), "the late save did not re-create the deleted draft");
  }

  // 5. TTL: a draft with a published result is the record of a live listing and is never swept.
  await cleanupExpiredDrafts(Date.now() + GUI_DRAFT_TTL_MS * 10);
  assert.ok(existsSync(join(dir, ids.old)), "published draft kept");
  assert.ok(!existsSync(join(dir, ids.fresh)), "not_posted/error draft expires");
  console.log("gui-drafts.test ok");
} finally {
  await handle.close();
  await rm(dir, { recursive: true, force: true });
}
