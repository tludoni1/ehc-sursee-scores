// fetch.mjs — EHC Sursee Scores Fetcher (robust, HOST=data.sihf.ch)
// Artefakte, die IMMER geschrieben werden:
//   public/results.json  (Liste der Spiele; evtl. leer)
//   public/debug.txt     (Status/Fehler)
//   public/raw-results.json (volle API-Rohantwort, Debug)

import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Viele Runner/Netzwerke zicken bei IPv6: IPv4 bevorzugen
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");

// === KONFIG ===
const TEAM_FILTERS = ["sursee"]; 
const DAYS_BACK = 250;                
const DAYS_FWD  = 200;                
const MAX_DETAILS = 100;              

// === SIHF-API ===
const HOST = "data.sihf.ch";
const BASE = `https://${HOST}`;
const RESULTS_TABLE = "/statistic/api/cms/cache300";         
const RESULTS_EXPORT = "/statistic/api/cms/export";       
const DETAIL_PATH    = "/statistic/api/cms/gameoverview"; 

// Utils
const fmt = (d) =>
  d.toLocaleDateString("de-CH").replace(/(\d{2})\.(\d{2})\.(\d{4})/, "$1.$2.$3"); 
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function pluck(obj, paths, fallback = undefined) {
  for (const p of paths) {
    const v = p.split(".").reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj);
    if (v != null) return v;
  }
  return fallback;
}
function teamMatches(item, filters) {
  const hay = JSON.stringify(item).toLowerCase();
  return filters.length === 0 || filters.some((f) => hay.includes(f.toLowerCase()));
}
function ensurePublicDir() {
  fs.mkdirSync("public", { recursive: true });
}
function writeJSON(relPath, obj) {
  ensurePublicDir();
  fs.writeFileSync(path.join("public", relPath), JSON.stringify(obj, null, 2), "utf8");
}
function writeDebug(msg) {
  ensurePublicDir();
  fs.writeFileSync(path.join("public", "debug.txt"), `[${nowIso()}]\n${msg}\n`, "utf8");
}

// ---------- HTTP / DNS-Fallback ----------

async function resolveHostIP(host) {
  const u = new URL("https://dns.google/resolve");
  u.searchParams.set("name", host);
  u.searchParams.set("type", "A");
  const r = await fetch(u.toString(), { headers: { "accept": "application/dns-json" } });
  if (!r.ok) throw new Error(`DoH HTTP ${r.status}`);
  const j = await r.json();
  const answers = j?.Answer || [];
  const ip = answers.find(a => a.type === 1)?.data;
  if (!ip) throw new Error(`DoH found no A record for ${host}`);
  return ip;
}

async function curlFetchText(urlStr, host, extraHeaders = []) {
  const ip = await resolveHostIP(host);
  const args = [
    "-sS", "--fail", "--max-time", "30",
    "--http1.1",
    "--resolve", `${host}:443:${ip}`,
  ];
  for (const [k, v] of extraHeaders) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push(urlStr);
  const { stdout } = await execFileP("curl", args);
  return stdout;
}

function parseMaybeJSONP(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/^[a-zA-Z_$][\w$]*\(([\s\S]*)\);\s*$/);
  if (m) {
    const inner = m[1];
    return JSON.parse(inner);
  }
  throw new Error("Antwort war weder JSON noch erkennbares JSONP");
}

async function httpGetJSON(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        "accept": "application/json, text/javascript;q=0.9, */*;q=0.1",
        "cache-control": "no-cache",
        "accept-language": "de-CH,de;q=0.9,en;q=0.8",
        "user-agent": "ehc-sursee-scores/1.0 (+github actions)",
        ...headers
      }
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}\nBODY: ${text.slice(0,800)}`);
    return parseMaybeJSONP(text);
  } catch (err) {
    try {
      const text = await curlFetchText(url, HOST, Object.entries(headers));
      return parseMaybeJSONP(text);
    } catch (err2) {
      const code1 = err?.cause?.code || err?.code || "UNKNOWN";
      const code2 = err2?.cause?.code || err2?.code || "UNKNOWN";
      throw new Error(
        `Primary fetch failed (${code1}): ${err?.message}\n` +
        `FALLBACK curl failed (${code2}): ${err2?.message}`
      );
    }
  }
}

// ---------- API-Calls ----------

async function call(path, params, { forceJsonp = false } = {}) {
  const url = new URL(path, BASE);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  if (!url.searchParams.has("language")) url.searchParams.set("language", "de");
  if (forceJsonp && !url.searchParams.has("callback")) {
    url.searchParams.set("callback", "externalStatisticsCallback");
  }
  return httpGetJSON(url.toString());
}

async function fetchResults() {
  const baseParams = {
    alias: "results",
    searchQuery: "1,10,11/2015-2099/4,5,14,15,16,23,24,25,26,28,27,29,30,31,32,60,61,105,106,107,113,114,115,116,117,118,119,120,121,122,123,124,125",
    filterQuery: "2026/123/all/all/06.09.2025-29.03.2026/all/105957/all",
    orderBy: "date",
    orderByDescending: "false",
    take: "200",
    filterBy: "season,league,region,phase,date,deferredState,team1,team2"
  };

  try {
    const j = await call(RESULTS_TABLE, baseParams);
    ensurePublicDir();
    fs.writeFileSync("public/raw-results.json", JSON.stringify(j, null, 2), "utf8");
    if (j?.data) return j.data;
    return Array.isArray(j) ? j : [j];
  } catch (e1) {
    try {
      const j = await call(RESULTS_EXPORT, baseParams);
      ensurePublicDir();
      fs.writeFileSync("public/raw-results.json", JSON.stringify(j, null, 2), "utf8");
      if (j?.data) return j.data;
      return Array.isArray(j) ? j : [j];
    } catch (e2) {
      throw new Error(`Results failed:\n- table: ${e1.message}\n- export: ${e2.message}`);
    }
  }
}

async function fetchDetail(gameId) {
  return call(DETAIL_PATH, { alias: "gameDetail", searchQuery: String(gameId) }, { forceJsonp: true });
}

// ---------- Normalisierung ----------

function normalizeFromResult(item) {
  const id    = pluck(item, ["gameId","id","gameID","game_id"]);
  const start = pluck(item, ["startDateTime","start","dateTime","startTime"]);
  const league= pluck(item, ["league.name","league","championship.league"]);
  const home  = pluck(item, ["homeTeam.name","homeTeam","home","teamHome.name","teams.home.name"]);
  const away  = pluck(item, ["awayTeam.name","awayTeam","away","teamAway.name","teams.away.name"]);
  const score = pluck(item, ["result","score","finalScore"]);
  return { id, startTime: start, league, homeTeam: home, awayTeam: away, score };
}

function normalizeFromDetail(d) {
  const id     = pluck(d, ["gameId","id","content.gameId"]);
  const start  = pluck(d, ["startDateTime","content.startDateTime"]);
  const league = pluck(d, ["league.name","content.league.name"]);
  const home   = pluck(d, ["details.homeTeam.name","details.homeTeam.acronym","content.details.homeTeam.name"]);
  const away   = pluck(d, ["details.awayTeam.name","details.awayTeam.acronym","content.details.awayTeam.name"]);
  const rh     = pluck(d, ["result.homeTeam","content.result.homeTeam"]);
  const ra     = pluck(d, ["result.awayTeam","content.result.awayTeam"]);
  const score  = (rh != null && ra != null) ? `${rh}:${ra}` : undefined;
  const venue  = pluck(d, ["details.venue","content.details.venue"]);
  return { id, startTime: start, league, homeTeam: home, awayTeam: away, score, venue };
}

// ---------- Main ----------

async function main() {
  try {
    const raw = await fetchResults();
    const pre = raw.filter((item) => teamMatches(item, TEAM_FILTERS));
    let normalized = pre.map(normalizeFromResult);

    const needsDetail = normalized
      .filter((g) => !(g.homeTeam && g.awayTeam && g.startTime))
      .slice(0, MAX_DETAILS);

    for (const g of needsDetail) {
      if (!g.id) continue;
      await sleep(250);
      const det = await fetchDetail(g.id);
      const nd  = normalizeFromDetail(det);
      Object.assign(g, Object.fromEntries(Object.entries(nd).filter(([,v]) => v != null)));
    }

    const seen = new Set();
    const out = normalized.filter((g) => !!g.id && !seen.has(g.id) && seen.add(g.id));

    writeJSON("results.json", out);
    writeDebug(`OK: wrote ${out.length} games (HOST=${HOST})`);
    console.log(`Wrote public/results.json with ${out.length} games`);
  } catch (err) {
    writeJSON("results.json", []);
    writeDebug(`ERROR @ ${nowIso()}:\n${err?.message || err}\n(HOST=${HOST})\n`);
    console.error(err);
  }
}

main().catch(err => {
  ensurePublicDir();
  fs.writeFileSync(
    "public/debug.txt",
    `[${nowIso()}] FATAL: ${err?.stack || err}\n`,
    "utf8"
  );
  process.exit(1);
});
