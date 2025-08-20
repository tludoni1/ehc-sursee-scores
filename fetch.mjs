// fetch.mjs — EHC Sursee Scores Fetcher (robust, mit DNS-Fallback)
// Läuft in GitHub Actions (Node 20). Schreibt immer:
//   public/results.json  (Liste der Spiele; evtl. leer)
//   public/debug.txt     (kurzer Status/Fehlerlog)

import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Viele Runner/Netzwerke zicken bei IPv6: IPv4 bevorzugen
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");

// === KONFIG ===
const TEAM_FILTERS = ["EHC Sursee"]; // weitere Teams hier ergänzen, z. B. "EHC Sursee U13"
const DAYS_BACK = 21;                // wie viele Tage rückwärts abfragen
const DAYS_FWD  = 14;                // wie viele Tage vorwärts abfragen
const MAX_DETAILS = 30;              // wie viele Spiele per Detail-API ergänzen (limitieren!)

// SIHF-API
const HOST = "dvdata.sihf.ch";
const BASE = `https://${HOST}`;
const RESULTS_PATH = "/statistic/api/cms/table";        // alias=results
const DETAIL_PATH  = "/statistic/api/cms/gameoverview"; // alias=gameDetail

// Spalten-Setup wie in der R-Referenz (liefert u. a. Teams/Score/Zeit)
const RESULTS_SEARCH_QUERY = "1,8,10,11//1,8,9,20,47,48,50,90,81";

// Utils
const fmt = (d) => d.toLocaleDateString("de-CH").replace(/(\d{2})\.(\d{2})\.(\d{4})/, "$1.$2.$3"); // dd.mm.yyyy
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function currentSeasonNumber(now = new Date()) {
  // SIHF-Season ist das "zweite" Jahr der Saison; ab Juli +1
  const y = now.getFullYear();
  return (now.getMonth() + 1) > 6 ? y + 1 : y;
}
function dateRange(now = new Date()) {
  const start = new Date(now); start.setDate(start.getDate() - DAYS_BACK);
  const end   = new Date(now); end.setDate(end.getDate() + DAYS_FWD);
  return { start: fmt(start), end: fmt(end) };
}
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

// ---------- DNS / Fallback-HTTP ----------

async function resolveHostIP(host) {
  // DNS over HTTPS (Google) – holt A-Record
  const u = new URL("https://dns.google/resolve");
  u.searchParams.set("name", host);
  u.searchParams.set("type", "A");
  const r = await fetch(u.toString(), { headers: { "accept": "application/dns-json" } });
  if (!r.ok) throw new Error(`DoH HTTP ${r.status}`);
  const j = await r.json();
  const answers = j?.Answer || [];
  const ip = answers.find(a => a.type === 1 /*A*/)?.data;
  if (!ip) throw new Error(`DoH found no A record for ${host}`);
  return ip;
}

async function curlFetchJson(urlStr, host) {
  // Nutzt curl + --resolve, damit SNI/Cert korrekt bleiben
  const ip = await resolveHostIP(host);
  const args = [
    "-sS", "--fail", "--max-time", "25",
    "--http1.1",
    "-H", "accept: application/json",
    "--resolve", `${host}:443:${ip}`,
    urlStr
  ];
  const { stdout } = await execFileP("curl", args);
  return JSON.parse(stdout);
}

async function call(endpoint, params) {
  const url = new URL(endpoint, BASE);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  // 1) Normaler Weg über fetch()
  try {
    const res = await fetch(url.toString(), {
      headers: {
        "accept": "application/json",
        "cache-control": "no-cache",
        "accept-language": "de-CH,de;q=0.9,en;q=0.8",
        "user-agent": "ehc-sursee-scores/1.0 (+github actions)"
      }
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}\nBODY: ${text.slice(0,800)}`);
    return JSON.parse(text);
  } catch (err) {
    // 2) Fallback via curl + --resolve (umgeht DNS-Probleme im Runner)
    try {
      return await curlFetchJson(url.toString(), HOST);
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

// ---------- API-spezifische Calls ----------

async function fetchResults() {
  const season = currentSeasonNumber();
  const { start, end } = dateRange();
  const params = {
    alias: "results",
    searchQuery: RESULTS_SEARCH_QUERY,
    filterQuery: `${season}/${start}-${end}`, // Reihenfolge passend zu filterBy
    filterBy: "Season,Date"
  };
  const json = await call(RESULTS_PATH, params);
  return json?.data ?? [];
}

async function fetchDetail(gameId) {
  return call(DETAIL_PATH, { alias: "gameDetail", searchQuery: String(gameId) });
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

    // Fehlende Felder via Detail-API ergänzen (limitiert)
    const needsDetail = normalized
      .filter((g) => !(g.homeTeam && g.awayTeam && g.startTime))
      .slice(0, MAX_DETAILS);

    for (const g of needsDetail) {
      if (!g.id) continue;
      await sleep(250); // freundlich zur Gegenstelle
      const det = await fetchDetail(g.id);
      const nd  = normalizeFromDetail(det);
      Object.assign(g, Object.fromEntries(Object.entries(nd).filter(([,v]) => v != null)));
    }

    // Duplikate entfernen
    const seen = new Set();
    const out = normalized.filter((g) => !!g.id && !seen.has(g.id) && seen.add(g.id));

    writeJSON("results.json", out);
    writeDebug(`OK: wrote ${out.length} games`);
    console.log(`Wrote public/results.json with ${out.length} games`);
  } catch (err) {
    // Nie ohne Artefakte beenden: leeres results + Fehlerlog
    writeJSON("results.json", []);
    writeDebug(`ERROR @ ${nowIso()}:\n${err?.message || err}\n`);
    console.error(err);
    // KEIN process.exit(1); Deploy soll trotzdem laufen
  }
}

main();
