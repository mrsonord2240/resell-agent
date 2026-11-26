#!/usr/bin/env node
import "./load-env.js"; // first: later modules may read env at load time
import { writeFileSync } from "node:fs";
import { buildDraft } from "./pipeline.js";
import { renderSheet } from "./sheet.js";
import { buildConsentUrl, exchangeCode } from "./ebay/auth.js";
import { startGui } from "./gui.js";
import { CliError, newDraftFile, parsePlatforms, postDraft, readDraftFile, writeDraftFile, type DraftFile } from "./draft-file.js";
import type { PlatformPublishResult } from "./publish.js";

// Every command works two ways. Plain: prose for a person. With --json: stdout
// carries exactly one envelope, {ok, command, data, error}, and all progress and
// library logging goes to stderr. Exit codes: 0 ok, 1 error, 2 usage,
// 3 publish incomplete (some platform errored or is unknown; data has results).

const argv = process.argv.slice(2);
const json = argv.includes("--json");

function arg(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
}
const has = (flag: string) => argv.includes(flag);
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const say = (...parts: unknown[]) => console.log(...parts);

interface CommandSpec {
  summary: string;
  usage: string;
  flags: Record<string, string>;
  run: () => Promise<unknown>;
}

const PLATFORMS_FLAG = "comma list of ebay, poshmark, depop";

const COMMANDS: Record<string, CommandSpec> = {
  draft: {
    summary: "Photos -> attributes, comps, price and per-platform listing copy. Read-only.",
    usage: "draft --photos a.jpg,b.jpg [--notes '...'] [--platforms ebay,poshmark,depop] [--clean] [--image-url https://...] [--out draft.json]",
    flags: {
      "--photos": "comma list of photo paths (required)",
      "--notes": "seller notes: flaws, measurements, provenance",
      "--platforms": `${PLATFORMS_FLAG} (default all; omitting ebay skips eBay comps)`,
      "--clean": "remove backgrounds first; writes *.clean.png beside each photo",
      "--image-url": "public photo URL for the optional reverse-image brand lookup",
      "--out": "draft file path (default draft.json); a .md paste sheet is written beside it",
    },
    run: cmdDraft,
  },
  outfit: {
    summary: "Detect every sellable piece in one photo and draft each separately.",
    usage: "outfit --photos look.jpg [--notes '...'] [--platforms ...] [--out outfit]",
    flags: {
      "--photos": "one photo path (required)",
      "--notes": "notes applied to every piece",
      "--platforms": PLATFORMS_FLAG,
      "--out": "output prefix (default outfit): <out>.svg, <out>-N.json drafts, <out>-N.md sheets",
    },
    run: cmdOutfit,
  },
  status: {
    summary: "Show a draft's listings, price and per-platform publish state.",
    usage: "status [--draft draft.json]",
    flags: { "--draft": "draft file (default draft.json)" },
    run: cmdStatus,
  },
  post: {
    summary: "Publish a draft to one or more platforms. Retries skip platforms already published.",
    usage: "post [--draft draft.json] [--platforms ebay,poshmark,depop] [eBay flags] [--headful]",
    flags: {
      "--draft": "draft file (default draft.json); publish results are saved back into it",
      "--platforms": `${PLATFORMS_FLAG} (default every platform in the draft)`,
      "--images": "eBay: comma list of public HTTPS image URLs",
      "--location": "eBay: merchant location key (env GUI_DEFAULT_MERCHANT_LOCATION_KEY)",
      "--fulfillment": "eBay: fulfillment policy id (env GUI_DEFAULT_FULFILLMENT_POLICY_ID)",
      "--payment": "eBay: payment policy id (env GUI_DEFAULT_PAYMENT_POLICY_ID)",
      "--return": "eBay: return policy id (env GUI_DEFAULT_RETURN_POLICY_ID)",
      "--category": "eBay: category id override (default: resolved at draft time)",
      "--quantity": "eBay: quantity (default 1)",
      "--sku": "eBay: explicit SKU (default: stable per draft)",
      "--headful": "Poshmark/Depop: show the browser window",
    },
    run: cmdPost,
  },
  index: {
    summary: "Embed your own reference photos into a local brand-match library.",
    usage: "index [--dir refs] [--out brand-index.json]",
    flags: { "--dir": "folder of refs/<Brand>/*.jpg (default refs)", "--out": "index path (default brand-index.json)" },
    run: cmdIndex,
  },
  gui: {
    summary: "Start the local review-and-publish dashboard.",
    usage: "gui [--port 3000]",
    flags: { "--port": "port (default GUI_PORT or 3000)" },
    run: cmdGui,
  },
  "auth-url": {
    summary: "Print the eBay consent URL for the one-time posting sign-in.",
    usage: "auth-url",
    flags: {},
    run: cmdAuthUrl,
  },
  "auth-exchange": {
    summary: "Exchange the consent code for EBAY_USER_REFRESH_TOKEN.",
    usage: "auth-exchange <code>",
    flags: {},
    run: cmdAuthExchange,
  },
  help: {
    summary: "List commands and flags. `help <command>` for one.",
    usage: "help [command]",
    flags: {},
    run: cmdHelp,
  },
};

const GLOBAL_FLAGS = { "--json": "machine output: one {ok, command, data, error} envelope on stdout; logs to stderr" };

function usage(message: string): never {
  throw new CliError("usage", message, `Usage: ${COMMANDS[argv[0]]?.usage ?? "help"}`, 2);
}

function draftSummary(file: DraftFile, path: string) {
  const { comps, ...rest } = file;
  return { draft: path, compCount: comps.length, ...rest };
}

async function cmdDraft() {
  const photos = list(arg("--photos"));
  if (!photos.length) usage("--photos is required");
  const notes = arg("--notes") ?? "";
  const platforms = parsePlatforms(arg("--platforms")) ?? ["ebay", "poshmark", "depop"];
  const out = arg("--out") ?? "draft.json";

  // --clean: remove backgrounds first. Cleaner input -> better attribute extraction,
  // and the .clean.png files are listing-ready (host them for `post --images`).
  let usePhotos = photos;
  if (has("--clean")) {
    const { cleanPhoto } = await import("./brain/bgremove.js");
    usePhotos = [];
    for (const p of photos) {
      const cleaned = await cleanPhoto(p);
      console.error(`cleaned ${p} -> ${cleaned}`);
      usePhotos.push(cleaned);
    }
  }

  const file = newDraftFile(await buildDraft(usePhotos, notes, platforms, arg("--image-url")), usePhotos);
  writeDraftFile(out, file);
  const sheet = out.replace(/\.json$/i, "") + ".md";
  writeFileSync(sheet, renderSheet(file, usePhotos));

  if (!json) {
    const p = file.price;
    say(`\nAttributes: ${file.attributes.brand ?? "?"} ${file.attributes.category} (${file.attributes.condition})`);
    say(p.suggested > 0 ? `Price: ${p.low}–${p.high} ${p.currency}  (start around ${p.suggested}, adjust)` : `Price: no comps found — set it manually`);
    say(`Basis: ${p.basis}`);
    if (file.comparison.length) {
      say(`\nCross-platform comps:`);
      for (const s of file.comparison) say(`  ${s.source.padEnd(16)} ${String(s.median).padStart(7)}  [${s.low}-${s.high}]  n=${s.n}`);
    }
    for (const l of file.listings) {
      say(`\n--- ${l.platform} ---\n${l.title}\n${l.description}`);
      if (l.platform === "ebay") {
        say(`category: ${l.categoryId ?? "(unresolved — pass --category on post)"}`);
        const specs = Object.entries(l.itemSpecifics ?? {});
        if (specs.length) say(`item specifics (${specs.length}): ${specs.map(([k, v]) => `${k}=${v.join("/")}`).join(", ")}`);
      }
    }
    say(`\nSaved ${out} (data) and ${sheet} (paste sheet). Review, then: post --draft ${out}`);
  }
  return { ...draftSummary(file, out), sheet };
}

async function cmdOutfit() {
  const photo = list(arg("--photos") ?? arg("--photo"))[0];
  if (!photo) usage("--photos is required");
  const outBase = arg("--out") ?? "outfit";
  const platforms = parsePlatforms(arg("--platforms")) ?? ["ebay", "poshmark", "depop"];
  const { buildOutfit, renderDetectionSvg } = await import("./outfit.js");
  console.error(`Detecting pieces in ${photo} ...`);
  const items = await buildOutfit(photo, arg("--notes") ?? "", platforms);
  const pieces = items.map((it, i) => {
    const draft = `${outBase}-${i + 1}.json`;
    const sheet = `${outBase}-${i + 1}.md`;
    writeDraftFile(draft, newDraftFile(it.draft, [it.crop]));
    writeFileSync(sheet, renderSheet(it.draft, [it.crop]));
    return { label: it.label, box: it.box, crop: it.crop, draft, sheet, price: it.draft.price, brand: it.draft.attributes.brand, brandInferred: it.draft.attributes.brandInferred };
  });
  const svg = items.length ? `${outBase}.svg` : null;
  if (svg) writeFileSync(svg, await renderDetectionSvg(photo, items));

  if (!json) {
    if (!pieces.length) say("No sellable pieces detected.");
    else {
      say(`\nDetected ${pieces.length} piece(s):`);
      pieces.forEach((p, i) => {
        const price = p.price.suggested > 0 ? `${p.price.low}-${p.price.high} ${p.price.currency}` : "set manually";
        const brand = p.brand ? ` · ${p.brand}${p.brandInferred ? " (verify)" : ""}` : "";
        say(`  ${i + 1}. ${p.label} — ${price}${brand}  -> ${p.draft}`);
      });
      say(`\nWrote ${svg}, ${pieces.length} draft(s) and sheet(s). Review before posting.`);
    }
  }
  return { svg, pieces };
}

async function cmdStatus() {
  const path = arg("--draft") ?? "draft.json";
  const file = readDraftFile(path);
  const results = new Map(file.publishResults.map((r) => [r.platform, r]));
  const listings = file.listings.map((l) => ({
    platform: l.platform,
    title: l.title,
    price: l.price,
    categoryId: l.categoryId,
    publish: results.get(l.platform) ?? null,
  }));
  if (!json) {
    say(`${path}  ${file.attributes.brand ?? "?"} ${file.attributes.category}  suggested ${file.price.suggested} ${file.price.currency}`);
    for (const l of listings) {
      say(`  ${l.platform.padEnd(9)} ${String(l.price).padStart(7)}  ${(l.publish?.status ?? "not posted").padEnd(10)} ${l.title}`);
      if (l.publish && l.publish.status !== "published") say(`            ${l.publish.message}`);
    }
  }
  return { draft: path, draftId: file.draftId, price: file.price, photos: file.photos, listings };
}

function printResults(results: PlatformPublishResult[]) {
  for (const r of results) say(`  ${r.platform.padEnd(9)} ${r.status.padEnd(10)} ${r.message}${r.url ? `  ${r.url}` : ""}`);
}

async function cmdPost() {
  const draftPath = arg("--draft") ?? "draft.json";
  const quantity = arg("--quantity");
  const outcome = await postDraft({
    draftPath,
    platforms: parsePlatforms(arg("--platforms")),
    headful: has("--headful"),
    ebay: {
      imageUrls: list(arg("--images")),
      merchantLocationKey: arg("--location"),
      fulfillmentPolicyId: arg("--fulfillment"),
      paymentPolicyId: arg("--payment"),
      returnPolicyId: arg("--return"),
      categoryId: arg("--category"),
      quantity: quantity === undefined ? undefined : Number(quantity),
      sku: arg("--sku"),
    },
  });
  if (!json) {
    say(`Publish results for ${draftPath}:`);
    printResults(outcome.results);
  }
  if (!outcome.complete) {
    throw Object.assign(
      new CliError(
        "publish_incomplete",
        "Not every platform published.",
        "Fix the errored platforms and re-run post; published ones are skipped. Check any 'unknown' platform by hand before retrying, it may already be live.",
        3
      ),
      { data: { draft: draftPath, ...outcome } }
    );
  }
  return { draft: draftPath, ...outcome };
}

async function cmdIndex() {
  const dir = arg("--dir") ?? "refs";
  const out = arg("--out") ?? "brand-index.json";
  const { buildIndex, saveIndex } = await import("./nnindex.js");
  console.error(`Embedding reference photos in ${dir}/ (first run downloads the model)...`);
  const idx = await buildIndex(dir);
  saveIndex(out, idx);
  const labels = [...new Set(idx.entries.map((e) => e.label))];
  if (!json) say(`Indexed ${idx.entries.length} photos across ${labels.length} labels -> ${out}. Set ENABLE_BRAND_MATCH=1 to use it.`);
  return { out, photos: idx.entries.length, labels };
}

async function cmdGui() {
  const port = Number(arg("--port") ?? (process.env.GUI_PORT || 3000));
  await startGui(Number.isFinite(port) ? port : 3000);
  return undefined;
}

async function cmdAuthUrl() {
  const url = buildConsentUrl();
  if (!json) say(`Open this URL, sign in, approve, then copy the ?code= value from the redirect:\n\n${url}`);
  return { url };
}

async function cmdAuthExchange() {
  const code = argv.slice(1).find((a) => !a.startsWith("--"));
  if (!code) usage("the consent code is required");
  const t = await exchangeCode(decodeURIComponent(code));
  if (!json) say(`\nAdd this to your .env:\n\nEBAY_USER_REFRESH_TOKEN=${t.refresh_token}`);
  return { refreshToken: t.refresh_token };
}

async function cmdHelp() {
  const name = argv.slice(1).find((a) => !a.startsWith("--"));
  if (name && !COMMANDS[name]) usage(`unknown command: ${name}`);
  const names = name ? [name] : Object.keys(COMMANDS);
  const spec = names.map((n) => ({ name: n, summary: COMMANDS[n].summary, usage: COMMANDS[n].usage, flags: COMMANDS[n].flags }));
  if (!json) {
    for (const c of spec) {
      say(`${c.usage}\n  ${c.summary}`);
      for (const [f, d] of Object.entries(c.flags)) say(`    ${f.padEnd(14)} ${d}`);
      say("");
    }
    say(`Global:\n    ${"--json".padEnd(14)} ${GLOBAL_FLAGS["--json"]}`);
    say(`Exit codes: 0 ok, 1 error, 2 usage, 3 publish incomplete`);
  }
  return { commands: spec, globalFlags: GLOBAL_FLAGS, exitCodes: { ok: 0, error: 1, usage: 2, publish_incomplete: 3 } };
}

function emit(ok: boolean, command: string, data: unknown, error: { code: string; message: string; hint?: string } | null) {
  process.stdout.write(JSON.stringify({ ok, command, data: data ?? null, error }, null, 2) + "\n");
}

async function main() {
  const name = argv[0] && !argv[0].startsWith("--") ? argv[0] : "help";
  const spec = COMMANDS[name];
  // In JSON mode stdout is reserved for the envelope; library logs go to stderr.
  if (json) console.log = console.error;
  try {
    if (!spec) usage(`unknown command: ${name}`);
    if (has("--help") || has("-h")) {
      argv.splice(0, argv.length, "help", name);
      const data = await cmdHelp();
      if (json) emit(true, "help", data, null);
      return;
    }
    const data = await spec.run();
    if (json && name !== "gui") emit(true, name, data, null);
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError("error", String(e instanceof Error ? e.message : e));
    if (json) {
      emit(false, name, (e as { data?: unknown }).data ?? null, { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) });
    } else {
      console.error(err.message);
      if (err.hint) console.error(err.hint);
    }
    process.exitCode = err.exitCode;
  }
}

await main();
