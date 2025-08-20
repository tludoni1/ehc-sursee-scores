// fetch.mjs — Minimal-Tester für SIHF API

import fs from "node:fs";
import path from "node:path";

const HOST = "data.sihf.ch";
const BASE = `https://${HOST}`;
const RESULTS_TABLE = "/statistic/api/cms/table";

function ensurePublicDir() {
  fs.mkdirSync("public", { recursive: true });
}

async function main() {
  try {
    const url = new URL(RESULTS_TABLE, BASE);
    url.searchParams.set("alias", "results");
    url.searchParams.set("page", "1");
    url.searchParams.set("pageSize", "50");
    url.searchParams.set("language", "de");
    url.searchParams.set("callback", "externalStatisticsCallback"); // wichtig

    console.log("Hole:", url.toString());

    const res = await fetch(url.toString(), {
      headers: {
        "accept": "application/json, text/javascript;q=0.9,*/*;q=0.1",
        "user-agent": "ehc-sursee-scores/1.0"
      }
    });

    const text = await res.text();

    ensurePublicDir();
    fs.writeFileSync(path.join("public", "raw-results.txt"), text, "utf8");

    console.log(">>> Rohantwort gespeichert in public/raw-results.txt");
  } catch (err) {
    console.error("FEHLER:", err);
    ensurePublicDir();
    fs.writeFileSync(path.join("public", "raw-results.txt"), "ERROR: " + err.message, "utf8");
  }
}

main();
