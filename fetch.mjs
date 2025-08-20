// fetch.mjs — Debug mit JSONP-Callback

import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";

if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");

const HOST = "data.sihf.ch";
const BASE = `https://${HOST}`;
const RESULTS_TABLE = "/statistic/api/cms/table";

function ensurePublicDir() {
  fs.mkdirSync("public", { recursive: true });
}
function writeJSON(relPath, obj) {
  ensurePublicDir();
  fs.writeFileSync(path.join("public", relPath), JSON.stringify(obj, null, 2), "utf8");
}
function writeDebug(msg) {
  ensurePublicDir();
  fs.writeFileSync(path.join("public", "debug.txt"), msg, "utf8");
}

function parseMaybeJSONP(text) {
  // echtes JSON versuchen
  try { return JSON.parse(text); } catch {}
  // JSONP: externalStatisticsCallback({...});
  const m = text.match(/^externalStatisticsCallback\(([\s\S]*)\);\s*$/);
  if (m) {
    return JSON.parse(m[1]);
  }
  throw new Error("Antwort war weder JSON noch JSONP");
}

async function httpGetJSON(url) {
  const res = await fetch(url, {
    headers: {
      "accept": "application/json, text/javascript;q=0.9,*/*;q=0.1",
      "user-agent": "ehc-sursee-scores/1.0"
    }
  });
  const text = await res.text();
  return parseMaybeJSONP(text);
}

async function fetchResults() {
  const url = new URL(RESULTS_TABLE, BASE);
  url.searchParams.set("alias", "results");
  url.searchParams.set("page", "1");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("language", "de");
  url.searchParams.set("callback", "externalStatisticsCallback"); // WICHTIG

  const j = await httpGetJSON(url.toString());

  writeJSON("raw-results.json", j);

  if (Array.isArray(j?.rows)) return j.rows;
  return [];
}

async function main() {
  try {
    const rows = await fetchResults();
    writeJSON("results.json", rows);
    writeDebug(`OK: got ${rows.length} rows`);
    console.log(`Wrote ${rows.length} rows to public/results.json`);
  } catch (err) {
    writeJSON("results.json", []);
    writeDebug("ERROR: " + err.message);
    console.error(err);
  }
}

main();
