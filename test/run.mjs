/**
 * Harness de pruebas: ejecuta el provider JS con los mismos globals que
 * inyecta Nuvio TV en QuickJS (fetch sobre OkHttp -> fetch nativo de Node,
 * cheerio, TMDB_API_KEY, console). Los resultados se validan contra el
 * sitio real; no sustituye la prueba de reproduccion en el emulador.
 *
 * Uso:
 *   node test/run.mjs search <query>
 *   node test/run.mjs find <titulo> [season]
 *   node test/run.mjs eps <slug>
 *   node test/run.mjs ep <url-episodio>
 *   node test/run.mjs sizes <slug|url>
 *   node test/run.mjs tmdb <id> <tv|movie> [season] [episode]   (requiere TMDB_API_KEY)
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerioNS from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cheerio = cheerioNS.default ?? cheerioNS;

const code = readFileSync(path.join(__dirname, "..", "providers", "seriesdonghua.js"), "utf8");

const sandboxModule = { exports: {} };
const fn = new Function(
  "module", "exports", "cheerio", "fetch", "TMDB_API_KEY", "SCRAPER_ID", "console",
  code
);
fn(
  sandboxModule,
  sandboxModule.exports,
  cheerio,
  globalThis.fetch,
  process.env.TMDB_API_KEY || "",
  "seriesdonghua",
  console
);
const plugin = sandboxModule.exports;
const I = plugin._internals;

function fmtStreams(streams) {
  if (!streams.length) return "  (sin streams)";
  return streams.map(s => {
    const subs = (s.subtitles || []).map(x => x.language).join(",");
    return `  - [${s.quality}] ${s.title} | ${s.url.slice(0, 110)}${s.url.length > 110 ? "…" : ""} | subs: ${subs || "0"}`;
  }).join("\n");
}

async function validate(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.dailymotion.com/" }
    });
    const ct = res.headers.get("content-type") || "";
    if (/m3u8|mpegurl/i.test(ct) || /\.m3u8/i.test(url)) {
      const text = await res.text();
      return `HTTP ${res.status} ${text.trim().startsWith("#EXTM3U") ? "M3U8-OK" : "NO-M3U8"}`;
    }
    return `HTTP ${res.status} ${ct.slice(0, 40)}`;
  } catch (e) {
    return `ERR ${e.message}`;
  }
}

const [, , cmd, ...args] = process.argv;
const t0 = Date.now();

try {
  if (cmd === "search") {
    const cards = await I.searchSite(args.join(" "));
    console.log(`search "${args.join(" ")}" -> ${cards.length} fichas`);
    cards.slice(0, 10).forEach(c => console.log(`  - ${c.title} -> ${c.url}`));
  } else if (cmd === "find") {
    const season = args[1] != null ? parseInt(args[1], 10) : null;
    const best = await I.findSeries([args[0]], season);
    console.log(`find "${args[0]}" S${season ?? "-"} -> ${best ? best.title + " (score " + best.score.toFixed(2) + ") " + best.url : "SIN MATCH"}`);
  } else if (cmd === "eps") {
    const slug = args[0].startsWith("http") ? args[0] : `https://seriesdonghua.com/${args[0]}/`;
    const eps = await I.seriesEpisodes(slug);
    const nums = Object.keys(eps.map).map(Number).sort((a, b) => a - b);
    console.log(`episodios: ${nums.length} | min ${eps.min} max ${eps.max}`);
    console.log(`primeros: ${nums.slice(0, 6).join(", ")}  ultimos: ${nums.slice(-4).join(", ")}`);
  } else if (cmd === "ep") {
    const streams = await I.episodeStreams(args[0]);
    console.log(`streams: ${streams.length} (${Date.now() - t0} ms)`);
    console.log(fmtStreams(streams));
    for (const s of streams.slice(0, 4)) console.log(`  validar: ${await validate(s.url)}`);
  } else if (cmd === "sizes") {
    const url = args[0].startsWith("http") ? args[0] : `https://seriesdonghua.com/${args[0]}/`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const txt = await res.text();
    console.log(`${url} -> HTTP ${res.status}, ${(txt.length / 1024).toFixed(0)} KB (limite Nuvio: 1024 KB), grid: ${(txt.match(/episode-card-item/g) || []).length}`);
  } else if (cmd === "tmdb") {
    const [id, type, season, episode] = args;
    const streams = await plugin.getStreams(id, type === "movie" ? "movie" : "tv", season ? +season : null, episode ? +episode : null);
    console.log(`getStreams(${id}, ${type}, S${season || "-"}E${episode || "-"}): ${streams.length} streams (${Date.now() - t0} ms)`);
    console.log(fmtStreams(streams));
    for (const s of streams.slice(0, 4)) console.log(`  validar: ${await validate(s.url)}`);
  } else {
    console.log(__doc__ || "comandos: search | find | eps | ep | sizes | tmdb");
  }
} catch (e) {
  console.error("FALLO:", e);
  process.exitCode = 1;
}
