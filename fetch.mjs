// fetch.mjs — EHC Sursee Scores Fetcher (direkt mit cURL-ähnlichem Request)
// Speichert:
//   public/results.json  (Liste der Spiele)
//   public/raw-results.txt (komplette Rohantwort von SIHF)

import fs from "node:fs";
import path from "node:path";

// Utils
function ensurePublicDir() {
  fs.mkdirSync("public", { recursive: true });
}
function writeJSON(relPath, obj) {
  ensurePublicDir();
  fs.writeFileSync(path.join("public", relPath), JSON.stringify(obj, null, 2), "utf8");
}
function writeText(relPath, text) {
  ensurePublicDir();
  fs.writeFileSync(path.join("public", relPath), text, "utf8");
}
function parseJSONP(text) {
  const m = text.match(/^[^(]+\(([\s\S]*)\);\s*$/);
  if (!m) throw new Error("Antwort war kein JSONP");
  return JSON.parse(m[1]);
}

async function main() {
  const url = "https://data.sihf.ch/Statistic/api/cms/cache300?alias=results&searchQuery=1,10,11/2015-2099/4,5,14,15,16,23,24,25,26,28,27,29,30,31,32,60,61,105,106,107,113,114,115,116,117,118,119,120,121,122,123,124,125&filterQuery=2026/123/all/all/06.09.2025-29.03.2026/all/105957/all&orderBy=date&orderByDescending=false&take=20&filterBy=season,league,region,phase,date,deferredState,team1,team2&callback=externalStatisticsCallback&skip=-1&language=de";

  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Upgrade-Insecure-Requests": "1",
    "sec-ch-ua": "\"Not;A=Brand\";v=\"99\", \"Google Chrome\";v=\"139\", \"Chromium\";v=\"139\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"macOS\""
  };

  const res = await fetch(url, { headers });
  const text = await res.text();

  // Rohantwort speichern
  writeText("raw-results.txt", text);

  // JSONP extrahieren
  const data = parseJSONP(text);

  // Sauber als JSON speichern
  writeJSON("results.json", data);

  console.log(`OK: wrote results.json with keys: ${Object.keys(data)}`);
}

main().catch(err => {
  console.error("ERROR:", err);
  process.exit(1);
});
