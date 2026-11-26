// Load ./.env when present, so agents can call `node dist/cli.js` (or the
// `resell` bin) directly: `npm run` prints a banner on stdout that breaks
// --json parsing. Values already in the environment win.
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

if (existsSync(".env")) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(".env", "utf8")))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
