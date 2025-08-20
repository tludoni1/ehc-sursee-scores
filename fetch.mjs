// fetch.mjs — Debug-Version, um echte SIHF-Antworten zu sehen
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");

// === KONFIG ===
const DAYS_BACK = 400;  // langes Fenster, ~1 Jahr rückwärts
const DAYS_FWD  = 200;  // 6 Monate vorwärts

// === SIHF-API ===
const HOST = "data.sihf.ch";
const BASE = `https://${HOST}`;
const RESULTS_TABLE = "/statistic/api/cms/table";
const RESULTS_EXPORT = "/statistic/api/cms/export";
const RESULTS_SEARCH_QUERY = "1,8,10,11//1,8,9,20,47,48,50,90,81";

const fmt = (d) =>
  d.toLocaleDateString("de-CH").replace(/(\d{2})\.(\d{2})\.(\d{4})/, "$1.$2.$3");
const nowIso = () => new Date().toISOString();
function dateRange(now = new Date()) {
  const start = new Date(now); start.setDate(start.getDate() - DAYS_BACK);
  const end   = new Date(now); end.setDate(end.getDate() + DAYS_FWD);
  return { start: fmt(start), end: fmt(end) };
}

function ensurePublicDir() { fs.mkdirSync("public", { recursive: true }); }
function writeJSON(relPath, obj) {
  ensurePublicDir();
  fs.writeFileSync(path.join("public", relPath), JSON.stringify(obj, null, 2), "utf8");
}
function writeDebug(msg) {
  ensurePublicDir();
  fs.writeFileSync(path.join("public", "debug.txt"), `[${nowIso()}]\n${msg}\n`, "utf8");
}

async function httpGetText(url) {
  const res = await fetch(url, { headers: { "accept": "application/json" } });
  const text = await res.text();
  return text;
}

async function call(path, params) {
  const url = new URL(path, BASE);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("language", "de");
  const text = await httpGetText(url.toString());
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function fetchResults() {
  const { start, end } = dateRange();

  const baseParams = {
    alias: "results",
    searchQuery: RESULTS_SEARCH_QUERY,
    filterBy: "Date",             // nur Datum filtern
    filterQuery: `${start}-${end}` // großer Zeitraum
  };

  const j = await call(RESULTS_TABLE, baseParams);

  // Debug: alles abspeichern
  ensurePublicDir();
  fs.writeFileSync("public/raw-results.json", JSON.stringify(j, null, 2), "utf8");
  writeDebug(`URL: ${BASE}${RESULTS_TABLE}?${new URLSearchParams(baseParams)}\nKeys: ${Object.keys(j)}`);

  return j?.data ?? [];
}

async function main() {
  try {
    const raw = await fetchResults();
    writeJSON("results.json", raw);
    console.log(`Wrote ${raw.length} entries to results.json`);
  } catch (err) {
    writeJSON("results.json", []);
    writeDebug(`ERROR @ ${nowIso()}:\n${err?.message || err}`);
    console.error(err);
  }
}

main();
