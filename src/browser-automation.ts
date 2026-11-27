// Sam's installed Chrome, on a dedicated profile, driven over CDP (E3, E9, E11, F5).
//
// The runner starts Chrome itself with `--user-data-dir=<profile>` and `--remote-debugging-port=0`
// (Chrome picks a random port on 127.0.0.1 and writes it to the profile's DevToolsActivePort),
// attaches with playwright-core's connectOverCDP, and closes that Chrome when the session ends.
// It never touches Sam's everyday Chrome profile: the profile is always passed explicitly and
// Chrome's own default user-data dirs are refused. Sam signs in to Depop by hand once, in this
// profile; Google and Apple sign-in work there because it is real Chrome, not a test browser.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLockFile, CliError, releaseLockFile } from "./draft-file.js";
import type { Platform } from "./types.js";

type BrowserMarket = Exclude<Platform, "ebay">;

// ---------- Playwright and URL checks (kept from the env-flow version) ----------

/** playwright-core only: no bundled browser, the runner attaches to installed Chrome (E6). */
export async function loadPlaywright(): Promise<any> {
  try {
    const specifier = "playwright-core" as string;
    return await import(specifier);
  } catch (error) {
    throw new CliError(
      "playwright_missing",
      `playwright-core is not installed: ${error instanceof Error ? error.message : String(error)}`,
      "Run `npm install` in the resell-agent folder."
    );
  }
}

export function expectedHost(platform: BrowserMarket): string {
  return platform === "poshmark" ? "poshmark.com" : "depop.com";
}

/** An https URL on the market's own domain (or a subdomain), with no credentials. */
export function isExpectedPlatformUrl(platform: BrowserMarket, value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const expected = expectedHost(platform);
  return parsed.protocol === "https:" && !parsed.username && !parsed.password && (host === expected || host.endsWith(`.${expected}`));
}

// ---------- Chrome location (F5) ----------

const MISSING_HINT = "Install Google Chrome, or set CHROME_PATH to the chrome executable.";

/** Where installed Chrome usually lives, per OS. */
export function chromeCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES ?? "C:\\Program Files", env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", env.LOCALAPPDATA].filter(Boolean) as string[];
    return roots.map((r) => join(r, "Google", "Chrome", "Application", "chrome.exe"));
  }
  if (platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"];
}

/** CHROME_PATH wins; otherwise the first installed Chrome. Throws `chrome_missing` with the fix (F5). */
export function findChrome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync
): string {
  const explicit = env.CHROME_PATH?.trim();
  if (explicit) {
    if (exists(explicit)) return explicit;
    throw new CliError("chrome_missing", `CHROME_PATH is set to ${explicit}, which doesn't exist.`, MISSING_HINT);
  }
  const found = chromeCandidates(env, platform).find((p) => exists(p));
  if (!found) throw new CliError("chrome_missing", "Google Chrome wasn't found on this computer.", MISSING_HINT);
  return found;
}

// ---------- the dedicated profile (D5) ----------

/** `%LOCALAPPDATA%\resell-agent\profiles` (D5); BROWSER_AUTOMATION_PROFILE_DIR overrides the root. */
export function profileRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.BROWSER_AUTOMATION_PROFILE_DIR?.trim();
  if (override) return resolve(override);
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "resell-agent", "profiles");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "resell-agent", "profiles");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "resell-agent", "profiles");
}

export function marketProfileDir(market: BrowserMarket, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(profileRoot(env, platform), market);
}

/** Chrome's own user-data dirs: the everyday profile. The runner never opens or attaches to these. */
function everydayChromeDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return [join(local, "Google", "Chrome", "User Data"), join(local, "Google", "Chrome Beta", "User Data"), join(local, "Microsoft", "Edge", "User Data")];
  }
  if (platform === "darwin") return [join(homedir(), "Library", "Application Support", "Google", "Chrome")];
  return [join(homedir(), ".config", "google-chrome")];
}

function inside(child: string, parent: string): boolean {
  const c = resolve(child).toLowerCase();
  const p = resolve(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Refuses any profile dir that is, or is inside, Chrome's everyday user-data dir. */
export function assertDedicatedProfile(dir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  const hit = everydayChromeDirs(env, platform).find((d) => inside(dir, d));
  if (hit) {
    throw new CliError(
      "profile_not_dedicated",
      `${dir} is inside Chrome's everyday profile (${hit}); resell only drives its own profile.`,
      "Unset BROWSER_AUTOMATION_PROFILE_DIR, or point it at an empty folder of its own."
    );
  }
}

/** One runner per market profile at a time (D5): `<profile>.lock`, pid-and-time, broken when its pid is dead. */
export async function acquireProfileLock(profileDir: string): Promise<() => void> {
  const lock = `${profileDir}.lock`;
  mkdirSync(resolve(profileDir, ".."), { recursive: true });
  if (!(await acquireLockFile(lock))) {
    throw new CliError(
      "depop_session_busy",
      "Another Depop session is already running on this computer.",
      `Finish that session first. A lock left by a run that died clears itself; if ${lock} persists, delete it.`
    );
  }
  return () => releaseLockFile(lock);
}

/** True when a Chrome holds this profile open (Windows: `lockfile` is busy; elsewhere: SingletonLock names a live pid). */
export function profileInUse(profileDir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") {
    const lock = join(profileDir, "lockfile");
    if (!existsSync(lock)) return false;
    try {
      unlinkSync(lock); // a lockfile nobody holds is left over from a closed Chrome
      return false;
    } catch (e: any) {
      return e?.code === "EBUSY" || e?.code === "EPERM";
    }
  }
  try {
    const target = readlinkSync(join(profileDir, "SingletonLock")); // "<host>-<pid>"
    const pid = Number(target.slice(target.lastIndexOf("-") + 1));
    if (!Number.isInteger(pid) || pid <= 0) return true;
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

// ---------- launch or attach (E3, E9) ----------

export interface ChromeOptions {
  profileDir: string;
  chromePath?: string;
  /** Tests only: assisted fill always runs headful for Sam. */
  headless?: boolean;
  startTimeoutMs?: number;
}

export interface ChromeHandle {
  browser: any;
  context: any;
  port: number;
  /** True when an already-running profile Chrome was found and attached to. */
  attached: boolean;
  /** Closes that Chrome (normal end, Ctrl-C, or error, E9). Never throws. */
  close(): Promise<void>;
}

function portFile(profileDir: string): string {
  return join(profileDir, "DevToolsActivePort");
}

function readPort(profileDir: string): number | null {
  try {
    const port = Number(readFileSync(portFile(profileDir), "utf8").split(/\r?\n/)[0]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

async function portAnswers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function busyProfile(): CliError {
  return new CliError(
    "depop_chrome_open",
    "The Depop Chrome window is open without the automation port.",
    "Close the Depop Chrome window and re-run."
  );
}

export function chromeArgs(profileDir: string, headless = false): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    // The rolling window fills tabs in the background while Sam reviews another (E4): don't throttle them.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ];
}

/**
 * Attach to the profile's Chrome if one is running with its port (a runner that died left it, E11),
 * stop if one is running without a port, otherwise start one. The port is never fixed (E9).
 */
export async function launchOrAttachChrome(opts: ChromeOptions): Promise<ChromeHandle> {
  const profileDir = resolve(opts.profileDir);
  assertDedicatedProfile(profileDir);
  mkdirSync(profileDir, { recursive: true });
  const { chromium } = await loadPlaywright();

  let port = readPort(profileDir);
  let child: ChildProcess | null = null;
  const attached = port !== null && (await portAnswers(port));
  if (!attached) {
    if (profileInUse(profileDir)) throw busyProfile();
    try {
      unlinkSync(portFile(profileDir)); // stale: Chrome leaves it behind when it exits
    } catch {
      /* none */
    }
    const chromePath = opts.chromePath ?? findChrome();
    let exitCode: number | null | undefined;
    let spawnError: Error | undefined;
    child = spawn(chromePath, chromeArgs(profileDir, opts.headless), { stdio: "ignore" });
    child.once("error", (e) => (spawnError = e));
    child.once("exit", (code) => (exitCode = code));
    const deadline = Date.now() + (opts.startTimeoutMs ?? 30_000);
    port = null;
    while (Date.now() < deadline) {
      if (spawnError) throw new CliError("chrome_missing", `Chrome didn't start (${chromePath}): ${spawnError.message}`, MISSING_HINT);
      // Exiting at once means another Chrome on this profile took the request (it has no port for us).
      if (exitCode !== undefined) throw busyProfile();
      port = readPort(profileDir);
      if (port !== null && (await portAnswers(port))) break;
      port = null;
      await delay(100);
    }
    if (port === null) {
      child.kill();
      throw new CliError("chrome_start_timeout", "Chrome started but never opened its automation port.", "Close any Depop Chrome window and re-run.");
    }
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  let closed = false;
  return {
    browser,
    context,
    port: port!,
    attached,
    async close() {
      if (closed) return;
      closed = true;
      try {
        const cdp = await browser.newBrowserCDPSession();
        await cdp.send("Browser.close");
      } catch {
        /* already gone */
      }
      try {
        await browser.close();
      } catch {
        /* disconnected */
      }
      if (child && child.exitCode === null) {
        const exited = new Promise((r) => child!.once("exit", r));
        await Promise.race([exited, delay(5_000)]);
        if (child.exitCode === null) child.kill();
      }
    },
  };
}
