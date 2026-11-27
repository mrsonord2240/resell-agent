// GUI mark endpoint and the TTL sweep that never deletes a draft Sam still has to resolve (O7).
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "resell-agent-gui-mark-"));
process.env.GUI_DATA_DIR = dir;
process.env.GUI_ALLOW_REMOTE = "";
process.env.GUI_HOST = "";

const { startGui, cleanupExpiredDrafts, GUI_DRAFT_TTL_MS } = await import("./gui.js");

const ids = {
  unknown: "a0000000-0000-4000-8000-000000000001",
  filling: "a0000000-0000-4000-8000-000000000002",
  pubMark: "a0000000-0000-4000-8000-000000000005",
  heldMark: "a0000000-0000-4000-8000-000000000007",
  notPosted: "a0000000-0000-4000-8000-000000000006",
};

const sweep = {
  unknown: "b0000000-0000-4000-8000-000000000001",
  filling: "b0000000-0000-4000-8000-000000000002",
  published: "b0000000-0000-4000-8000-000000000003",
  plain: "b0000000-0000-4000-8000-000000000004",
};

function fixture(id: string, publishResults: unknown[]): void {
  mkdirSync(join(dir, id), { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(
    join(dir, id, "draft.json"),
    JSON.stringify({ draftId: id, draft: { attributes: {}, listings: [] }, photos: [], createdAt: at, updatedAt: at, publishResults })
  );
}
const depop = (status: string, extra: object = {}) => ({ platform: "depop", status, message: status, ...extra });
fixture(ids.unknown, [depop("unknown", { url: "https://www.depop.com/products/x/" })]);
fixture(ids.filling, [depop("filling", { attemptId: "att-1" })]);
fixture(sweep.unknown, [depop("unknown")]);
fixture(sweep.filling, [depop("filling", { attemptId: "att-2" })]);
fixture(sweep.published, [depop("published", { url: "https://www.depop.com/products/z/" })]);
fixture(sweep.plain, []);
fixture(ids.pubMark, [depop("published", { url: "https://www.depop.com/products/y/" })]);
fixture(ids.heldMark, [depop("held")]);
fixture(ids.notPosted, [depop("unknown")]);

const handle = await startGui(0);
try {
  // Mark endpoint.
  const first = await fetch(handle.url);
  const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
  const mark = (id: string, body: unknown) =>
    fetch(`${handle.url}/api/draft/${id}/mark`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });

  let res = await mark(ids.unknown, { market: "depop", action: "posted", url: "https://www.depop.com/products/new/" });
  assert.equal(res.status, 200);
  let payload = (await res.json()) as { publishResults: { platform: string; status: string; url?: string }[] };
  assert.equal(payload.publishResults[0].status, "published");
  assert.equal(payload.publishResults[0].url, "https://www.depop.com/products/new/");
  const got = (await (await fetch(`${handle.url}/api/draft/${ids.unknown}`, { headers: { Cookie: cookie } })).json()) as typeof payload;
  assert.equal(got.publishResults[0].status, "published", "the mark is stored on the draft");

  res = await mark(ids.filling, { market: "depop", action: "not_posted" });
  assert.equal(res.status, 200);
  payload = (await res.json()) as typeof payload;
  assert.equal(payload.publishResults[0].status, "not_posted");

  // Validation and transitions.
  res = await mark(ids.notPosted, { market: "depop", action: "posted", url: "https://depop.com.evil.example/x" });
  assert.equal(res.status, 400, "off-host URL refused");
  res = await mark(ids.notPosted, { market: "depop", action: "posted", url: "http://www.depop.com/x" });
  assert.equal(res.status, 400, "non-https URL refused");
  res = await mark(ids.notPosted, { market: "depop", action: "posted" });
  assert.equal(res.status, 400, "posted needs a URL");
  res = await mark(ids.notPosted, { market: "ebay", action: "not_posted" });
  assert.equal(res.status, 400, "eBay cannot be marked");
  res = await mark(ids.notPosted, { market: "depop", action: "bogus" });
  assert.equal(res.status, 400);
  res = await mark(ids.pubMark, { market: "depop", action: "not_posted" });
  assert.equal(res.status, 409, "published is final");
  res = await mark(ids.heldMark, { market: "depop", action: "not_posted" });
  assert.equal(res.status, 409, "held needs approval first");
  res = await mark("a0000000-0000-4000-8000-0000000000ff", { market: "depop", action: "not_posted" });
  assert.equal(res.status, 404);
  res = await fetch(`${handle.url}/api/draft/${ids.notPosted}/mark`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "http://evil.example" },
    body: JSON.stringify({ market: "depop", action: "not_posted" }),
  });
  assert.equal(res.status, 403, "origin check applies");
  res = await fetch(`${handle.url}/api/draft/${ids.notPosted}/mark`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ market: "depop", action: "not_posted" }),
  });
  assert.equal(res.status, 401, "token check applies");
  // TTL: with every draft long expired, only the unresolved ones survive (run last: it also sweeps the mark fixtures).
  await cleanupExpiredDrafts(Date.now() + GUI_DRAFT_TTL_MS * 10);
  assert.ok(existsSync(join(dir, sweep.unknown)), "unknown draft kept");
  assert.ok(existsSync(join(dir, sweep.filling)), "filling draft kept");
  assert.ok(!existsSync(join(dir, sweep.published)), "published draft expires");
  assert.ok(!existsSync(join(dir, sweep.plain)), "draft with no results expires");
  console.log("gui-mark.test ok");
} finally {
  await handle.close();
  await rm(dir, { recursive: true, force: true });
}
