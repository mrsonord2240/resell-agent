// The Depop Chrome's identity: where Chrome is (F5), the dedicated profile (D5), the refusal to use
// Chrome's everyday profile, and the one-runner profile lock. No browser is started here.
// Run: npm test
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireProfileLock,
  assertDedicatedProfile,
  chromeArgs,
  findChrome,
  isExpectedPlatformUrl,
  marketProfileDir,
  profileInUse,
} from "./browser-automation.js";
import { CliError } from "./draft-file.js";
import { openDepopSession } from "./depop-fill.js";

const isCode = (code: string) => (e: unknown) => e instanceof CliError && e.code === code;

// F5: CHROME_PATH wins; a missing Chrome is a clear error naming the fix, not a stack trace.
assert.strictEqual(findChrome({ CHROME_PATH: "C:\\x\\chrome.exe" }, "win32", (p) => p === "C:\\x\\chrome.exe"), "C:\\x\\chrome.exe");
assert.throws(() => findChrome({ CHROME_PATH: "C:\\nope\\chrome.exe" }, "win32", () => false), (e: unknown) => isCode("chrome_missing")(e) && /CHROME_PATH/.test((e as CliError).hint ?? ""));
assert.throws(() => findChrome({}, "win32", () => false), (e: unknown) => isCode("chrome_missing")(e) && /Install Google Chrome/.test((e as CliError).hint ?? ""));
const progFiles = join("C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
assert.strictEqual(findChrome({ PROGRAMFILES: "C:\\Program Files" }, "win32", (p) => p === progFiles), progFiles);
assert.strictEqual(
  findChrome({}, "darwin", (p) => p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "macOS keeps working"
);

// D5: %LOCALAPPDATA%\resell-agent\profiles\<market>; BROWSER_AUTOMATION_PROFILE_DIR overrides the root.
assert.strictEqual(marketProfileDir("depop", { LOCALAPPDATA: "C:\\Users\\S\\AppData\\Local" }, "win32"), join("C:\\Users\\S\\AppData\\Local", "resell-agent", "profiles", "depop"));
assert.strictEqual(marketProfileDir("depop", { BROWSER_AUTOMATION_PROFILE_DIR: "D:\\p" }, "win32"), join("D:\\p", "depop"));

// Never Sam's everyday Chrome profile.
const local = "C:\\Users\\S\\AppData\\Local";
assert.throws(() => assertDedicatedProfile(join(local, "Google", "Chrome", "User Data"), { LOCALAPPDATA: local }, "win32"), isCode("profile_not_dedicated"));
assert.throws(() => assertDedicatedProfile(join(local, "Google", "Chrome", "User Data", "Default"), { LOCALAPPDATA: local }, "win32"), isCode("profile_not_dedicated"));
assertDedicatedProfile(join(local, "resell-agent", "profiles", "depop"), { LOCALAPPDATA: local }, "win32");

// E9: a random port bound to 127.0.0.1, the profile passed explicitly, headful unless a test asks.
const args = chromeArgs("C:\\p\\depop");
assert.ok(args.includes("--remote-debugging-port=0"));
assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
assert.ok(args.includes("--user-data-dir=C:\\p\\depop"));
assert.ok(!args.some((a) => a.startsWith("--headless")), "assisted fill always runs headful");

// URL host check (kept).
assert.ok(isExpectedPlatformUrl("depop", "https://www.depop.com/products/x/"));
assert.ok(!isExpectedPlatformUrl("depop", "http://www.depop.com/products/x/"));
assert.ok(!isExpectedPlatformUrl("depop", "https://depop.com.evil.example/x"));

// One runner per profile: a live holder refuses a second session before Chrome is looked at or started.
{
  const root = mkdtempSync(join(tmpdir(), "resell-profile-"));
  const dir = join(root, "depop");
  const release = await acquireProfileLock(dir);
  await assert.rejects(acquireProfileLock(dir), isCode("depop_session_busy"));
  await assert.rejects(openDepopSession({ profileDir: dir, chromePath: process.execPath }), isCode("depop_session_busy"));
  release();
  // A lock left by a dead runner is broken.
  writeFileSync(`${dir}.lock`, JSON.stringify({ pid: 2_147_483_644, time: 0 }));
  (await acquireProfileLock(dir))();
  // No Chrome holds a fresh profile.
  assert.strictEqual(profileInUse(dir), false);
}

console.log("browser-automation ok");
