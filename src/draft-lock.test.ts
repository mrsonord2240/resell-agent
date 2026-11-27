// The draft lock (O8) and the short-lock Depop fill (E7, E11, C2), without live services.
// Run: npm test
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  beginFill,
  CliError,
  finishFill,
  newDraftFile,
  postDraft,
  readDraftFile,
  withDraftLock,
  writeDraftFile,
} from "./draft-file.js";
import type { BrowserSession, PlatformPublishResult } from "./publish.js";
import type { DraftBundle } from "./types.js";

process.env.EBAY_ENV = "production";

const bundle: DraftBundle = {
  attributes: {
    brand: "Patagonia", brandInferred: false, productName: null, category: "Fleece Jacket", titleKeywords: [],
    size: "M", color: "green", material: "fleece", condition: "good", flaws: [], dimensions: null, originalRetail: 139,
  },
  price: { suggested: 68, low: 55, high: 82, currency: "USD", basis: "test", sampleSize: 5 },
  comps: [], comparison: [], retail: [],
  listings: [
    { platform: "ebay", title: "Patagonia Fleece", description: "d", price: 68, condition: "good", categoryId: "57988" },
    { platform: "depop", title: "Fleece", description: "d", price: 68, condition: "good" },
  ],
};

const dir = mkdtempSync(join(tmpdir(), "resell-draftlock-"));
let n = 0;
/** A fresh draft whose eBay entry is already live, so only Depop is in play. */
function freshDraft(): string {
  const path = join(dir, `draft-${++n}.json`);
  const file = newDraftFile(bundle, [join(dir, "a.jpg")]);
  file.publishResults = [{ platform: "ebay", status: "published", message: "live", listingId: "l1", env: "production" }];
  writeDraftFile(path, file);
  return path;
}
const entry = (path: string, platform: string) => readDraftFile(path).publishResults.find((r) => r.platform === platform);
const depopPosted: PlatformPublishResult = { platform: "depop", status: "published", message: "posted", url: "https://www.depop.com/products/a" };
const isLocked = (e: unknown) => e instanceof CliError && e.code === "draft_locked";

// The lock file records the holder's pid and time, and is removed afterwards.
{
  const path = freshDraft();
  await withDraftLock(path, async () => {
    const lock = JSON.parse(readFileSync(`${path}.lock`, "utf8"));
    assert.strictEqual(lock.pid, process.pid);
    assert.strictEqual(typeof lock.time, "number");
  });
  assert.ok(!existsSync(`${path}.lock`));
}

// Stale-lock break (O8): a dead pid's lock is broken; a live pid's lock (ours) is not.
{
  const path = freshDraft();
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.ok(dead, "spawned a short-lived process for a dead pid");
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: dead, time: Date.now() }));
  assert.strictEqual(await withDraftLock(path, async () => "ran"), "ran");
  assert.ok(!existsSync(`${path}.lock`));

  writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, time: Date.now() }));
  await assert.rejects(withDraftLock(path, async () => "ran"), isLocked);
  assert.ok(existsSync(`${path}.lock`), "a live lock is left in place");

  // An old-format (empty) lock is judged by age: fresh blocks, older than 10 minutes is broken.
  writeFileSync(`${path}.lock`, "");
  await assert.rejects(withDraftLock(path, async () => "ran"), isLocked);
  const old = (Date.now() - 11 * 60_000) / 1000;
  utimesSync(`${path}.lock`, old, old);
  assert.strictEqual(await withDraftLock(path, async () => "ran"), "ran");
}

// beginFill writes `filling` with an attempt id and leaves the lock free for the wait.
{
  const path = freshDraft();
  const attemptId = await beginFill(path, "depop");
  assert.ok(attemptId);
  assert.deepStrictEqual([entry(path, "depop")?.status, entry(path, "depop")?.attemptId], ["filling", attemptId]);
  assert.ok(!existsSync(`${path}.lock`));
}

// Re-read merge: another writer changes eBay during the wait; that change survives and only Depop is merged.
{
  const path = freshDraft();
  const attemptId = await beginFill(path, "depop");
  await withDraftLock(path, async () => {
    const other = readDraftFile(path);
    other.publishResults = other.publishResults.map((r) => (r.platform === "ebay" ? { ...r, listingId: "l2", message: "relisted" } : r));
    writeDraftFile(path, other);
  });
  const out = await finishFill(path, "depop", attemptId, depopPosted, { submitSeen: true });
  assert.strictEqual(out.recorded, true);
  assert.strictEqual(entry(path, "ebay")?.listingId, "l2", "the other writer's eBay change survives");
  assert.deepStrictEqual([entry(path, "depop")?.status, entry(path, "depop")?.url, entry(path, "depop")?.attemptId], ["published", depopPosted.url, attemptId]);
}

// Mark during the wait: (a) no submit seen -> the mark stands; (b) submit seen -> unknown.
for (const submitSeen of [false, true]) {
  const path = freshDraft();
  const attemptId = await beginFill(path, "depop");
  await withDraftLock(path, async () => {
    const marked = readDraftFile(path);
    marked.publishResults = marked.publishResults.map((r) => (r.platform === "depop" ? { platform: "depop", status: "not_posted", message: "marked not posted by Sam" } : r));
    writeDraftFile(path, marked);
  });
  const tabResult: PlatformPublishResult = submitSeen ? { ...depopPosted, status: "unknown", url: undefined } : { platform: "depop", status: "not_posted", message: "tab closed" };
  const out = await finishFill(path, "depop", attemptId, tabResult, { submitSeen });
  assert.strictEqual(out.recorded, true);
  assert.strictEqual(entry(path, "depop")?.status, submitSeen ? "unknown" : "not_posted");
  if (!submitSeen) assert.strictEqual(entry(path, "depop")?.message, "marked not posted by Sam");
  assert.strictEqual(out.result.status, entry(path, "depop")?.status);
}

// Mismatched attempt id (E11): a late result from an older attempt records unknown, even a clean publish.
{
  const path = freshDraft();
  const older = await beginFill(path, "depop");
  const newer = await beginFill(path, "depop");
  assert.notStrictEqual(older, newer);
  const out = await finishFill(path, "depop", older, depopPosted, { submitSeen: true });
  assert.strictEqual(out.recorded, true);
  assert.strictEqual(entry(path, "depop")?.status, "unknown");
  assert.strictEqual(entry(path, "depop")?.url, depopPosted.url, "the captured URL is kept for verification");
}

// Lock contention at submit (C2): held past the 30 s wait -> returned as not recorded, nothing thrown, file unchanged.
{
  const path = freshDraft();
  const attemptId = await beginFill(path, "depop");
  const before = readFileSync(path, "utf8");
  let clock = 0;
  const waited: number[] = [];
  const out = await withDraftLock(path, () =>
    finishFill(path, "depop", attemptId, depopPosted, {
      submitSeen: true,
      lock: { now: () => clock, sleep: async (ms) => { waited.push(ms); clock += ms; } },
    })
  );
  assert.strictEqual(out.recorded, false);
  assert.deepStrictEqual(out.result, depopPosted, "the result comes back intact for the run log");
  assert.ok(clock >= 30_000 && clock < 31_000, `waited the full 30 s (fake clock ${clock})`);
  assert.ok(waited.length > 1, "retried the lock while waiting");
  assert.strictEqual(readFileSync(path, "utf8"), before);
}

// The same wait succeeds when the holder lets go partway through.
{
  const path = freshDraft();
  const attemptId = await beginFill(path, "depop");
  let clock = 0;
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, time: Date.now() }));
  const out = await finishFill(path, "depop", attemptId, depopPosted, {
    submitSeen: true,
    lock: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (clock >= 5_000 && existsSync(`${path}.lock`)) unlinkSync(`${path}.lock`);
      },
    },
  });
  assert.strictEqual(out.recorded, true);
  assert.strictEqual(entry(path, "depop")?.status, "published");
}

// postDraft with a session: the wait runs unlocked, `filling` is on disk during it, the result is merged after.
{
  const path = freshDraft();
  const session: BrowserSession = {
    fill: async () => {
      assert.strictEqual(entry(path, "depop")?.status, "filling", "filling is durable before the wait");
      // An overnight eBay run (or `resell mark`) can take the lock while the tab waits.
      await withDraftLock(path, async () => {
        const other = readDraftFile(path);
        other.publishResults = other.publishResults.map((r) => (r.platform === "ebay" ? { ...r, message: "touched during wait" } : r));
        writeDraftFile(path, other);
      });
      return { status: "published", message: "posted", url: depopPosted.url };
    },
  };
  const outcome = await postDraft({ draftPath: path, platforms: ["depop"] }, { browserSession: session });
  assert.strictEqual(outcome.complete, true);
  assert.deepStrictEqual(outcome.results.map((r) => r.status), ["published"]);
  assert.strictEqual(entry(path, "ebay")?.message, "touched during wait");
  assert.strictEqual(entry(path, "depop")?.status, "published");
  assert.ok(!existsSync(`${path}.lock`));

  // A re-run skips the published Depop entry; a prior unknown is skipped too and stays incomplete (O9).
  const rerun = await postDraft({ draftPath: path, platforms: ["depop"] }, { browserSession: { fill: async () => assert.fail("must not refill") } });
  assert.deepStrictEqual(rerun.results.map((r) => r.status), ["skipped"]);
  assert.strictEqual(rerun.complete, true);
}
{
  const path = freshDraft();
  const file = readDraftFile(path);
  file.publishResults.push({ platform: "depop", status: "filling", message: "stale", attemptId: "dead-run" });
  writeDraftFile(path, file);
  const rerun = await postDraft({ draftPath: path, platforms: ["ebay", "depop"] }, {
    publishEbay: async () => assert.fail("eBay is already live in production"),
    browserSession: { fill: async () => assert.fail("a stale filling is verify-first") },
  });
  assert.deepStrictEqual(rerun.results.map((r) => r.status), ["skipped", "skipped"]);
  assert.strictEqual(rerun.complete, false, "filling reads as unknown: incomplete");
}

// postDraft with a session whose result write cannot get the lock: reported unknown, URL kept, `filling` left on disk.
{
  const path = freshDraft();
  const outcome = await postDraft(
    { draftPath: path, platforms: ["depop"], fillLock: { now: (() => { let t = 0; return () => (t += 1_000); })(), sleep: async () => {} } },
    {
      browserSession: {
        fill: async () => {
          writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, time: Date.now() }));
          return { status: "published", message: "posted", url: depopPosted.url };
        },
      },
    }
  );
  assert.strictEqual(outcome.results[0].status, "unknown");
  assert.strictEqual(outcome.results[0].url, depopPosted.url);
  assert.match(outcome.results[0].message, /not recorded/i);
  assert.strictEqual(entry(path, "depop")?.status, "filling");
  assert.strictEqual(outcome.complete, false);
}

console.log("draft-lock ok");
