/**
 * TioDonghua — plugin Nuvio TV (repo nuvio-donghua).
 * Archivo GENERADO por tools/build.mjs: no editar a mano.
 * Fuentes: src/core.js + src/sites/tiodonghua.js
 */

/**
 * Nucleo compartido de los plugins Nuvio TV de nuvio-donghua.
 *
 * Nuvio carga UN archivo .js por scraper (sin require/import entre archivos:
 * PluginManager guarda el codigo tal cual y lo evalua en QuickJS). Por eso
 * tools/build.mjs concatena este core + src/sites/<id>.js en
 * providers/<id>.js, que es el archivo autocontenido que ve la app.
 *
 * Globals disponibles en QuickJS (PluginRuntime.kt): fetch, cheerio,
 * TMDB_API_KEY, SCRAPER_ID, SCRAPER_SETTINGS, console.
 */

var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
var DM_REFERER = "https://www.dailymotion.com/";
var BUDGET_MS = 42000; // Nuvio mata el plugin a los 60s; margen para emitir
var _t0 = 0;           // inicio de getStreams (presupuesto de ejecucion)
var _siteName = "donghua";

// ==================== utilidades ====================

function log(msg) {
  try { console.log("[" + _siteName + "] " + msg); } catch (e) {}
}

function unescJson(s) {
  return String(s || "")
    .replace(/\\u([0-9a-fA-F]{4})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n");
}

/** URL absoluta respecto a la base del sitio. */
function absUrl(base, u) {
  u = String(u || "").trim();
  if (u.indexOf("http") === 0) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  if (u.indexOf("/") === 0) return base + u;
  if (u) return base + "/" + u;
  return "";
}

function baseHeaders(referer) {
  var h = { "User-Agent": UA, "Accept": "text/html,*/*" };
  if (referer) h["Referer"] = referer;
  return h;
}

/** GET/POST de texto. opts: {referer, headers, method, body}. */
async function fetchText(url, opts) {
  opts = opts || {};
  try {
    var h = baseHeaders(opts.referer);
    if (opts.headers) {
      for (var k in opts.headers) if (Object.prototype.hasOwnProperty.call(opts.headers, k)) h[k] = opts.headers[k];
    }
    var init = { headers: h };
    if (opts.method) init.method = opts.method;
    if (opts.body != null) init.body = opts.body;
    var res = await fetch(url, init);
    return await res.text();
  } catch (e) {
    log("fetch fallo " + url + ": " + (e && e.message));
    return "";
  }
}

/** GET que devuelve la Response (para leer headers/cookies). */
async function fetchRaw(url, opts) {
  opts = opts || {};
  try {
    var h = baseHeaders(opts.referer);
    if (opts.headers) {
      for (var k in opts.headers) if (Object.prototype.hasOwnProperty.call(opts.headers, k)) h[k] = opts.headers[k];
    }
    var init = { headers: h };
    if (opts.method) init.method = opts.method;
    if (opts.body != null) init.body = opts.body;
    return await fetch(url, init);
  } catch (e) {
    log("fetch fallo " + url + ": " + (e && e.message));
    return null;
  }
}

/** Cookies de un header Set-Cookie (posiblemente combinado) para reenviarlas explicitas. */
function parseCookieList(list) {
  var out = [];
  (list || []).forEach(function (raw) {
    var seg = String(raw).split(";")[0].trim();
    if (seg && /^[A-Za-z0-9_\-]+=/.test(seg) && !/^(expires|path|domain|samesite|secure|httponly|max-age)=/i.test(seg)) {
      out.push(seg);
    }
  });
  return out;
}

function parseCookies(raw) {
  if (!raw) return "";
  var parts = String(raw).indexOf("\n") >= 0
    ? String(raw).split("\n")
    : String(raw).split(/,\s*(?=[A-Za-z0-9_\-]+=)/);
  return parseCookieList(parts).join("; ");
}

/** Lee cookies de una Response: getSetCookie (undici/Node) o headers.get. */
function readCookies(res) {
  try {
    if (res && res.headers && typeof res.headers.getSetCookie === "function") {
      var joined = parseCookieList(res.headers.getSetCookie()).join("; ");
      if (joined) return joined;
    }
  } catch (e) {}
  return parseCookies(res && res.headers && res.headers.get ? res.headers.get("set-cookie") : "");
}

function isJunkVideoUrl(u) {
  return /test-videos\.co\.uk/i.test(u) || /av01/i.test(u) || /\/av1\//i.test(u) || /\.mp4[A-Za-z0-9]/.test(u);
}

function qualityFromHeight(h) {
  h = parseInt(h, 10);
  if (!h) return null;
  if (h >= 2160) return "4K";
  if (h >= 1440) return "1440p";
  if (h >= 1080) return "1080p";
  if (h >= 720) return "720p";
  if (h >= 480) return "480p";
  if (h >= 360) return "360p";
  return null;
}

function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

/** Puntaje de match titulo buscado vs titulo del sitio (0..1). */
function titleScore(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  var ta = a.split(" "), tb = b.split(" ");
  var inter = 0;
  for (var i = 0; i < ta.length; i++) {
    if (ta[i] && tb.indexOf(ta[i]) >= 0) inter++;
  }
  var base = inter / Math.max(ta.length, tb.length);
  if (b.indexOf(a) === 0 || a.indexOf(b) === 0) base = Math.max(base, 0.8);
  return base;
}

/**
 * Secuela/spin-off: "<titulo buscado> <N> <subtitulo>" (p.ej. pedir "Soul Land"
 * y que el sitio solo tenga "Soul Land 5: The Rebirth of Tang San"). Son series
 * distintas con ficha propia en TMDB, pero el bonus de prefijo de titleScore
 * las daba por buenas (0.8) y se reproducia otro show. Un numero solo
 * ("Swallowed Star 5") si es temporada de la misma serie y no se penaliza.
 */
function isSequelTitle(searched, candidate) {
  var a = norm(searched), b = norm(candidate);
  if (!a || !b || b.indexOf(a) !== 0) return false;
  var m = /^(\d+|[ivx]+)\s+(.+)$/.exec(b.slice(a.length).trim());
  return !!m;
}

/** Decodifica entidades HTML comunes (cheerio no siempre las resuelve en atributos). */
function decodeEntities(s) {
  return String(s || "")
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

/** Numero de episodio a partir de textos habituales ("Episode 12", "Ep. 12", "E12"). */
function episodeNumberFrom(text) {
  var m = /(?:episode|ep\.?|capitulo|capitulo|episodio)[\s:#-]*(\d{1,4})/i.exec(String(text || ""));
  if (m) return parseInt(m[1], 10);
  m = /(?:^|\s)e(\d{1,4})(?:\s|$)/i.exec(String(text || ""));
  if (m) return parseInt(m[1], 10);
  return NaN;
}

/** Titulo de serie limpio a partir de un titulo de ficha ("X Episode 12 - Sub"). */
function cleanSeriesTitle(title) {
  return String(title || "")
    .replace(/\s*(?:episode|ep\.?|capitulo|episodio)\s*\d+(?:\s*-\s*\d+)?.*$/i, "")
    .replace(/\s*[\[(][^\])]*[\])]\s*$/, "")
    .replace(/\s*-\s*sub(?:bed)?(?:\s+espa(?:ñ|n)ol)?\s*$/i, "")
    .replace(/\s*\|\s*.*$/, "")
    .trim();
}

// ==================== TMDB ====================

async function tmdbMeta(id, isMovie) {
  if (!TMDB_API_KEY) { log("sin TMDB_API_KEY"); return null; }
  try {
    var url = "https://api.themoviedb.org/3/" + (isMovie ? "movie/" : "tv/") + id +
      "?api_key=" + TMDB_API_KEY + "&language=es-ES";
    var res = await fetch(url, { headers: baseHeaders() });
    var j = await res.json();
    return j && (j.name || j.title) ? j : null;
  } catch (e) {
    log("tmdb fallo: " + (e && e.message));
    return null;
  }
}

/** Titulos alternativos (p.ej. "Soul Land" -> "Combat Continent" en el sitio). */
async function tmdbAltTitles(id, isMovie) {
  if (!TMDB_API_KEY) return [];
  try {
    var res = await fetch("https://api.themoviedb.org/3/" + (isMovie ? "movie/" : "tv/") + id +
      "/alternative_titles?api_key=" + TMDB_API_KEY);
    var j = await res.json();
    if (!j) return [];
    var arr = (j.results || []).map(function (r) { return r.title; });
    if (j.titles) arr = arr.concat(j.titles.map(function (t) { return t.title; }));
    return arr.filter(Boolean);
  } catch (e) {
    return [];
  }
}

/** Titulo en ingles via translations (el sitio titula en ingles; TMDB es-ES
 *  a veces devuelve pinyin/chino). */
async function tmdbEngName(id, isMovie) {
  if (!TMDB_API_KEY) return null;
  try {
    var res = await fetch("https://api.themoviedb.org/3/" + (isMovie ? "movie/" : "tv/") + id +
      "/translations?api_key=" + TMDB_API_KEY);
    var j = await res.json();
    if (!j || !j.translations) return null;
    for (var i = 0; i < j.translations.length; i++) {
      var t = j.translations[i];
      if (t.iso_639_1 === "en" && t.data && t.data.name) return t.data.name;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function tmdbTitles(meta, season) {
  var names = [];
  [meta.name, meta.original_name, meta.title, meta.original_title].forEach(function (n) {
    if (n && names.indexOf(n) < 0) names.push(n);
  });
  if (season != null && meta.seasons) {
    for (var i = 0; i < meta.seasons.length; i++) {
      var s = meta.seasons[i];
      if ((s.season_number || 0) === season && s.name && names.indexOf(s.name) < 0) names.push(s.name);
    }
  }
  return names;
}

/** S/E de TMDB -> numero(s) de episodio del sitio (global vs por temporada). */
function computeEpisode(meta, season, episode) {
  season = parseInt(season, 10) || 1;
  episode = parseInt(episode, 10) || 1;
  var sum = 0, totalSum = 0, counted = false;
  (meta.seasons || []).forEach(function (s) {
    var n = s.season_number || 0;
    var cnt = s.episode_count || 0;
    if (n > 0) {
      totalSum += cnt;
      if (n > 0 && n < season) { sum += cnt; counted = true; }
    }
  });
  return {
    season: season,
    episode: episode,
    absolute: counted ? sum + episode : null,
    totalAbs: totalSum || null
  };
}

// ==================== extractores de players ====================

/** Estructura de salida compartida por los extractores. */
function newEmit() {
  return { streams: [], subtitles: [], urls: {}, subs: {}, dm: {} };
}

/** Adjunta las pistas de subtitulos a cada stream y devuelve el array. */
function finishEmit(out) {
  for (var i = 0; i < out.streams.length; i++) out.streams[i].subtitles = out.subtitles;
  return out.streams;
}

function pushStream(out, url, quality, server, referer, ua) {
  if (!url || String(url).indexOf("http") !== 0) return;
  if (out.urls[url]) return;
  out.urls[url] = 1;
  var h = { "User-Agent": ua || UA };
  if (referer) h["Referer"] = referer;
  out.streams.push({
    name: _siteName,
    title: server || _siteName,
    url: url,
    quality: quality || "Auto",
    headers: h
  });
}

/** Master/variantes HLS: solo variantes H264 con audio muxed (las fMP4 video-only
 *  y AV1/HEVC dan negro o sin audio); el master completo queda como "Auto". */
async function tryPlaylist(u, out, server, referer) {
  if (!u || u.indexOf("http") !== 0) return false;
  if (/dmxleo|advertising|auth=/i.test(u)) return false;
  var master = await fetchText(u, { referer: referer });
  if (!master || master.trim().indexOf("#EXTM3U") !== 0) {
    pushStream(out, u, "Auto", server, referer);
    return true;
  }
  var re = /#EXT-X-STREAM-INF:([^\n]*)\n([^\n]+)/g, m;
  while ((m = re.exec(master))) {
    var attrs = m[1], variant = m[2].trim();
    var codecs = (/CODECS="([^"]+)"/.exec(attrs) || ["", ""])[1];
    if (/av01|hev1|hvc1/i.test(codecs)) continue;
    if (/\bAUDIO=/.test(attrs)) continue;
    if (codecs && !/mp4a|aac|ac-3|eac-3|ec-3|opus|flac|mp3/i.test(codecs)) continue;
    var h = (/RESOLUTION=\d+x(\d+)/.exec(attrs) || [])[1];
    var origin = (/^https?:\/\/[^\/]+/.exec(u) || [u])[0];
    var abs = variant.indexOf("http") === 0 ? variant
      : (variant.charAt(0) === "/" ? origin + variant : origin + "/" + variant);
    pushStream(out, abs, qualityFromHeight(h) || "Auto", server, referer);
  }
  pushStream(out, u, "Auto", server, referer);
  return true;
}

/** Bloque subtitles.data del metadata de Dailymotion (objeto balanceado). */
function dmSubtitlesBlock(json) {
  var start = json.indexOf('"subtitles"');
  if (start < 0) return null;
  var dataIdx = json.indexOf('"data"', start);
  if (dataIdx < 0) return null;
  var open = json.indexOf("{", dataIdx);
  if (open < 0) return null;
  var depth = 0, inStr = false, esc = false;
  for (var i = open; i < json.length; i++) {
    var ch = json.charAt(i);
    if (esc) { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (!inStr && ch === "{") depth++;
    if (!inStr && ch === "}") { depth--; if (depth === 0) return json.substring(open, i + 1); }
  }
  return null;
}

function dmLangName(code) {
  if (code.indexOf("es") === 0) return code.indexOf("auto") >= 0 ? "Espanol (auto)" : "Espanol";
  if (code.indexOf("en") === 0) return code.indexOf("auto") >= 0 ? "English (auto)" : "English";
  var names = { fr: "French", pt: "Portuguese", ru: "Russian", tr: "Turkish", pl: "Polish", ar: "Arabic", it: "Italian", de: "German", hi: "Hindi", th: "Thai", vi: "Vietnamese" };
  var k = code.substring(0, 2);
  return names[k] || code;
}

function dmVideoId(src) {
  var m = /(?:geo\.dailymotion\.com\/player(?:\/[a-z0-9]+)?\.html\?video=|dailymotion\.com\/embed\/video\/|dailymotion\.com\/video\/|dai\.ly\/)([A-Za-z0-9]+)/i.exec(src);
  return m ? m[1] : (/^[A-Za-z0-9]+$/.test(src.trim()) ? src.trim() : null);
}

/** Dailymotion via metadata API: HLS muxed + progresivos + pistas de subs (es primero). */
async function extractDailymotion(embedUrl, referer, out) {
  var vid = dmVideoId(embedUrl);
  if (!vid) return false;
  if (out.dm[vid]) return true;
  var embedder = referer || "";
  var metaUrl = "https://www.dailymotion.com/player/metadata/video/" + vid +
    "?embedder=" + encodeURIComponent(embedder) + "&integration=inline&app=com.dailymotion.neon";
  var json = await fetchText(metaUrl, { referer: embedder });
  if (!json) return false;
  json = json.replace(/\\\//g, "/").replace(/\\u0026/g, "&");

  var block = dmSubtitlesBlock(json);
  if (block) {
    var re = /"(es[a-z-]*|en[a-z-]*|fr|pt|ru|tr|pl|ar|it|de)":\s*\{[^{}]*?"urls":\["([^"]+)"/g, m;
    while ((m = re.exec(block))) {
      var url = unescJson(m[2]);
      if (url.indexOf("http") !== 0 || out.subs[url]) continue;
      out.subs[url] = 1;
      var code = m[1];
      out.subtitles.push({
        url: url,
        language: code.indexOf("es") === 0 ? "es" : (code.indexOf("en") === 0 ? "en" : code.substring(0, 2)),
        name: dmLangName(code)
      });
    }
  }

  var found = false;
  var auto = /"auto":\[\{[^}]*?"url":"(https:\/\/[^"]+)"/.exec(json) ||
    /"auto":\[\{"url":"(https:\/\/[^"]+)"/.exec(json);
  if (auto && auto[1].indexOf("dailymotion.com") >= 0) {
    found = await tryPlaylist(unescJson(auto[1]), out, "Dailymotion", DM_REFERER);
  }
  if (!found) {
    var masterAuto = /https:\/\/[a-z0-9.-]+\.dailymotion\.com\/cdn\/manifest\/video\/[a-z0-9]+\.m3u8[^"']*/i.exec(json);
    if (masterAuto) {
      var dc = /https:\/\/([a-z0-9.-]+)\.dailymotion\.com/i.exec(masterAuto[0]);
      var host = dc ? dc[1] : "";
      var vid2 = /video\/([a-z0-9]+)\.m3u8/i.exec(masterAuto[0]);
      if (host && !/^cdndirector/i.test(host) && vid2) {
        var presets = ["H264-1280x720", "H264-1920x1080", "H264-854x480"];
        for (var p = 0; p < presets.length && !found; p++) {
          found = await tryPlaylist(
            "https://" + host + ".dailymotion.com/cdn/" + presets[p] + "/vCRN/mp4_h264_aac.m3u8?video=" + vid2[1],
            out, "Dailymotion", DM_REFERER);
        }
      }
    }
  }
  if (!found) {
    var re2 = /https:\/\/[^"']+?dmcdn[^"']*?\.m3u8[^"']*/gi, m2;
    while ((m2 = re2.exec(json)) && !found) {
      var u2 = m2[0];
      if (/\/av1|_av1_/i.test(u2)) continue;
      found = await tryPlaylist(u2, out, "Dailymotion", DM_REFERER);
    }
  }
  if (found) { out.dm[vid] = 1; return true; }

  // ultimo recurso: progresivos mp4 del qualities map
  var re3 = /"(\d{3,4})":\[\{"type":"([^"]+)","url":"([^"]+)"/g, m3;
  while ((m3 = re3.exec(json))) {
    var u3 = unescJson(m3[3]);
    if (u3.indexOf("http") !== 0 || isJunkVideoUrl(u3)) continue;
    pushStream(out, u3, qualityFromHeight(m3[1]) || "Auto", "Dailymotion", DM_REFERER);
  }
  if (out.streams.length) { out.dm[vid] = 1; return true; }
  return false;
}

/** Ok.ru via data-options del embed. */
async function extractOkRu(embedUrl, referer, out) {
  var url = embedUrl.indexOf("//") === 0 ? "https:" + embedUrl : embedUrl;
  var html = await fetchText(url, { referer: referer });
  if (!html) return false;
  var raw = /data-options="([^"]+)"/.exec(html);
  if (!raw) return false;
  var options = unescJson(raw[1].replace(/&quot;/g, '"'));
  var found = false;
  var re = /"(?:[a-zA-Z]*ManifestUrl|ondemandHls)":"([^"]+)"/g, m;
  var candidates = [];
  while ((m = re.exec(options))) candidates.push(unescJson(m[1]));
  for (var i = 0; i < candidates.length && !found; i++) {
    var playlist = await fetchText(candidates[i], { referer: url });
    if (playlist && playlist.trim().indexOf("#EXTM3U") === 0) {
      found = await tryPlaylist(candidates[i], out, "OK.ru", url);
    }
  }
  var re2 = /"name":"(mobile|lowest|low|sd|hd|full|super)","url":"([^"]+)"/g, m2;
  while ((m2 = re2.exec(options))) {
    var u2 = unescJson(m2[2]);
    if (u2.indexOf("http") !== 0) continue;
    var q = { full: "1080p", super: "1080p", hd: "720p", sd: "480p" }[m2[1]] || "360p";
    pushStream(out, u2, q, "OK.ru", url);
  }
  return out.streams.length > 0;
}

/** Rumble: API embedJS u3 (embed= obligatorio) + fallback HTML del embed. */
async function extractRumble(embedUrl, referer, out) {
  var vid = /rumble\.com\/(?:embed\/)?(v[a-zA-Z0-9]+)/i.exec(embedUrl);
  if (!vid) return false;
  var api = "https://rumble.com/embedJS/u3/?request=video&v=" + vid[1] + "&embed=" + encodeURIComponent(embedUrl);
  var json = await fetchText(api, { referer: "https://rumble.com/" });
  var fixed = json.replace(/\\\//g, "/");
  var re = /"(\d{3,4})":\["(https:\/\/[a-z0-9.-]*rumble\.cloud\/video\/[A-Za-z0-9\/._-]+\.mp4)"/gi, m;
  while ((m = re.exec(fixed))) {
    pushStream(out, m[2], qualityFromHeight(m[1]) || "Auto", "Rumble", "https://rumble.com/");
  }
  if (!out.streams.length) {
    var html = await fetchText(embedUrl, { referer: referer });
    var f2 = html.replace(/\\\//g, "/");
    var hls = /"hls":\{"url":"(https:\/\/rumble\.com\/hls-vod\/[^"]+)"/.exec(f2);
    if (hls) {
      if (await tryPlaylist(hls[1], out, "Rumble", embedUrl)) return out.streams.length > 0;
    }
    var re2 = /"(\d{3,4})":\{"url":"(https:\/\/[a-z0-9.-]*rumble\.cloud\/video\/[A-Za-z0-9\/._-]+\.mp4)"/gi, m2;
    while ((m2 = re2.exec(f2))) {
      pushStream(out, m2[2], qualityFromHeight(m2[1]) || "Auto", "Rumble", embedUrl);
    }
    if (!out.streams.length) {
      var mp4 = /https:\/\/[a-z0-9.-]*rumble\.cloud\/video\/[A-Za-z0-9\/._-]+\.mp4/i.exec(f2);
      if (mp4) pushStream(out, mp4[0], "Auto", "Rumble", embedUrl);
    }
  }
  return out.streams.length > 0;
}

/** Voe: el embed corto redirige por JS a otro dominio (sin ejecutor JS: seguir a mano). */
async function extractVoe(videoUrl, referer, out) {
  var html = await fetchText(videoUrl, { referer: referer });
  if (!html) return false;
  if (html.length < 1200 && html.indexOf("window.location.href") >= 0) {
    var dest = /window\.location\.href\s*=\s*'(https:\/\/[^']+)'/.exec(html);
    if (dest) html = await fetchText(dest[1], { referer: videoUrl });
  }
  var m3u8 = /https?:\/\/[^"'\s<>]+\.m3u8[^\s"'<>]*/.exec(html);
  if (m3u8) return await tryPlaylist(m3u8[0], out, "Voe", videoUrl);
  var re = /https?:\/\/[^"'\s<>]+\.mp4[^\s"'<>]*/g, m;
  while ((m = re.exec(html))) {
    if (isJunkVideoUrl(m[0])) continue;
    pushStream(out, m[0], "Auto", "Voe", videoUrl);
    return true;
  }
  return false;
}

/** Ultimo recurso: m3u8/mp4 sueltos en la pagina del embed. */
async function extractGeneric(playerUrl, referer, out, server) {
  var text = await fetchText(playerUrl, { referer: referer });
  if (!text) return false;
  var m3u8 = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/.exec(text);
  if (m3u8) return await tryPlaylist(m3u8[0], out, server || "Servidor", playerUrl);
  var re = /https?:\/\/[^"'\s<>]+\.mp4[^\s"'<>]*/g, m;
  while ((m = re.exec(text))) {
    if (isJunkVideoUrl(m[0])) continue;
    pushStream(out, m[0], "Auto", server || "Servidor", playerUrl);
    return true;
  }
  return false;
}

/** Enruta un embed al extractor que corresponda por host. */
async function routeEmbed(embedUrl, referer, serverName, out) {
  var u = String(embedUrl || "").trim();
  if (!u || u.indexOf("http") !== 0) return false;
  if (u.indexOf("dailymotion.com") >= 0 || u.indexOf("dai.ly") >= 0) {
    return await extractDailymotion(u, referer, out);
  }
  if (u.indexOf("ok.ru") >= 0 || u.indexOf("odnoklassniki") >= 0) {
    return await extractOkRu(u, referer, out);
  }
  if (u.indexOf("rumble.com") >= 0) {
    return await extractRumble(u, referer, out);
  }
  if (u.indexOf("voe.") >= 0 || u.indexOf("voeunblk") >= 0 || u.indexOf("audaciousdefaulthouse") >= 0) {
    return await extractVoe(u, referer, out);
  }
  return await extractGeneric(u, referer, out, serverName);
}

/** Respaldo: embeds sueltos dentro del HTML de una pagina. */
async function extractEmbedsFromHtml(html, referer, out, serverName) {
  var re = /(https?:\/\/[^"'\s<>]*(?:dailymotion\.com\/(?:embed\/)?video|ok\.ru\/videoembed|rumble\.com\/embed|voe\.[a-z]+\/e\/)[^"'\s<>]*)/g, m;
  var seen = {};
  while ((m = re.exec(html))) {
    var u = m[1].replace(/\\\//g, "/");
    if (seen[u]) continue;
    seen[u] = 1;
    await routeEmbed(u, referer, serverName || "Servidor", out);
  }
}

// ==================== matching generico ====================

/**
 * Elige la ficha del sitio para un titulo TMDB.
 * site.search(query) -> [{title,url}]; site.seasonOfUrl(url) opcional (numero
 * de temporada) para preferir la ficha de la temporada pedida.
 */
async function findSeries(site, titles, season) {
  var byUrl = {}, all = [], best = null, bestScore = 0;
  var limit = Math.min(titles.length, 7);
  for (var i = 0; i < limit; i++) {
    if (!titles[i]) continue;
    var cards = await site.search(titles[i]);
    for (var j = 0; j < cards.length; j++) {
      var cand = cards[j];
      var entry = byUrl[cand.url];
      if (!entry) { entry = cand; entry.baseScore = 0; byUrl[cand.url] = entry; all.push(entry); }
      // Re-puntuar con cada titulo: un match debil con un titulo previo no
      // debe congelar la card.
      var base = entry.baseScore;
      for (var t = 0; t <= i; t++) base = Math.max(base, titleScore(titles[t], cand.title));
      entry.baseScore = base;
      var s = base;
      var sNum = site.seasonOfUrl ? site.seasonOfUrl(cand.url) : null;
      for (var q = 0; q <= i; q++) {
        if (isSequelTitle(titles[q], cand.title)) { s = 0; break; }
      }
      if (s > 0.3) {
        if (season != null && season > 1) {
          if (sNum != null && sNum === season) s += 0.25;
          else if (sNum != null) s -= 0.1; // otra temporada distinta
        } else if (sNum == null) {
          s += 0.05; // sin temporada -> ficha base
        }
      }
      entry.score = s;
      if (s > bestScore) { bestScore = s; best = entry; }
    }
    if (bestScore >= 1.0) break; // match exacto, no hace falta buscar mas
    log("titulo \"" + titles[i] + "\": " + cards.length + " cards, mejor hasta ahora " + bestScore.toFixed(2) + (best ? " (" + best.title + ")" : ""));
  }
  if (!best || bestScore < 0.55) {
    log("sin match >= 0.55 (mejor: " + bestScore.toFixed(2) + " " + (best ? best.title : "-") + ")");
    return null;
  }
  // familia de temporadas: "Swallowed Star", "Swallowed Star 2"... (excluye
  // spin-offs con palabras extra despues del numero)
  var normBase = norm(best.title).replace(/\s*\d+$/, "").trim();
  var family = all.filter(function (c) {
    var n = norm(c.title);
    return n === normBase || (n.indexOf(normBase) === 0 && new RegExp("^" + normBase + " \\d+$").test(n));
  });
  family.sort(function (a, b) {
    var na = site.seasonOfUrl ? (site.seasonOfUrl(a.url) || 0) : 0;
    var nb = site.seasonOfUrl ? (site.seasonOfUrl(b.url) || 0) : 0;
    return na - nb;
  });
  best.score = bestScore;
  best.family = family;
  return best;
}

/** Elige el numero de episodio del sitio: global (absoluto TMDB) o por temporada. */
function pickEpisodeNumber(eps, target) {
  var cands = [];
  if (target.absolute != null) cands.push(target.absolute);
  cands.push(target.episode);
  var inMap = cands.filter(function (c) { return eps.map[c]; });
  if (inMap.length === 1) return inMap[0];
  if (inMap.length === 2) {
    // si el max del sitio ~ total absoluto de TMDB, el sitio numera global
    var global = target.totalAbs && Math.abs(target.totalAbs - eps.max) <= 2;
    return global ? target.absolute : target.episode;
  }
  if (target.episode <= eps.max && target.episode >= eps.min) return target.episode;
  if (target.absolute != null && target.absolute <= eps.max && target.absolute >= eps.min) return target.absolute;
  if (eps.max) return eps.max; // ultimo disponible
  return 0;
}

/**
 * TMDB fusiono todas las temporadas en S1 (caso comun en donghua): el sitio
 * las separa en fichas por temporada. Recorre la familia en orden acumulando
 * el maximo de cada ficha y ubica el episodio global E dentro de la ficha que
 * corresponda.
 */
async function resolveMergedSeasons(site, series, globalEpisode) {
  var family = (series && series.family) || [];
  if (family.length < 2) return null;
  var cum = 0;
  for (var i = 0; i < family.length; i++) {
    if (Date.now() - _t0 > BUDGET_MS) { log("presupuesto agotado en temporadas fusionadas"); return null; }
    var eps = await site.episodes(family[i].url);
    if (!eps.max) continue;
    if (globalEpisode > cum && globalEpisode <= cum + eps.max) {
      var ep = globalEpisode - cum;
      var u = eps.map[ep];
      if (!u && site.episodeUrlFor) {
        var slug = family[i].url.replace(/\/+$/, "").split("/").pop();
        var probed = await site.episodeUrlFor(slug, [ep]);
        u = probed ? probed.url : null;
      }
      if (!u) return null;
      log("temporadas fusionadas: " + family[i].title + " -> episodio " + ep + " (TMDB E" + globalEpisode + ")");
      return await site.streams(u);
    }
    cum += eps.max;
  }
  // E supera el total del sitio (TMDB cuenta de mas): emitir el ULTIMO
  // episodio de la ULTIMA ficha de la familia (lo mas nuevo disponible).
  var last = family[family.length - 1];
  var lastEps = await site.episodes(last.url);
  if (lastEps.max) {
    log("E" + globalEpisode + " supera el total del sitio (" + cum + ") -> ultimo episodio de " + last.title);
    return await site.streams(lastEps.map[lastEps.max]);
  }
  return null;
}

// ==================== flujo generico ====================

/**
 * Motor comun de getStreams para todos los sitios.
 * site = {
 *   id, name, base,
 *   aliases: { "<titulo original TMDB>": ["Titulo del sitio", ...] },
 *   search(query) -> [{title,url}],
 *   episodes(seriesUrl) -> {map:{num:url}, min, max},
 *   streams(episodeUrl) -> [{url,title,quality,headers,subtitles}],
 *   seasonOfUrl(url) -> number|null   (opcional)
 *   episodeUrlFor(slug, numbers) -> {url}|null  (opcional)
 *   movieStreams(seriesUrl) -> [stream] (opcional)
 * }
 */
async function runSite(site, tmdbId, mediaType, season, episode) {
  _t0 = Date.now();
  _siteName = site.id;
  try {
    mediaType = String(mediaType || "tv").toLowerCase();
    var id = String(tmdbId || "");
    var pre = /^(tmdb):/i.exec(id);
    id = pre ? id.split(":").pop() : id;
    if (!/^\d+$/.test(id)) { log("id no soportado: " + tmdbId); return []; }
    var isMovie = mediaType.indexOf("movie") === 0;

    var meta = await tmdbMeta(id, isMovie);
    if (!meta) return [];

    if (isMovie) {
      var titlesM = tmdbTitles(meta, null);
      var altsM = await tmdbAltTitles(id, true);
      var seriesM = await findSeries(site, titlesM.concat(altsM).slice(0, 5), null);
      if (!seriesM) return [];
      var epsM = await site.episodes(seriesM.url);
      if (epsM.max) {
        var epUrlM = epsM.map[epsM.min];
        if (epUrlM) return await site.streams(epUrlM);
      }
      return site.movieStreams ? await site.movieStreams(seriesM.url) : [];
    }

    var target = computeEpisode(meta, season, episode);
    var titles = tmdbTitles(meta, target.season);
    var eng = await tmdbEngName(id, false);
    if (eng) titles.push(eng);
    var alias = (site.aliases && site.aliases[meta.original_name]) || [];
    var alts = await tmdbAltTitles(id, false);
    // orden: titulos principales -> ingles -> alias curados -> alts TMDB.
    var uniq = {};
    var allTitles = [];
    titles.concat(alias).concat(alts).forEach(function (n) {
      if (n && !uniq[n]) { uniq[n] = 1; allTitles.push(n); }
    });
    var series = await findSeries(site, allTitles.slice(0, 7), target.season);
    if (!series) return [];
    var slug = series.url.replace(/\/+$/, "").split("/").pop();

    // Temporada unica (sin numero absoluto): la numeracion del sitio es la
    // misma de TMDB -> URL directa, sin descargar la ficha (riesgo 1MB).
    if (target.absolute == null && site.episodeUrlFor) {
      var direct = await site.episodeUrlFor(slug, [target.episode, target.episode - 1]);
      if (direct) {
        log("match: " + series.title + " -> episodio " + target.episode + " (URL directa)");
        return await site.streams(direct.url, direct);
      }
      // TMDB fusiono temporadas en S1 y el sitio las separa en fichas
      var merged = await resolveMergedSeasons(site, series, target.episode);
      if (merged && merged.length) return merged;
    }

    // Multi-temporada o probe fallido: grid de la ficha (autoritativo para
    // distinguir numeracion global vs por temporada) con rescate por probe.
    var eps = await site.episodes(series.url);
    if (!eps.max) return site.movieStreams ? await site.movieStreams(series.url) : [];

    var epNum = pickEpisodeNumber(eps, target);
    var epUrl = eps.map[epNum];
    if (!epUrl && site.episodeUrlFor) {
      var rescue = await site.episodeUrlFor(slug, [target.episode, target.absolute]);
      if (rescue) {
        log("grid sin episodio " + epNum + " -> rescate por URL directa");
        return await site.streams(rescue.url, rescue);
      }
    }
    if (!epUrl) {
      log("episodio " + epNum + " no encontrado en " + series.title);
      return [];
    }
    log("match: " + series.title + " (" + series.url + ") score " + series.score.toFixed(2) + " -> episodio " + epNum + " (TMDB S" + target.season + "E" + target.episode + ")");
    return await site.streams(epUrl);
  } catch (e) {
    log("getStreams error: " + (e && e.message));
    return [];
  }
}

/**
 * TioDonghua (https://tiodonghua.lat) - plugin Nuvio TV.
 *
 * Port del provider CloudStream TioDonghuaProvider (repo donghua-ext).
 * El sitio es un Next.js con SSR; el API Laravel (tioplayer.cloudlatino.com)
 * queda de RESPALDO. Solo interesan BUSQUEDA, LISTADO y PLAYER.
 *
 *  - Buscador: GET /explorar?q=<query> -> a[href^=/donghua/] con <h3> titulo.
 *    Respaldo: API /api/v1/donghuas?q=.
 *
 *  - Ficha: GET /donghua/<slug> -> a[href^=/ver/<id>] con span "Capitulo N".
 *    La numeracion es GLOBAL (p.ej. Swallowed Star 241-249). El boton hero
 *    "Empezar a Ver (Ep 1)" no trae "Capitulo" y se descarta. Respaldo: API
 *    /api/v1/donghuas/<slug> (seasons[].episodes[]).
 *    LIMITACION del sitio: cada ficha solo publica los episodios cargados en
 *    el backend (Swallowed Star entrega 241-249 de 249); no hay paginacion.
 *
 *  - Episodio: GET /ver/<id>. Los servidores NO estan en el DOM: viajan en el
 *    vuelo de Next (self.__next_f.push) como "episode":{... "sources":[{server:
 *    {name}, embed_url}], "downloads":[...]}. Se parsea el vuelo y se resuelve
 *    cada embed:
 *      Byse (byselapuix.com/e/CODE)  -> API /api/videos/CODE + AES-256-GCM
 *      VIDARA (vidara.to/e/CODE)     -> POST /api/stream {filecode,device}
 *      VidHide (morencius.com/embed) -> HTML empaquetado (Dean Edwards)
 *      VOE / Dailymotion / Rumble / OkRu -> extractores del core
 *    El API /api/v1/episodes/<id> queda de respaldo si el vuelo no trae sources.
 */

var BASE = "https://tiodonghua.lat";
// El sitio cataloga Soul Land (Douluo Dalu) con su titulo ingles alternativo
// "Combat Continent"; TMDB solo aporta "Soul Land"/pinyin, que no matchean.
var ALIASES = {
  "\u6597\u7f57\u5927\u9646": ["Combat Continent", "Combat Continent 2"]
};
var TD_API = "https://tioplayer.cloudlatino.com/api/v1";
var TD_ORIGIN = "https://tiodonghua.lat";
var TD_REFERER = "https://tiodonghua.lat/";

function R(u) { return absUrl(BASE, u); }

// ==================== AES-256-GCM en JS puro ====================
// QuickJS no expone WebCrypto y el CryptoJS global no incluye GCM. AES (solo
// cifrado de bloque para el keystream CTR) + GCM sin verificar tag (el JSON se
// valida al parsear). Verificado contra Node crypto: coincide byte a byte.

function aesRotl8(x, n) { return ((x << n) | (x >>> (8 - n))) & 0xff; }

function aesBuildSbox() {
  var s = new Uint8Array(256), p = 1, q = 1;
  do {
    p = (p ^ (p << 1) ^ ((p & 0x80) ? 0x11b : 0)) & 0xff;
    q = (q ^ (q << 1)) & 0xff;
    q = (q ^ (q << 2)) & 0xff;
    q = (q ^ (q << 4)) & 0xff;
    if (q & 0x80) q ^= 0x09;
    var x = q ^ aesRotl8(q, 1) ^ aesRotl8(q, 2) ^ aesRotl8(q, 3) ^ aesRotl8(q, 4);
    s[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  s[0] = 0x63;
  return s;
}
var AES_SBOX = aesBuildSbox();

function aesXtime(a) { a <<= 1; if (a & 0x100) a ^= 0x11b; return a & 0xff; }

function aesExpandKey(key) {
  var Nk = key.length / 4, Nr = Nk + 6, w = [], i, j;
  for (i = 0; i < Nk; i++) w[i] = [key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]];
  var rcon = 1;
  for (i = Nk; i < 4 * (Nr + 1); i++) {
    var t = w[i - 1].slice();
    if (i % Nk === 0) {
      t = [t[1], t[2], t[3], t[0]];
      for (j = 0; j < 4; j++) t[j] = AES_SBOX[t[j]];
      t[0] ^= rcon; rcon = aesXtime(rcon);
    } else if (Nk > 6 && i % Nk === 4) {
      for (j = 0; j < 4; j++) t[j] = AES_SBOX[t[j]];
    }
    var prev = w[i - Nk];
    w[i] = [prev[0] ^ t[0], prev[1] ^ t[1], prev[2] ^ t[2], prev[3] ^ t[3]];
  }
  return { w: w, Nr: Nr };
}

function aesEncryptBlock(ks, input) {
  var w = ks.w, Nr = ks.Nr, s = new Uint8Array(16), i, r, c, rr;
  for (i = 0; i < 16; i++) s[i] = input[i] ^ w[i >> 2][i & 3];
  for (r = 1; r <= Nr; r++) {
    for (i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
    var t = new Uint8Array(16);
    for (c = 0; c < 4; c++) for (rr = 0; rr < 4; rr++) t[rr + 4 * c] = s[rr + 4 * ((c + rr) % 4)];
    s = t;
    if (r !== Nr) {
      for (c = 0; c < 4; c++) {
        var a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
        s[4 * c] = aesXtime(a0) ^ (aesXtime(a1) ^ a1) ^ a2 ^ a3;
        s[4 * c + 1] = a0 ^ aesXtime(a1) ^ (aesXtime(a2) ^ a2) ^ a3;
        s[4 * c + 2] = a0 ^ a1 ^ aesXtime(a2) ^ (aesXtime(a3) ^ a3);
        s[4 * c + 3] = (aesXtime(a0) ^ a0) ^ a1 ^ a2 ^ aesXtime(a3);
      }
    }
    for (i = 0; i < 16; i++) s[i] ^= w[r * 4 + (i >> 2)][i & 3];
  }
  return s;
}

function aesGcmDecrypt(key, iv, payload) {
  var body = payload.subarray(0, payload.length - 16);
  var ks = aesExpandKey(key);
  var counter = new Uint8Array(16);
  for (var i = 0; i < iv.length && i < 12; i++) counter[i] = iv[i];
  counter[15] = 1; // J0
  var out = new Uint8Array(body.length), block = 0;
  for (var off = 0; off < body.length; off += 16) {
    block++;
    var n = block + 1; // primer bloque de datos = J0 + 1
    for (var b = 15; b >= 12; b--) { counter[b] = n & 0xff; n >>>= 8; }
    var ksb = aesEncryptBlock(ks, counter);
    for (var j = 0; j < 16 && off + j < body.length; j++) out[off + j] = body[off + j] ^ ksb[j];
  }
  return out;
}

function b64UrlBytes(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  var bin = atob(s), arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function bytesToStr(bytes) {
  var s = "";
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function byseDecryptPlayback(pb) {
  if (!pb || !pb.key_parts || !pb.iv || !pb.payload) return null;
  var ver = parseInt(pb.version, 10);
  if (!ver) { var vm = /\d+/.exec(String(pb.version || "")); ver = vm ? parseInt(vm[0], 10) : 0; }
  var parts = pb.key_parts, sel = [], idxs = [ver, 31 - ver];
  for (var i = 0; i < idxs.length; i++) {
    var idx = idxs[i];
    if (idx >= 1 && idx <= parts.length && parts[idx - 1]) sel.push(parts[idx - 1]);
  }
  if (!sel.length) sel = parts;
  var keyLen = 0, bufs = [];
  for (i = 0; i < sel.length; i++) { var b = b64UrlBytes(sel[i]); bufs.push(b); keyLen += b.length; }
  if (keyLen !== 16 && keyLen !== 24 && keyLen !== 32) return null;
  var key = new Uint8Array(keyLen), pos = 0;
  for (i = 0; i < bufs.length; i++) { key.set(bufs[i], pos); pos += bufs[i].length; }
  var iv = b64UrlBytes(pb.iv), payload = b64UrlBytes(pb.payload);
  if (payload.length <= 16) return null;
  var plain = aesGcmDecrypt(key, iv, payload);
  try { return JSON.parse(bytesToStr(plain)); } catch (e) { log("byse: playback ilegible"); return null; }
}

/** Embed Byse (byselapuix.com u otro mirror) -> streams HLS. Host generico. */
async function extractByse(embedUrl, out) {
  var m = /^(https?:\/\/[^/]+)\/[ev]\/([a-zA-Z0-9]+)/.exec(embedUrl);
  if (!m) return false;
  var host = m[1], code = m[2];
  var txt = await fetchText(host + "/api/videos/" + code, {
    referer: TD_REFERER,
    headers: {
      "Accept": "application/json",
      "Origin": TD_ORIGIN,
      "X-Embed-Origin": TD_ORIGIN,
      "X-Embed-Referer": TD_REFERER,
      "X-Embed-Parent": TD_REFERER
    }
  });
  if (!txt || txt.indexOf('"playback"') < 0) return false;
  var j;
  try { j = JSON.parse(txt); } catch (e) { return false; }
  var dec = byseDecryptPlayback(j.playback);
  if (!dec || !dec.sources) return false;
  var playerRef = host + "/";
  var found = false;
  for (var i = 0; i < dec.sources.length; i++) {
    var src = dec.sources[i], url = String(src.url || "").trim();
    if (!url || url.indexOf("http") !== 0) continue;
    var isHls = /mpegurl/i.test(src.mime_type || "") || url.indexOf(".m3u8") >= 0;
    if (isHls) {
      if (await tryPlaylist(url, out, "Byse", playerRef)) found = true;
    } else {
      pushStream(out, url, qualityFromHeight(src.height) || "Auto", "Byse", playerRef);
      found = true;
    }
  }
  return found;
}

// ==================== desempaquetador Dean Edwards ====================

function b62val(w, a) {
  var n = 0;
  for (var i = 0; i < w.length; i++) {
    var ch = w.charCodeAt(i), d;
    if (ch >= 48 && ch <= 57) d = ch - 48;
    else if (ch >= 97 && ch <= 122) d = ch - 97 + 10;
    else if (ch >= 65 && ch <= 90) d = ch - 65 + 36;
    else return -1;
    if (d >= a) return -1;
    n = n * a + d;
  }
  return n;
}

function unpackPacked(line) {
  var m = /\}\('([\s\S]*)',(\d+),(\d+),'([\s\S]*)'\.split\('\|'\)/.exec(line);
  if (!m) return "";
  var p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  var a = parseInt(m[2], 10), k = m[4].split("|");
  return p.replace(/\b\w+\b/g, function (w) {
    var idx = b62val(w, a);
    if (idx < 0) return w;
    return (idx < k.length && k[idx]) ? k[idx] : w;
  });
}

function unpackAll(html) {
  var out = "", m, re = /eval\(function\(p,a,c,k,e,[^\r\n]+/g;
  while ((m = re.exec(html))) { var u = unpackPacked(m[0]); if (u) out += "\n" + u; }
  return out;
}

async function extractFromText(text, referer, out, server) {
  var m3u8 = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/.exec(text);
  if (m3u8) return await tryPlaylist(m3u8[0].replace(/\\\//g, "/"), out, server, referer);
  var re = /https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/g, m;
  while ((m = re.exec(text))) {
    var u = m[0].replace(/\\\//g, "/");
    if (isJunkVideoUrl(u)) continue;
    pushStream(out, u, "Auto", server, referer);
    return true;
  }
  return false;
}

// ==================== vuelo de Next ====================

/** Concatena los self.__next_f.push([1,"..."]) y desescapa el JSON. */
function tdFlight(html) {
  if (html.indexOf("__next_f") < 0) return "";
  var open = 'self.__next_f.push([1,"', close = '"])', sb = [], idx = 0;
  while (true) {
    var s = html.indexOf(open, idx);
    if (s < 0) break;
    var start = s + open.length, j = start, esc = false;
    while (j < html.length) {
      var ch = html.charAt(j);
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"' && html.substr(j, close.length) === close) break;
      j++;
    }
    sb.push(html.substring(start, Math.min(j, html.length)));
    idx = j + close.length;
  }
  return sb.join("\n").replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\n/g, "\n").replace(/\\u0026/g, "&");
}

/** Subcadena JSON balanceada (objeto o array) tras la primera clave dada. */
function jsonBlock(text, key, openCh, closeCh) {
  var i = text.indexOf('"' + key + '"');
  if (i < 0) return null;
  var s = text.indexOf(openCh, i);
  if (s < 0) return null;
  var depth = 0, inStr = false, esc = false;
  for (var k = s; k < text.length; k++) {
    var ch = text.charAt(k);
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === openCh) depth++;
      else if (ch === closeCh) { depth--; if (depth === 0) return text.substring(s, k + 1); }
    }
  }
  return null;
}

function parseJsonBlock(text, key, openCh, closeCh) {
  var b = jsonBlock(text, key, openCh, closeCh);
  if (!b) return null;
  try { return JSON.parse(b); } catch (e) { return null; }
}

// ==================== busqueda ====================

function cleanTitle(t) {
  return String(t || "").replace(/\s*Sub\s*Espa[nñ]ol\s*$/i, "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

async function searchSite(query) {
  var out = [], seen = {};
  var html = await fetchText(BASE + "/explorar?q=" + encodeURIComponent(query));
  if (html) {
    var $ = cheerio.load(html);
    $("a[href^='/donghua/']").each(function (i, el) {
      var href = el.attr("href") || "";
      var slug = href.split("/donghua/")[1];
      if (!slug) return;
      slug = slug.split("?")[0].replace(/\/+$/, "");
      var title = cleanTitle(el.find("h3").text() || el.find("img").attr("alt") || "");
      if (!title || !slug) return;
      var u = BASE + "/donghua/" + slug;
      if (seen[u]) return;
      seen[u] = 1;
      out.push({ title: title, url: u });
    });
  }
  if (!out.length) out = await searchApi(query);
  return out;
}

/** Respaldo del buscador con el API Laravel. */
async function searchApi(query) {
  var out = [], seen = {};
  var txt = await fetchText(TD_API + "/donghuas?q=" + encodeURIComponent(query), { headers: { "Accept": "application/json" } });
  var j;
  try { j = JSON.parse(txt); } catch (e) { return out; }
  var list = (j && j.data) || [];
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a || !a.slug || !a.title) continue;
    var u = BASE + "/donghua/" + a.slug;
    if (seen[u]) continue;
    seen[u] = 1;
    out.push({ title: cleanTitle(a.title), url: u });
  }
  return out;
}

// ==================== episodios ====================

async function seriesEpisodes(seriesUrl) {
  var map = {};
  var html = await fetchText(seriesUrl);
  if (html) {
    var $ = cheerio.load(html);
    $("a[href^='/ver/']").each(function (i, el) {
      var href = el.attr("href") || "";
      if (!/\/ver\/\d+/.test(href)) return;
      var cm = /Cap[íi]tulo\s*(\d+)/i.exec(el.text());
      if (!cm) return; // boton hero "Empezar a Ver" sin numero
      var n = parseInt(cm[1], 10);
      if (n && !map[n]) map[n] = R(href);
    });
  }
  if (!Object.keys(map).length) {
    var slug = String(seriesUrl).replace(/\/+$/, "").split("/donghua/")[1] || "";
    map = await episodesApi(slug);
  }
  var all = Object.keys(map).map(Number);
  return {
    map: map,
    min: all.length ? Math.min.apply(null, all) : 0,
    max: all.length ? Math.max.apply(null, all) : 0
  };
}

/** Respaldo de episodios con el API: seasons[].episodes[] {id, episode_number}. */
async function episodesApi(slug) {
  var map = {};
  if (!slug) return map;
  var txt = await fetchText(TD_API + "/donghuas/" + slug, { headers: { "Accept": "application/json" } });
  var j;
  try { j = JSON.parse(txt); } catch (e) { return map; }
  var data = (j && j.data) || {};
  var seasons = data.seasons || [];
  for (var i = 0; i < seasons.length; i++) {
    var eps = seasons[i].episodes || [];
    for (var k = 0; k < eps.length; k++) {
      var e = eps[k];
      var n = parseInt(e.episode_number, 10);
      if (n && e.id != null && !map[n]) map[n] = BASE + "/ver/" + e.id;
    }
  }
  return map;
}

// ==================== player ====================

/** Normaliza URLs cortas de descarga al formato canonico del embed. */
function normalizeEmbed(raw) {
  var t = decodeEntities(String(raw || "").replace(/\\\//g, "/")).trim();
  if (t.indexOf("http") !== 0) return "";
  var end = t.search(/["\s]/);
  var url = (end === -1 ? t : t.substring(0, end)).trim();
  if (url.indexOf("dailymotion.com/d/video/") >= 0) url = url.replace("/d/video/", "/embed/video/");
  if (/rumble\.com\/d\/v[a-zA-Z0-9]+/.test(url)) url = url.replace("/d/", "/embed/");
  return url;
}

function serverLabel(url) {
  var m = /^(?:https?:)?\/\/([^/?#]+)/i.exec(String(url || ""));
  var host = m ? m[1].replace(/^www\./, "").split(":")[0] : "";
  if (!host) return "Servidor";
  var first = host.split(".")[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function tdPriority(u) {
  u = String(u || "").toLowerCase();
  if (u.indexOf("byselapuix") >= 0 || u.indexOf("byse") >= 0) return 10;
  if (u.indexOf("rumble.com") >= 0) return 9;
  if (u.indexOf("dailymotion") >= 0 || u.indexOf("dai.ly") >= 0) return 8;
  if (u.indexOf("ok.ru") >= 0 || u.indexOf("odnoklassniki") >= 0) return 7;
  if (u.indexOf("vidara") >= 0) return 6;
  if (u.indexOf("morencius") >= 0 || u.indexOf("vidhide") >= 0) return 5;
  if (u.indexOf("voe.") >= 0) return 3;
  return 1;
}

/** VIDARA: POST <host>/api/stream {filecode, device:"web"} -> streaming_url. */
async function extractVidara(embedUrl, out) {
  var m = /^(https?:\/\/[^/]+)\/e\/([a-zA-Z0-9]+)/.exec(embedUrl);
  if (!m) return false;
  var host = m[1], code = m[2];
  var txt = await fetchText(host + "/api/stream", {
    referer: embedUrl,
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ filecode: code, device: "web" })
  });
  var j;
  try { j = JSON.parse(txt); } catch (e) { return false; }
  var stream = String(j.streaming_url || "");
  if (stream.indexOf("http") !== 0) return false;
  var found = false;
  if (stream.indexOf(".m3u8") >= 0) found = await tryPlaylist(stream, out, "VIDARA", embedUrl);
  if (!found) { pushStream(out, stream, "Auto", "VIDARA", embedUrl); found = true; }
  var subs = j.subtitles || [];
  for (var i = 0; i < subs.length; i++) {
    var f = String(subs[i].file || "");
    if (f.indexOf("http") === 0 && !out.subs[f]) {
      out.subs[f] = 1;
      out.subtitles.push({ url: f, language: "es", name: subs[i].label || "Subtitulos" });
    }
  }
  return found;
}

/** VidHide/morencius y similares: HTML empaquetado -> m3u8/mp4. */
async function extractPackedHost(embedUrl, out, name) {
  var html = await fetchText(embedUrl, { referer: TD_REFERER });
  if (!html) return false;
  if (await extractFromText(html, embedUrl, out, name)) return true;
  var unpacked = unpackAll(html);
  if (unpacked && await extractFromText(unpacked, embedUrl, out, name)) return true;
  return false;
}

/** Resuelve un embed de servidor segun su host. */
async function processTdEmbed(embedUrl, name, out) {
  var u = String(embedUrl || "");
  var n = String(name || "").toLowerCase();
  if (n.indexOf("byse") >= 0 || u.indexOf("byselapuix") >= 0 || /byse[a-z0-9]*\.[a-z]+\/[ev]\//.test(u)) {
    return await extractByse(u, out);
  }
  if (n.indexOf("vidara") >= 0 || u.indexOf("vidara") >= 0) {
    return await extractVidara(u, out);
  }
  if (n.indexOf("vidhide") >= 0 || u.indexOf("morencius") >= 0 || u.indexOf("vidhide") >= 0) {
    return await extractPackedHost(u, out, name);
  }
  if (u.indexOf("voe.") >= 0) return await extractVoe(u, TD_REFERER, out);
  return await routeEmbed(u, TD_REFERER, name, out);
}

/** Recoge sources del vuelo (o del API) y los resuelve por prioridad. */
async function streamsFromEpisode(html, epUrl, epId) {
  var out = newEmit();
  var start = (typeof _t0 === "number" && _t0 > 0) ? _t0 : Date.now();
  var flight = tdFlight(html);
  var sources = parseJsonBlock(flight, "sources", "[", "]") || [];
  var downloads = parseJsonBlock(flight, "downloads", "[", "]") || [];
  if (!sources.length && epId) {
    var txt = await fetchText(TD_API + "/episodes/" + epId, { headers: { "Accept": "application/json" } });
    var j;
    try { j = JSON.parse(txt); } catch (e) { j = null; }
    var data = (j && j.data) || j || {};
    sources = data.sources || [];
    downloads = data.downloads || [];
  }
  var servers = [], seen = {};
  function add(list, isDownload) {
    for (var i = 0; i < list.length; i++) {
      var s = list[i] || {};
      var raw = isDownload ? s.url : s.embed_url;
      var embed = normalizeEmbed(raw);
      if (!embed || seen[embed]) continue;
      if (embed.indexOf("/drive/folders/") >= 0 || embed.indexOf("playerp2p") >= 0) continue;
      seen[embed] = 1;
      var name = (s.server && s.server.name) || s.name || serverLabel(embed);
      servers.push({ url: embed, name: name });
    }
  }
  add(sources, false);
  servers.sort(function (a, b) { return tdPriority(b.url) - tdPriority(a.url); });
  for (var i = 0; i < servers.length; i++) {
    if (out.streams.length >= 3) break;
    if (Date.now() - start > BUDGET_MS) { log("presupuesto agotado en servidores"); break; }
    var sv = servers[i];
    try {
      if (await processTdEmbed(sv.url, sv.name, out)) {
        // Byse es el mas fiable (1080p HLS): si responde, no gastar en el resto.
        if (tdPriority(sv.url) >= 10) break;
      }
    } catch (e) { log("servidor fallo (" + sv.name + "): " + (e && e.message)); }
  }
  // Respaldo: descargas sueltas si no salio nada.
  if (!out.streams.length) {
    add(downloads, true);
    for (var d = 0; d < servers.length; d++) {
      if (out.streams.length >= 3 || Date.now() - start > BUDGET_MS) break;
      try { await processTdEmbed(servers[d].url, servers[d].name, out); } catch (e) {}
    }
  }
  // Respaldo final: iframes / m3u8 en la propia pagina.
  if (!out.streams.length && html) {
    var m3u8 = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/.exec(html);
    if (m3u8) await tryPlaylist(m3u8[0], out, "Servidor", epUrl);
  }
  return finishEmit(out);
}

async function episodeStreams(episodeUrl) {
  var m = /\/ver\/(\d+)/.exec(episodeUrl);
  var epId = m ? m[1] : null;
  var epUrl = epId ? BASE + "/ver/" + epId : episodeUrl;
  var html = await fetchText(epUrl);
  if (!html && !epId) return [];
  return await streamsFromEpisode(html || "", epUrl, epId);
}

var SITE = {
  id: "tiodonghua",
  name: "TioDonghua",
  base: BASE,
  aliases: ALIASES,
  search: searchSite,
  episodes: seriesEpisodes,
  streams: episodeStreams,
  seasonOfUrl: null,
  episodeUrlFor: null,
  movieStreams: null
};

async function getStreams(tmdbId, mediaType, season, episode) {
  return await runSite(SITE, tmdbId, mediaType, season, episode);
}

module.exports = {
  name: SITE.name,
  getStreams: getStreams,
  _internals: {
    site: SITE,
    searchSite: searchSite,
    findSeries: function (t, s) { return findSeries(SITE, t, s); },
    seriesEpisodes: seriesEpisodes,
    episodeStreams: episodeStreams,
    tdFlight: tdFlight,
    extractByse: extractByse,
    extractVidara: extractVidara,
    byseDecryptPlayback: byseDecryptPlayback
  }
};