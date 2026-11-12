/**
 * Bateria de pruebas de todos los proveedores contra TMDB + sitios reales.
 *
 *   TMDB_API_KEY=... node test/all.mjs [providerId ...]
 *
 * Para cada proveedor ejecuta getStreams con casos reales y valida cada
 * stream con SUS PROPIOS headers (el Referer importa: OK.ru/Rumble/byse
 * responden 400/403 si se pide con el Referer equivocado).
 */

import { loadProvider } from "./run.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "nuvio-check-"));

/**
 * Valida un stream con curl (no con fetch de Node): el CDN de Dailymotion
 * responde 403 al fingerprint TLS de undici pero 200 a curl/OkHttp, que es lo
 * que usa Nuvio en la TV. execFileSync evita pasar por el shell.
 */
function curlCheck(url, headers) {
  const out = path.join(tmp, "body.bin");
  const args = ["-sS", "--max-time", "25", "-o", out, "-w", "%{http_code}|%{content_type}"];
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === "user-agent") args.push("-A", String(v));
    else if (k.toLowerCase() === "referer") args.push("-e", String(v));
    else args.push("-H", `${k}: ${v}`);
  }
  args.push(url);
  const meta = execFileSync("curl", args, { encoding: "utf8" });
  const [code, ct] = meta.split("|");
  let body = "";
  try { body = readFileSync(out, "utf8").slice(0, 200); } catch (e) {}
  return { code: parseInt(code, 10) || 0, ct: ct || "", body };
}

// Los episodios pedidos son de los que cada sitio TODAVIA aloja: varios podan
// los capitulos viejos (AnimeCube solo 184-250 de Swallowed Star, Byse borra
// los videos antiguos) y otros no tienen la serie (LmAnime no lleva Naruto).
const CASES = {
  animecube: [[106449, "tv", 1, 1], [101172, "tv", 1, 249]],
  animegratis: [[46260, "tv", 1, 1], [37854, "tv", 1, 1]],
  animexin: [[101172, "tv", 1, 249], [76806, "tv", 1, 1]],
  donghualife: [[101172, "tv", 1, 1], [76806, "tv", 1, 1]],
  donghuaworld: [[101172, "tv", 1, 249], [76572, "tv", 1, 1]],
  donghuazone: [[101172, "tv", 1, 1], [129272, "tv", 1, 1]],
  lmanime: [[101172, "tv", 1, 249], [76806, "tv", 1, 1]],
  luciferdonghua: [[76806, "tv", 1, 1], [101172, "tv", 1, 165]],
  mundodonghua: [[101172, "tv", 1, 26], [76572, "tv", 1, 263]],
  seriesdonghua: [[101172, "tv", 1, 1], [76806, "tv", 1, 1]],
  tiodonghua: [[101172, "tv", 1, 1], [129272, "tv", 1, 1]]
};

async function checkStream(s) {
  try {
    const r = curlCheck(s.url, s.headers);
    if (/m3u8|mpegurl/i.test(r.ct) || /\.m3u8/i.test(s.url)) {
      return r.code === 200 && r.body.trim().startsWith("#EXTM3U") ? "OK" : `HTTP ${r.code}`;
    }
    if (r.code === 200 || r.code === 206) return "OK";
    return `HTTP ${r.code}`;
  } catch (e) {
    return "ERR " + (e.message || "").slice(0, 40);
  }
}

const only = process.argv.slice(2);
const ids = Object.keys(CASES).filter((id) => !only.length || only.includes(id));
const results = [];

for (const id of ids) {
  const plugin = loadProvider(id);
  for (const [tmdbId, type, s, e] of CASES[id]) {
    const t0 = Date.now();
    let streams = [];
    try {
      streams = await plugin.getStreams(tmdbId, type, s, e);
    } catch (err) {
      console.log(`${id} ${tmdbId} S${s}E${e}: EXCEPCION ${err.message}`);
    }
    const ms = Date.now() - t0;
    let ok = 0;
    const statuses = [];
    for (const st of streams.slice(0, 6)) {
      const r = await checkStream(st);
      statuses.push(r);
      if (r === "OK") ok++;
    }
    const slow = ms > 60000 ? " (>60s TIMEOUT NUVIO)" : "";
    console.log(`${id.padEnd(15)} tmdb=${String(tmdbId).padEnd(7)} S${s}E${String(e).padEnd(4)} streams=${String(streams.length).padStart(2)} validos=${ok}/${Math.min(streams.length, 6)} ${(ms / 1000).toFixed(1)}s${slow} [${statuses.join(", ")}]`);
    results.push({ id, tmdbId, s, e, streams: streams.length, ok, ms });
  }
}

console.log("\n== RESUMEN ==");
for (const id of ids) {
  const rs = results.filter((r) => r.id === id);
  const total = rs.reduce((a, r) => a + r.streams, 0);
  const ok = rs.reduce((a, r) => a + r.ok, 0);
  const maxMs = Math.max(...rs.map((r) => r.ms));
  console.log(`${id.padEnd(15)} casos=${rs.length} streams=${total} validos=${ok} max=${(maxMs / 1000).toFixed(1)}s ${total > 0 && ok > 0 ? "PASA" : total > 0 ? "SIN VALIDAR" : "FALLA"}`);
}
