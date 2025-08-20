// fetch.mjs — EHC Sursee Scores Fetcher (HOST=data.sihf.ch)

import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");

// === KONFIG ===
const TEAM_FILTERS = ["sursee"];
const DAYS_BACK = 250;
const DAYS_FWD  = 200;

// === SIHF-API ===
const HOST = "data.sihf.ch";
const BASE = `https://${HOST}`;
const RESULTS_TABLE = "/statistic/api/cms/table";
const RESULTS_SEARCH_QUERY = "1,8,10,11//1,8,9,20,47,48,50,90,81";

// Utils
const fmt = (d) => d.toLocaleDateString("de-CH").replace(/(\d{2})\.(\d{2})\.(\d{4})/, "$1.$2.$3");
const nowIso = () => new Date().toISOString();
function dateRange(now = new Date()) {
  const start = new Date(now); start.setDate(start.getDate() - DAYS_BACK);
  const end   = new Date(now); end.setDate(end.getDate() + DAYS_FWD);
  return { start: fmt(start), end: fmt(end) };
}
function ensurePublicDir() { fs.mkdirSync("public", { recursive: true }); }
function writeJSON(relPath, obj) { ensurePublicDir(); fs.writeFileSync(path.join("public", relPath), JSON.stringify(obj, null, 2), "utf8"); }
function writeDebug(msg) { ensurePublicDir(); fs.writeFileSync(path.join("public", "debug.txt"), `[${nowIso()}]\n${msg}\n`, "utf8"); }
function teamMatches(item, filters) {
  const hay = JSON.stringify(item).toLowerCase();
  return filters.length === 0 || filters.some((f) => hay.includes(f.toLowerCase()));
}

// ---------- HTTP Helper ----------
async function resolveHostIP(host) {
  const u = new URL("https://dns.google/resolve");
  u.searchParams.set("name", host); u.searchParams.set("type", "A");
  const r = await fetch(u, { headers: { accept: "application/dns-json" } });
  const j = await r.json(); const ip = j?.Answer?.find(a => a.type === 1)?.data;
  if (!ip) throw new Error(`No A record for ${host}`); return ip;
}
async function curlFetchText(urlStr, host) {
  const ip = await resolveHostIP(host);
  const { stdout } = await execFileP("curl", [
    "-sS","--fail","--max-time","30","--http1.1","--resolve",`${host}:443:${ip}`,urlStr
  ]);
  return stdout;
}
function parseMaybeJSONP(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/^[a-zA-Z_$][\w$]*\(([\s\S]*)\);\s*$/);
  if (m) return JSON.parse(m[1]);
  throw new Error("Antwort war weder JSON noch JSONP");
}
async function httpGetJSON(url) {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) throw new Error(text); return parseMaybeJSONP(text);
  } catch (e1) {
    const text = await curlFetchText(url, HOST);
    return parseMaybeJSONP(text);
  }
}

// ---------- API ----------
async function call(path, params) {
  const url = new URL(path, BASE);
  Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));
  url.searchParams.set("language","de");
  return httpGetJSON(url.toString());
}

// ---------- fetchResults ----------
async function fetchResults() {
  const { start, end } = dateRange();
  const baseParams = {
    alias: "results",
    searchQuery: RESULTS_SEARCH_QUERY,
    filterBy: "Date",
    filterQuery: `${start}-${end}`
  };
  const j = await call(RESULTS_TABLE, baseParams);

  ensurePublicDir();
  fs.writeFileSync("public/raw-results.json", JSON.stringify(j,null,2),"utf8");

  // === wichtig: direktes Array von Arrays erkennen ===
  if (Array.isArray(j) && Array.isArray(j[0])) {
    return j.map(arr => {
      return {
        weekday: arr[0],
        date: arr[1],
        time: arr[2],
        homeTeam: arr[3]?.name,
        awayTeam: arr[4]?.name,
        score: arr[5]?.type === "result" ? `${arr[5].homeTeam}:${arr[5].awayTeam}` : "",
        status: arr[9]?.name,
        startDateTime: arr[9]?.startDateTime,
        gameId: arr[10]?.gameId
      };
    });
  }

  if (Array.isArray(j?.rows)) return j.rows;
  if (Array.isArray(j?.data)) return j.data;
  return [];
}

// ---------- Main ----------
async function main() {
  try {
    const raw = await fetchResults();
    const filtered = raw.filter((g) => teamMatches(g, TEAM_FILTERS));
    const seen = new Set();
    const out = filtered.filter((g) => !!g.gameId && !seen.has(g.gameId) && seen.add(g.gameId));
    writeJSON("results.json", out);
    writeDebug(`OK: wrote ${out.length} games (HOST=${HOST})`);
    console.log(`Wrote ${out.length} games`);
  } catch (err) {
    writeJSON("results.json", []);
    writeDebug(`ERROR @ ${nowIso()}:\n${err?.message}\n(HOST=${HOST})`);
    console.error(err);
  }
}
main();
