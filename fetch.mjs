// fetch.mjs (robuste Version mit Debug-Ausgabe)
import fs from "node:fs";
import path from "node:path";

// === KONFIG ===
const TEAM_FILTERS = ["EHC Sursee"]; // weitere Teams hier ergänzen
const DAYS_BACK = 21;
const DAYS_FWD  = 14;
const MAX_DETAILS = 30;

// SIHF-API Basis (siehe R-Doku)
const BASE = "https://dvdata.sihf.ch";
const RESULTS_PATH = "/statistic/api/cms/table";        // alias=results
const DETAIL_PATH  = "/statistic/api/cms/gameoverview"; // alias=gameDetail
const RESULTS_SEARCH_QUERY = "1,8,10,11//1,8,9,20,47,48,50,90,81";

// Util
const fmt = (d) => d.toLocaleDateString("de-CH").replace(/(\d{2})\.(\d{2})\.(\d{4})/, "$1.$2.$3");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function currentSeasonNumber(now = new Date()) {
  const y = now.getFullYear();
  return (now.getMonth() + 1) > 6 ? y + 1 : y; // ab Juli +1
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

async function call(endpoint, params) {
  const url = new URL(endpoint, BASE);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: {
      "accept": "application/json",
      // Ein paar Server reagieren sensibler ohne klaren UA/Referer:
      "user-agent": "ehc-sursee-scores/1.0 (+github actions)",
      "referer": "https://www.sihf.ch/"
    }
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}\nBODY: ${text.slice(0, 800)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Antwort war kein JSON für ${url}\nBODY: ${text.slice(0, 800)}`);
  }
}

async function fetchResults() {
  const season = currentSeasonNumber();
  const { start, end } = dateRange();

  // Minimalfilter Season+Date (R-Doku zeigt auch League als Option)
  const params = {
    alias: "results",
    searchQuery: RESULTS_SEARCH_QUERY,
    filterQuery: `${season}/${start}-${end}`,
    filterBy: "Season,Date"
  };
  return (await call(RESULTS_PATH, params))?.data ?? [];
}
async function fetchDetail(gameId) {
  return call(DETAIL_PATH, { alias: "gameDetail", searchQuery: String(gameId) });
}

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
    writeDebug(`OK: wrote ${out.length} games`);
    console.log(`Wrote public/results.json with ${out.length} games`);
  } catch (err) {
    // NIE mit leeren Händen rausgehen: leere results + Fehlerlog schreiben
    writeJSON("results.json", []);
    writeDebug(`ERROR:\n${err?.stack || err}`);
    console.error(err);
    // Kein process.exit(1) mehr: Deploy soll trotzdem laufen
  }
}

main();
