// fetch.mjs — Minimal Debug + working cache300 endpoint

import fs from "node:fs";
import path from "node:path";

const BASE = "https://data.sihf.ch";
const CACHE300 = "/Statistic/api/cms/cache300";

(async () => {
  try {
    const url = BASE + CACHE300 + "?" + new URLSearchParams({
      alias: "results",
      searchQuery: "1,10,11/2015-2099/4,5,14,15,16,23,24,25,26,28,27,29,30,31,32,60,61,105,106,107,113,114,115,116,117,118,119,120,121,122,123,124,125",
      filterQuery: "2026/123/all/all/06.09.2025-29.03.2026/all/105957/all",
      orderBy: "date",
      orderByDescending: "false",
      take: "20",
      filterBy: "season,league,region,phase,date,deferredState,team1,team2",
      callback: "externalStatisticsCallback",
      language: "de"
    }).toString();

    console.log("DEBUG: Fetching URL:", url);

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "*/*"
      }
    });

    console.log("DEBUG: Response status:", res.status);

    const text = await res.text();
    console.log("DEBUG: Response length:", text.length);

    fs.writeFileSync(path.join("public", "raw-results.txt"), text, "utf8");
    console.log("DEBUG: Wrote raw-results.txt");

    if (!text) throw new Error("Empty response body");

    // Parse JSONP
    const jsonText = text.match(/^[^(]+\(([\s\S]*)\);?$/);
    if (!jsonText) throw new Error("Response not JSONP");
    const data = JSON.parse(jsonText[1]);

    fs.writeFileSync(
      path.join("public", "results.json"),
      JSON.stringify(data, null, 2),
      "utf8"
    );
    console.log("DEBUG: Wrote results.json");

  } catch (err) {
    console.error("FATAL ERROR:", err);
    fs.writeFileSync(path.join("public", "debug.txt"), err.stack || err.toString(), "utf8");
    process.exit(1);
  }
})();
