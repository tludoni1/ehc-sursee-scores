// fetch.mjs — EHC Sursee Scores Fetcher (robust, HOST=data.sihf.ch)
// Artefakte, die IMMER geschrieben werden:
//   public/results.json  (Liste der Spiele; evtl. leer)
//   public/debug.txt     (Status/Fehler)
//   public/raw-results.json (Rohantwort der SIHF-API für Debugging)

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
const DAYS_BACK = 250;                // Tage rückwärts abfragen
const DAYS_FWD  = 200;                // Tage vorwärts abfragen
const MAX_DETAILS = 100;              // wie viele Spiele via Detail-API ergänzen (limitiert!)

// === SIHF-API (aktuelle Domain) ===
const HOST = "data.sihf.ch";
const BASE = `https://${HOST}`;
const RESULTS_TABLE = "/statistic/api/cms/table";         // alias=results (JSON)
const RESULTS_EXPORT = "/statistic/api/cms/export";       // alias=results (Fallback)
const DETAIL_PATH    = "/statistic/api/cms/gameoverview"; // alias=gameDetail

// Spalten-Setup wie in älteren Referenzen genutzt (liefert u. a. Teams/Score/Zeit)
const RESULTS_SEARCH_QUERY = "1,8,10,11//1,8,9,20,47,48,50,90,81";

// Utils
const fmt = (d) =>
  d.toLocaleDateString("de-CH").replace(/(\d{2})\.(\d{2})\.(\d{4})/, "$1.$2.$3"); // dd.mm.yyyy
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
  const ip = answers.find(a => a.type === 1 /*A*/)?.data;
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
  try { return JSON.parse(text); } catch {}
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
        ...headers
      }
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}\nBODY: ${text.slice(0,800)}`);
    return parseMaybeJSONP(text);
  } catch (err) {
    // Fallback über curl + --resolve (umgeht DNS/HTTP-Schrullen)
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
  // Einheitlich Deutsch
  if (!url.searchParams.has("language")) url.searchParams.set("language", "de");
  // Falls JSONP erzwungen werden soll
  if (forceJsonp && !url.searchParams.has("callback")) {
    url.searchParams.set("callback", "externalStatisticsCallback");
  }
  return httpGetJSON(url.toString());
}

// === NEU: fetchResults, angepasst auf Array-Struktur ===
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
  fs.writeFileSync("public/raw-results.json", JSON.stringify(j, null, 2), "utf8");

  if (Array.isArray(j?.rows)) {
    return j.rows.map(arr => {
      const home = arr[3]?.name ?? "";
      const away = arr[4]?.name ?? "";
      const res  = arr[5] && arr[5].type === "result"
        ? `${arr[5].homeTeam}:${arr[5].awayTeam}`
        : "";
      const status = arr[9]?.name ?? "";
      const startDate = arr[9]?.startDateTime ?? null;

      return {
        gameId: arr[10]?.gameId ?? null,
        date: arr[1],
        time: arr[2],
        weekday: arr[0],
        homeTeam: home,
        awayTeam: away,
        score: res,
        status: status,
        startDateTime: startDate
      };
    });
  }

  if (Array.isArray(j?.data)) return j.data;

  return [];
}

// ---------- Main ----------

async function main() {
  try {
    const raw = await fetchResults();

    // Optional: Teamfilter anwenden
    const filtered = raw.filter((g) => teamMatches(g, TEAM_FILTERS));

    // Duplikate entfernen
    const seen = new Set();
    const out = filtered.filter((g) => !!g.gameId && !seen.has(g.gameId) && seen.add(g.gameId));

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
