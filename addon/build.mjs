// Construye el addon Stremio de catalogos "Nuevos episodios donghua":
// scrapea los feeds de ultimos episodios, deduplica por serie, resuelve
// titulo -> TMDB (solo animacion china, para no mezclar anime japones) y
// publica manifest.json + catalog/series/<id>.json + cache en PAGES_OUT.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fetchAllLatest } from "./latest.mjs";

const KEY = process.env.TMDB_API_KEY || "";
const OUT = process.env.PAGES_OUT || "pages";
const CACHE_IN = process.env.CACHE_PATH || path.join(OUT, "tmdb-cache.json");
const CATALOG_ID = "donghua-new-episodes";
const MAX_METAS = 60;

function curlJson(url) {
  return new Promise((resolve, reject) => {
    execFile("curl", ["-s", "-m", "30", url], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error("json invalido de " + url));
      }
    });
  });
}

const tmdb = (p) =>
  curlJson("https://api.themoviedb.org/3" + p + (p.includes("?") ? "&" : "?") + "api_key=" + KEY);

const norm = (s) =>
  String(s || "").toLowerCase().normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();

function score(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = a.split(" "), tb = b.split(" ");
  let inter = 0;
  for (const t of ta) if (tb.includes(t)) inter++;
  let base = inter / Math.max(ta.length, tb.length);
  if (b.startsWith(a) || a.startsWith(b)) base = Math.max(base, 0.8);
  return base;
}

const isDonghua = (r) =>
  (r.origin_country || []).includes("CN") || r.original_language === "zh";

// Romanizaciones del sitio que TMDB titula distinto.
const ALIAS = {
  "i will eternal": "A Will Eternal",
  "doupo cangqiong": "Fights Break Sphere",
  "xi xing ji asura": "The Westward",
  "supremo dantian": "Supreme Dantian",
};

async function resolveTitle(title, cache) {
  const k = norm(title);
  if (cache[k] !== undefined) return cache[k];
  const alias = ALIAS[k] || ALIAS[k.replace(/\s+\d+$/, "")];
  const queries = [alias || title, title.replace(/\s+\d+$/, "")];
  for (const q of queries) {
    for (const lang of ["es-ES", "en-US"]) {
      const res = await tmdb(`/search/tv?query=${encodeURIComponent(q)}&language=${lang}&include_adult=false`);
      const cands = (res.results || []).filter(isDonghua);
      if (!cands.length) continue;
      cands.sort((x, y) => score(q, y.name) - score(q, x.name));
      const best = cands[0];
      if (score(q, best.name) < 0.5 && score(q, best.original_name) < 0.5) continue;
      const detail = await tmdb(`/tv/${best.id}?language=es-ES`);
      let name = detail.name || best.name;
      if (/[㐀-鿿぀-ヿ]/.test(name)) {
        const en = await tmdb(`/tv/${best.id}?language=en-US`);
        if (en.name && !/[㐀-鿿぀-ヿ]/.test(en.name)) name = en.name;
      }
      const entry = {
        tmdb: best.id,
        imdb: null,
        name,
        poster: detail.poster_path ? "https://image.tmdb.org/t/p/w500" + detail.poster_path : null,
      };
      const ext = await tmdb(`/tv/${best.id}/external_ids`);
      entry.imdb = ext.imdb_id || null;
      cache[k] = entry;
      return entry;
    }
  }
  cache[k] = null;
  return null;
}

async function main() {
  if (!KEY) {
    console.error("Falta TMDB_API_KEY (env).");
    process.exit(1);
  }
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_IN, "utf8"));
  } catch {}

  const rows = await fetchAllLatest();
  const bySeries = new Map();
  for (const r of rows) {
    const k = norm(r.title);
    const prev = bySeries.get(k);
    if (!prev || (r.date || "") > (prev.date || "") || ((r.date || "") === (prev.date || "") && (r.episode || 0) > (prev.episode || 0))) {
      bySeries.set(k, r);
    }
  }
  const series = [...bySeries.values()].sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.episode || 0) - (a.episode || 0));

  const metas = [];
  const seen = new Set();
  for (const s of series) {
    if (metas.length >= MAX_METAS) break;
    const t = await resolveTitle(s.title, cache);
    if (!t || !t.poster) {
      console.log(`[skip] ${s.title} (sin ficha TMDB donghua)`);
      continue;
    }
    const id = t.imdb || "tmdb:" + t.tmdb;
    if (seen.has(id)) continue;
    seen.add(id);
    metas.push({ id, type: "series", name: t.name, poster: t.poster });
    console.log(`[ok] ${s.title} -> ${id} (${t.name}) EP ${s.episode} ${s.date || ""}`);
  }

  const manifest = {
    id: "community.donghua.newepisodes",
    version: "1.0.0",
    name: "Donghua Nuevos Episodios",
    description: "Episodios recientes de sitios donghua sub espanol",
    resources: ["catalog"],
    types: ["series"],
    catalogs: [{ type: "series", id: CATALOG_ID, name: "Nuevos episodios donghua" }],
    idPrefixes: ["tt", "tmdb"],
  };

  fs.mkdirSync(path.join(OUT, "catalog", "series"), { recursive: true });
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(OUT, "catalog", "series", CATALOG_ID + ".json"), JSON.stringify({ metas }, null, 2));
  fs.writeFileSync(path.join(OUT, "tmdb-cache.json"), JSON.stringify(cache, null, 2));
  console.log(`[done] ${metas.length} metas -> ${OUT}`);
}

main();