// fetch.mjs — EHC Sursee Scores Fetcher (robust, HOST=data.sihf.ch)
// Artefakte, die IMMER geschrieben werden:
//   public/results.json   (Liste der Spiele; evtl. leer)
//   public/raw-results.txt (Rohantwort zum Debuggen)
//   public/debug.txt      (Status/Fehler)

import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Viele Runner/Netzwerke zicken bei IPv6: IPv4 bevorzugen
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");

// === KONFIG ===
const TEAM_FILTERS = ["sursee"]; // weitere Teams ergänzen, z. B. "EHC Sursee U13"
const MAX_DETAILS = 100;         // wie viele Spiele via Detail-API ergänzen (limitiert!)

// === SIHF-API (aktuelle Domain) ===
const HOST = "data.sihf.ch";
const BASE = `https://${HOST}`;
const CACHE300_PATH = "/Statistic/api/cms/cache300";
const DETAIL_PATH   = "/statistic/api/cms/gameoverview"; // alias=gameDetail

// Utils
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
function writeText(relPath, txt) {
  ensurePublicDir();
  fs.writeFileSync(path.join("public", relPath), txt, "utf8");
}
function writeDebug(msg) {
  ensurePublicDir();
  fs.writeFileSync(path.join("public", "debug.txt"), `[${nowIso()}]\n${msg}\n`, "utf8");
}

// ---------- HTTP / DNS-Fallback ----------

async function resolveHostIP(host) {
  // DNS over HTTPS (Google) – holt A-Record
  const u = new URL("https://dns.google/resolve");
  u.searchParams.set("name", host);
  u.searchParams.set("type", "A");
  const r = await fetch(u.toString(), { headers: { "accept": "application/dns-json" } });
  if (!r.ok) throw new Error(`DoH HTTP ${r.status}`);
  const j = await r.json();
  const answers = j?.Answer || [];
  const ip = answers.find((a) => a.type === 1 /*A*/)?.data;
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
  // Header mitgeben
  for (const [k, v] of extraHeaders) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push(urlStr);
  const { stdout } = await execFileP("curl", args);
  return stdout;
}

function parseMaybeJSONP(text) {
  // Versuche echtes JSON …
  try {
    return JSON.parse(text);
  } catch {}
  // … oder JSONP wie externalStatisticsCallback({...});
  const m = text.match(/^[a-zA-Z_$][\w$]*\(([\s\S]*)\);\s*$/);
  if (m) {
    const inner = m[1];
    return JSON.parse(inner);
  }
  throw new Error("Antwort war weder JSON noch erkennbares JSONP");
}

async function httpGetJSON(url, headers = {}) {
  // primär via fetch()
  try {
    const res = await fetch(url, {
      headers: {
        "accept": "application/json, text/javascript;q=0.9, */*;q=0.1",
        "cache-control": "no-cache",
        "accept-language": "de-CH,de;q=0.9,en;q=0.8",
        "user-agent": "ehc-sursee-scores/1.0 (+github actions)",
        ...headers,
      },
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`HTTP ${res.status} ${res.statusText}\nBODY: ${text.slice(0, 800)}`);
    return parseMaybeJSONP(text);
  } catch (err) {
    // Fallback über curl + --resolve
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

async function fetchResults() {
  const url = BASE + CACHE300_PATH;
  const params = {
    alias: "results",
    searchQuery:
      "1,10,11/2015-2099/4,5,14,15,16,23,24,25,26,28,27,29,30,31,32,60,61,105,106,107,113,114,115,116,117,118,119,120,121,122,123,124,125",
    filterQuery: "2026/123/all/all/06.09.2025-29.03.2026/all/105957/all",
    orderBy: "date",
    orderByDescending: "false",
    take: "2000",
    skip: "-1",
    filterBy: "season,league,region,phase,date,deferredState,team1,team2",
    language: "de",
    callback: "externalStatisticsCallback",
  };

  const fullUrl = url + "?" + new URLSearchParams(params).toString();

  const j = await httpGetJSON(fullUrl);

  writeText("raw-results.txt", JSON.stringify(j, null, 2));

  if (j?.data) return j.data;
  return [];
}

async function fetchDetail(gameId) {
  // Detail liefert häufig JSONP -> erzwinge JSONP
  const url = BASE + DETAIL_PATH;
  const params = {
    alias: "gameDetail",
    searchQuery: String(gameId),
    callback: "externalStatisticsCallback",
  };
  const fullUrl = url + "?" + new URLSearchParams(params).toString();
  return httpGetJSON(fullUrl);
}

// ---------- Normalisierung ----------

function normalizeFromResult(item) {
  const id = pluck(item, ["gameId", "id", "gameID", "game_id"]);
  const start = pluck(item, ["startDateTime", "start", "dateTime", "startTime"]);
  const league = pluck(item, ["league.name", "league", "championship.league"]);
  const home = pluck(item, ["homeTeam.name", "homeTeam", "home"]);
  const away = pluck(item, ["awayTeam.name", "awayTeam", "away"]);
  const score = pluck(item, ["result", "score", "finalScore"]);
  return { id, startTime: start, league, homeTeam: home, awayTeam: away, score };
}

function normalizeFromDetail(d) {
  const id = pluck(d, ["gameId", "id", "content.gameId"]);
  const start = pluck(d, ["startDateTime", "content.startDateTime"]);
  const league = pluck(d, ["league.name", "content.league.name"]);
  const home = pluck(d, ["details.homeTeam.name", "content.details.homeTeam.name"]);
  const away = pluck(d, ["details.awayTeam.name", "content.details.awayTeam.name"]);
  const rh = pluck(d, ["result.homeTeam", "content.result.homeTeam"]);
  const ra = pluck(d, ["result.awayTeam", "content.result.awayTeam"]);
  const score = rh != null && ra != null ? `${rh}:${ra}` : undefined;
  const venue = pluck(d, ["details.venue", "content.details.venue"]);
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
      await sleep(250);
      const det = await fetchDetail(g.id);
      const nd = normalizeFromDetail(det);
      Object.assign(g, Object.fromEntries(Object.entries(nd).filter(([, v]) => v != null)));
    }

    // Duplikate entfernen
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

main();
