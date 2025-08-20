// Minimal Debug + API-Call
import fs from "node:fs";
import path from "node:path";

(async () => {
  try {
    const url = "https://data.sihf.ch/Statistic/api/cms/cache300?" +
      new URLSearchParams({
        alias: "results",
        filterQuery: "2026/123/all/all/06.09.2025-29.03.2026/all/105957/all",
        searchQuery: "1,10,11/2015-2099/…125",
        orderBy: "date", orderByDescending: "false", take: "20",
        filterBy: "season,league,region,phase,date,deferredState,team1,team2",
        callback: "externalStatisticsCallback", language: "de"
      });

    console.log("Fetching:", url);
    const res = await fetch(url, { headers: { "Accept": "*/*", "User-Agent": "Mozilla/5.0" } });
    console.log("Status:", res.status);
    const text = await res.text();
    console.log("Length:", text.length);
    fs.writeFileSync(path.join("public", "raw-results.json"), text, "utf8");

    if (!text) throw new Error("Empty body");
    const json = JSON.parse(text.replace(/^[^(]+\(([\s\S]*)\);?$/, "$1"));

    fs.writeFileSync(path.join("public", "results.json"), JSON.stringify(json, null, 2), "utf8");
  } catch (err) {
    fs.writeFileSync(path.join("public", "debug.txt"), err.stack || err.toString(), "utf8");
    process.exit(1);
  }
})();
