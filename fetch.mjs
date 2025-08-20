// fetch.mjs — EHC Sursee Scores Fetcher (robust, HOST=data.sihf.ch)
// Artefakte, die IMMER geschrieben werden und committed werden:
//   public/results.json
//   public/debug.txt
//   public/raw-results.json (zu Debugzwecken)

import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// IPv4 bevorzugen (Runner-Probleme mit IPv6)
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");

// === KONFIG ===
const TEAM_FILTERS = ["sursee"];
const DAYS_BACK = 250;
const DAYS_FWD = 200;
const MAX_DETAILS = 100;

// === SIHF-API ===
const HOST = "data.sihf.ch";
const BASE = `https://${HOST}`;
const RESULTS_TABLE = "/statistic/api/cms/table";
const RESULTS_EXPORT = "/statistic/api/cms/export";
const DETAIL_PATH = "/statistic/api/cms/gameoverview";

const RESULTS_SEARCH_QUERY = "1,8,10,11//1,8,9,20,47,48,50,90,81";

// Utils
const nowIso = () => new Date().toISOString();
function ensurePublicDir() { fs.mkdirSync("public", { recursive: true }); }
function writeJSON(relPath, obj) {
  ensurePublicDir();
  fs.writeFileSync(path.join("public", relPath), JSON.stringify(obj, null, 2), "utf8");
}
function writeDebug(msg) {
  ensurePublicDir();
  fs.writeFileSync(path.join("public", "debug.txt"), `[${nowIso()}]\n${msg}\n`, "utf8");
}

// HTTP + Fallback
async function resolveHostIP(host) {
  const u = new URL("https://dns.google/resolve");
  u.searchParams.set("name", host);
  u.searchParams.set("type", "A");
  const r = await fetch(u.toString(), { headers: { accept: "application/dns-json" } });
  const j = await r.json();
  return j?.Answer?.find(a => a.type === 1)?.data;
}
async function curlFetchText(urlStr, host, extraHeaders = []) {
  const ip = await resolveHostIP(host);
  const args = [
    "-sS", "--fail", "--max-time", "30", "--http1.1",
    "--resolve", `${host}:443:${ip}`,
    ...extraHeaders.flatMap(([k, v]) => ["-H", `${k}: ${v}`]),
    urlStr
  ];
  const { stdout } = await execFileP("curl", args);
  return stdout;
}
function parseMaybeJSONP(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/^[a-zA-Z_$][\w$]*\(([\s\S]*)\);\s*$/);
  if (m) return JSON.parse(m[1]);
  throw new Error("Antwort war kein JSON");
}
async function httpGetJSON(url, headers = {}) {
  try {
    const res = await fetch(url, { headers });
    const txt = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0,200)}`);
    return parseMaybeJSONP(txt);
  } catch (err) {
    const txt = await curlFetchText(url, HOST, Object.entries(headers));
    return parseMaybeJSONP(txt);
  }
}

// API
async function call(path, params, { forceJsonp = false } = {}) {
  const url = new URL(path, BASE);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("language", "de");
  if (forceJsonp) url.searchParams.set("callback", "externalStatisticsCallback");
  return httpGetJSON(url.toString());
}
async function fetchResults() {
  const baseParams = { alias: "results", searchQuery: RESULTS_SEARCH_QUERY };
  const j = await call(RESULTS_TABLE, baseParams).catch(() => call(RESULTS_EXPORT, baseParams));
  ensurePublicDir();
  fs.writeFileSync("public/raw-results.json", JSON.stringify(j, null, 2), "utf8");
  return j?.data ?? [];
}

// Main
async function main() {
  let out = [];
  try {
    const raw = await fetchResults();
    out = raw.map(r => ({
      id: r?.[10]?.gameId ?? r?.gameId,
      homeTeam: r?.[3]?.name ?? r?.homeTeam?.name,
      awayTeam: r?.[4]?.name ?? r?.awayTeam?.name,
      startTime: r?.[9]?.startDateTime ?? r?.startDateTime,
      score: r?.[5]?.homeTeam && r?.[5]?.awayTeam ? `${r[5].homeTeam}:${r[5].awayTeam}` : undefined
    })).filter(g => g.id);
    writeJSON("results.json", out);
  } catch (err) {
    writeJSON("results.json", []);
    writeDebug(`FEHLER: ${err.message}`);
    return;
  } finally {
    // Debug immer schreiben
    writeDebug(`OK: wrote ${out.length} games (HOST=${HOST})`);
  }
}
main();
