// Load optional API keys / credentials from a 600 .env file (gitignored). Keeps every key out of
// source and out of the browser. Imported FIRST in server.mjs so process.env is populated before
// any module reads it at eval time. Put your keys (e.g. GEV_AISSTREAM_KEY, WINDY_WEBCAMS_KEY,
// FIRMS_MAP_KEY) in a `.env` file next to server.mjs — see .env.example.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
for (const file of [".env"]) {
  try {
    for (const line of readFileSync(join(HERE, file), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* file absent — fine */ }
}
