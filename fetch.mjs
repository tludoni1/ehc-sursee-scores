// fetch.mjs
import fs from "node:fs";
import path from "node:path";

// >>>> KONFIG <<<<
const TEAM_FILTERS = ["EHC Sursee"];   // weitere Teams hier eintragen
const DAYS_BACK = 21;                  // wie viele Tage rückwärts abfragen
const DAYS_FWD  = 14;                  // wie viele Tage vorwärts abfragen
const MAX_DETAILS = 30;                // wie viele Spiele zusätzlich detailliert abfragen (score etc.)

// SIHF API-Endpunkte (belegt durch die R-Doku)
const BASE = "https://dvdata.sihf.ch";
const RESULTS_PATH = "/statistic/api/cms/table";
const DETAIL_PATH  = "/statistic/api/cms/gameoverview";

// aus der R-Referenz: Spaltensets für "results"
const RESULTS_SEARCH_QUERY = "1,8,10,11//1,8,9,20,47,48,50,90,81"; // siehe R-Beispiel
// Quelle: R-Funktion sihf_api()/fetch_results(); Alias=results, path=/statistic/api/cms/table
// https://rdrr.io/github/msenn/sihfapi/src/R/api.R

// Hilfen
const fmt = (d) => d.toLocaleDateString("de-CH").replace(/(\d{2})\.(\d{2})\.(\d{4})/, "$1.$2.$3"); // dd.mm.yyyy
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function currentSeasonNumber(now = new Date()) {
  // Season ist das "zweite" Jahr der Saison (ab Juli +1)
  const y = now.getFullYear();
  const season = (now.getMonth() + 1) > 6 ? y + 1 : y;
  return season;
}

function dateRange(now = new Date()) {
  const start = new Date(now); start.setDate(start.getDate() - DAYS_BACK);
  const end   = new Date(now); end.setDate(end.getDate() + DAYS_FWD);
  return {start: fmt(start), end: fmt(end)};
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
  return filters.length === 0 || filters.some(f => hay.includes(f.toLowerCase()));
}

async function call(endpoint, params) {
  const url = new URL(endpoint, BASE);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: { "accept": "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchResults() {
  const season = currentSeasonNumber();
  const {start, end} = dateRange();
  const params = {
    alias: "results",
    searchQuery: RESULTS_SEARCH_QUERY,
    filterQuery: `${season}/${start}-${end}`,    // Reihenfolge muss zu filterBy passen:
    filterBy: "Season,Date"                      // -> Season / Date
  };
  const json = await call(RESULTS_PATH, params);
  // erwartete Struktur lt. R: { alias: "results", data: [...] }
  return json?.data ?? [];
}

async function fetchDetail(gameId) {
  const json = await call(DETAIL_PATH, { alias: "gameDetail", searchQuery: String(gameId) });
  return json; // Struktur enthält u.a. details, result, startDateTime, league.name
}

function normalizeFromResult(item) {
  const id    = pluck(item, ["gameId","id","gameID","game_id"]);
  const start = pluck(item, ["startDateTime","start","dateTime","startTime"]);
  const league= pluck(item, ["league.name","league","championship.league"]);
  const home  = pluck(item, ["homeTeam.name","homeTeam","home","teamHome.name","teams.home.name"]);
  const away  = pluck(item, ["awayTeam.name","awayTeam","away","teamAway.name","teams.away.name"]);
  const score = pluck(item, ["result","score","finalScore"]); // manchmal nicht enthalten
  return { id, startTime: start, league, homeTeam: home, awayTeam: away, score };
}

function normalizeFromDetail(d) {
  // gemäß R-Print: details.homeTeam / details.awayTeam, result.homeTeam/result.awayTeam, startDateTime, league.name
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

async function main() {
  const raw = await fetchResults();
  // Team-Filter anwenden
  const pre = raw.filter(item => teamMatches(item, TEAM_FILTERS));

  // Erst aus results normalisieren
  let normalized = pre.map(normalizeFromResult);

  // Für fehlende Felder Details nachziehen (limitiert)
  const needsDetail = normalized
    .filter(g => !(g.homeTeam && g.awayTeam && g.startTime))
    .slice(0, MAX_DETAILS);

  for (const g of needsDetail) {
    if (!g.id) continue;
    await sleep(250);
    const det = await fetchDetail(g.id);
    const nd = normalizeFromDetail(det);
    Object.assign(g, Object.fromEntries(Object.entries(nd).filter(([,v]) => v != null)));
  }

  // finale Liste ohne Null-IDs und ohne Duplikate
  const seen = new Set();
  const out = normalized.filter(g => !!g.id && !seen.has(g.id) && seen.add(g.id));

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(path.join("public","results.json"), JSON.stringify(out, null, 2), "utf8");
  console.log(`Wrote public/results.json with ${out.length} games`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
