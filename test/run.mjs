/**
 * Harness de pruebas: ejecuta el provider JS con los mismos globals que
 * inyecta Nuvio TV en QuickJS (fetch sobre OkHttp -> fetch nativo de Node,
 * cheerio, TMDB_API_KEY, console). Los resultados se validan contra el
 * sitio real; no sustituye la prueba de reproduccion en el emulador.
 *
 * Uso:
 *   node test/run.mjs <provider> search <query>
 *   node test/run.mjs <provider> find <titulo> [season]
 *   node test/run.mjs <provider> eps <slug|url>
 *   node test/run.mjs <provider> ep <url-episodio>
 *   node test/run.mjs <provider> sizes <slug|url>
 *   node test/run.mjs <provider> tmdb <id> <tv|movie> [season] [episode]
 *
 * <provider> es opcional: si se omite se usa "seriesdonghua".
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeCheerio } from "./quickjsCheerio.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const cheerio = makeCheerio();

const COMMANDS = ["search", "find", "eps", "ep", "sizes", "tmdb"];

/** Carga un provider compilado (providers/<id>.js) con los globals de QuickJS. */
export function loadProvider(id) {
  const file = path.join(root, "providers", id + ".js");
  const code = readFileSync(file, "utf8");
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
    id,
    console
  );
  return sandboxModule.exports;
}

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

const argv = process.argv.slice(2);
let providerId = "seriesdonghua";
if (argv.length && !COMMANDS.includes(argv[0])) providerId = argv.shift();
const [cmd, ...args] = argv;
const t0 = Date.now();

async function main() {
  const plugin = loadProvider(providerId);
  const I = plugin._internals || {};
  const site = I.site || {};
  console.log(`== ${providerId} (${plugin.name}) ==`);

  if (cmd === "search") {
    const cards = await site.search(args.join(" "));
    console.log(`search "${args.join(" ")}" -> ${cards.length} fichas`);
    cards.slice(0, 10).forEach(c => console.log(`  - ${c.title} -> ${c.url}`));
  } else if (cmd === "find") {
    const season = args[1] != null ? parseInt(args[1], 10) : null;
    const best = await I.findSeries([args[0]], season);
    console.log(`find "${args[0]}" S${season ?? "-"} -> ${best ? best.title + " (score " + best.score.toFixed(2) + ") " + best.url : "SIN MATCH"}`);
  } else if (cmd === "eps") {
    const url = args[0].startsWith("http") ? args[0] : `${site.base}/${args[0]}/`;
    const eps = await site.episodes(url);
    const nums = Object.keys(eps.map).map(Number).sort((a, b) => a - b);
    console.log(`episodios: ${nums.length} | min ${eps.min} max ${eps.max}`);
    console.log(`primeros: ${nums.slice(0, 6).join(", ")}  ultimos: ${nums.slice(-4).join(", ")}`);
  } else if (cmd === "ep") {
    const streams = await site.streams(args[0]);
    console.log(`streams: ${streams.length} (${Date.now() - t0} ms)`);
    console.log(fmtStreams(streams));
    for (const s of streams.slice(0, 4)) console.log(`  validar: ${await validate(s.url)}`);
  } else if (cmd === "sizes") {
    const url = args[0].startsWith("http") ? args[0] : `${site.base}/${args[0]}/`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const txt = await res.text();
    console.log(`${url} -> HTTP ${res.status}, ${(txt.length / 1024).toFixed(0)} KB (limite Nuvio: 1024 KB)`);
  } else if (cmd === "tmdb") {
    const [id, type, season, episode] = args;
    const streams = await plugin.getStreams(id, type === "movie" ? "movie" : "tv", season ? +season : null, episode ? +episode : null);
    console.log(`getStreams(${id}, ${type}, S${season || "-"}E${episode || "-"}): ${streams.length} streams (${Date.now() - t0} ms)`);
    console.log(fmtStreams(streams));
    for (const s of streams.slice(0, 4)) console.log(`  validar: ${await validate(s.url)}`);
  } else {
    console.log("comandos: " + COMMANDS.join(" | "));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error("FALLO:", e);
    process.exitCode = 1;
  });
}
