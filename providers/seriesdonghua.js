/**
 * SeriesDonghua — plugin Nuvio TV (repo nuvio-donghua).
 * Archivo GENERADO por tools/build.mjs: no editar a mano.
 * Fuentes: src/core.js + src/sites/seriesdonghua.js
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
 * Serie: seriesdonghua.com (sitio propio Laravel).
 * Port del provider CloudStream SeriesDonghuaProvider.kt (donghua-ext) y del
 * primer plugin JS del repo (v1.0.0).
 *
 *  - Buscador real: /buscar.php?s=<query>
 *  - Ficha /<slug>/: grid article.episode-card-item (data-ep)
 *  - Episodio /<slug>-episodio-N/: botones button.server-tab-btn
 *    (data-video-id + data-server-index); embed via POST /api/player/get-server
 *    {video_id, server_index} + X-CSRF-TOKEN (meta csrf-token) + cookies del GET
 *    (Laravel rechaza el POST sin sesion).
 *  - Servidores: Dailymotion (metadata API: HLS + pistas de subs es), OK.ru,
 *    Rumble, VOE.
 */

var BASE = "https://seriesdonghua.com";

/** Alias conocidos: titulos del sitio que ni TMDB es-ES ni sus alts traen. */
var ALIASES = {
  "\u6597\u7f57\u5927\u9646": ["Combat Continent", "Soul Land"],
  "\u541e\u566c\u661f\u7a7a": ["Swallowed Star"],
  "\u5996\u795e\u8bb0": ["Tales of Demons and Gods"],
  "\u9006\u5929\u81f3\u5c0a": ["Against The Sky Supreme"]
};

function R(u) { return absUrl(BASE, u); }

function parseCards(html) {
  var cards = [];
  var $ = cheerio.load(html);
  $("article.donghua-card").each(function (i, el) {
    var card = $(el);
    var a = card.find("a[href]").first();
    var href = a.attr("href");
    if (!href) return;
    var tEl = card.find("h3.card-title").first();
    var title = tEl.text().trim();
    if (!title) {
      title = (card.find("img").first().attr("alt") || "")
        .replace(/\s*Episodio\s*\d+.*$/i, "")
        .replace(/^\s*Donghua\s+/i, "").replace(/\s*Sub\s*Espa\u00f1ol\s*$/i, "").trim();
    }
    if (!title) return;
    cards.push({ title: title, url: R(href), isEpisode: href.indexOf("-episodio-") >= 0 });
  });
  return cards;
}

async function searchSite(query) {
  var html = await fetchText(BASE + "/buscar.php?s=" + encodeURIComponent(query));
  if (!html) return [];
  return parseCards(html).filter(function (c) { return !c.isEpisode; });
}

/** Numero de temporada deducido del slug ("-3" al final). */
function seasonOfUrl(url) {
  var slug = String(url || "").replace(/\/+$/, "").split("/").pop();
  var m = /-(\d+)$/.exec(slug);
  return m ? parseInt(m[1], 10) : null;
}

/** Grid de episodios de la ficha: {map: {num: url}, max, min}. */
async function seriesEpisodes(seriesUrl) {
  var html = await fetchText(seriesUrl);
  var map = {};
  if (html) {
    var $ = cheerio.load(html);
    $("article.episode-card-item").each(function (i, el) {
      var card = $(el);
      var a = card.find('a[href*="-episodio-"]').first();
      var href = a.attr("href");
      if (!href) return;
      var num = parseInt(card.attr("data-ep"), 10);
      if (isNaN(num)) {
        var m = /-episodio-(\d+)/.exec(href);
        num = m ? parseInt(m[1], 10) : NaN;
      }
      if (!isNaN(num)) map[num] = R(href);
    });
    if (!Object.keys(map).length) {
      // respaldo: cualquier link de episodio en la ficha
      var re = /href="(\/[a-z0-9-]+-episodio-\d+\/)"/g, m2;
      while ((m2 = re.exec(html))) {
        var n = parseInt(/-episodio-(\d+)/.exec(m2[1])[1], 10);
        if (!map[n]) map[n] = BASE + m2[1];
      }
    }
  }
  var nums = Object.keys(map).map(Number);
  return { map: map, min: nums.length ? Math.min.apply(null, nums) : 0, max: nums.length ? Math.max.apply(null, nums) : 0 };
}

/**
 * Probe de URL directa /{slug}-episodio-{N}/ (patron predecible del sitio).
 * Evita descargar la ficha completa (las series largas rozan el cap de 1MB
 * de fetch de Nuvio). Devuelve {url, res, html} con el body ya consumido.
 */
async function probeEpisodeUrl(slug, numbers) {
  var seen = {};
  for (var i = 0; i < numbers.length; i++) {
    var n = numbers[i];
    if (!n || seen[n]) continue;
    seen[n] = 1;
    var u = BASE + "/" + slug + "-episodio-" + n + "/";
    try {
      var res = await fetch(u, { headers: baseHeaders() });
      if (res.status !== 200) continue;
      var html = await res.text();
      if (html.indexOf("server-tab-btn") >= 0) return { url: u, res: res, html: html };
    } catch (e) {}
  }
  return null;
}

/** Botones server-tab-btn (atributos separados por saltos de linea). */
function parseServerButtons(html) {
  var btns = [];
  var re = /<button\b[^>]*>/gi, m;
  while ((m = re.exec(html))) {
    var tag = m[0];
    if (tag.indexOf("server-tab-btn") < 0) continue;
    var vid = /data-video-id\s*=\s*"(\d+)"/.exec(tag);
    var idx = /data-server-index\s*=\s*"(\d+)"/.exec(tag);
    if (!vid || !idx) continue;
    var window = html.slice(re.lastIndex, re.lastIndex + 600);
    var sm = /<span>([^<]+)<\/span>/.exec(window);
    btns.push({
      videoId: vid[1],
      serverIndex: idx[1],
      name: sm ? sm[1].trim().replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : "Servidor"
    });
  }
  return btns;
}

async function resolveEmbed(episodeUrl, csrf, cookie, videoId, serverIndex) {
  try {
    var res = await fetch(BASE + "/api/player/get-server", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "X-CSRF-TOKEN": csrf,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookie || "",
        "Referer": episodeUrl
      },
      body: "video_id=" + encodeURIComponent(videoId) + "&server_index=" + encodeURIComponent(serverIndex)
    });
    var txt = await res.text();
    var m = /"embed_url"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(txt);
    return m ? unescJson(m[1]) : null;
  } catch (e) {
    return null;
  }
}

/** Extrae los streams de una pagina de episodio. */
async function episodeStreams(episodeUrl, preloaded) {
  var out = newEmit();
  var res, html;
  if (preloaded && preloaded.res && preloaded.html) {
    res = preloaded.res;
    html = preloaded.html;
  } else {
    res = await fetch(episodeUrl, { headers: baseHeaders() });
    html = await res.text();
  }
  var cookie = readCookies(res);
  var csrf = (/csrf-token"\s+content="([^"]+)"/.exec(html) || [])[1] || "";
  var btns = parseServerButtons(html);
  var start = Date.now();

  for (var i = 0; i < btns.length; i++) {
    if (Date.now() - start > BUDGET_MS) { log("presupuesto agotado, corte en servidor " + i); break; }
    var b = btns[i];
    var embed = await resolveEmbed(episodeUrl, csrf, cookie, b.videoId, b.serverIndex);
    if (!embed) {
      // reintento replantando la sesion (el 419 de Laravel trae cuerpo no vacio)
      var pg = await fetch(episodeUrl, { headers: baseHeaders() });
      await pg.text();
      var ck = readCookies(pg);
      if (ck) cookie = ck;
      embed = await resolveEmbed(episodeUrl, csrf, cookie, b.videoId, b.serverIndex);
      if (!embed) continue;
    }
    try { await routeEmbed(embed, episodeUrl, b.name, out); } catch (e) { log("embed fallo: " + (e && e.message)); }
  }

  if (!out.streams.length) await extractEmbedsFromHtml(html, episodeUrl, out, "Servidor");

  return finishEmit(out);
}

/** Ficha sin grid de episodios -> pelicula: resolver la pagina de video real. */
async function movieStreams(seriesUrl) {
  var html = await fetchText(seriesUrl);
  if (!html) return [];
  var candidates = [];
  var b1 = /<a[^>]*href="([^"]+)"[^>]*class="btn-stream[^"]*"/.exec(html);
  var b2 = /<a[^>]*class="btn-stream[^"]*"[^>]*href="([^"]+)"/.exec(html);
  if (b1) candidates.push(b1[1]);
  if (b2) candidates.push(b2[1]);
  candidates.push("/" + seriesUrl.replace(/\/$/, "").split("/").pop() + "-1/");
  for (var i = 0; i < candidates.length; i++) {
    var pageUrl = R(candidates[i]);
    var probe = await fetchText(pageUrl);
    if (probe && probe.indexOf("server-tab-btn") >= 0) return await episodeStreams(pageUrl);
  }
  if (html.indexOf("server-tab-btn") >= 0) return await episodeStreams(seriesUrl);
  return [];
}

var SITE = {
  id: "seriesdonghua",
  name: "SeriesDonghua",
  base: BASE,
  aliases: ALIASES,
  search: searchSite,
  episodes: seriesEpisodes,
  streams: episodeStreams,
  movieStreams: movieStreams,
  seasonOfUrl: seasonOfUrl,
  episodeUrlFor: probeEpisodeUrl
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
    findSeries: function (titles, season) { return findSeries(SITE, titles, season); },
    seriesEpisodes: seriesEpisodes,
    pickEpisodeNumber: pickEpisodeNumber,
    computeEpisode: computeEpisode,
    episodeStreams: episodeStreams,
    movieStreams: movieStreams,
    parseServerButtons: parseServerButtons,
    resolveEmbed: resolveEmbed,
    probeEpisodeUrl: probeEpisodeUrl,
    resolveMergedSeasons: function (series, ep) { return resolveMergedSeasons(SITE, series, ep); },
    tmdbEngName: tmdbEngName,
    routeEmbed: routeEmbed,
    extractDailymotion: extractDailymotion,
    extractOkRu: extractOkRu,
    extractRumble: extractRumble,
    extractVoe: extractVoe,
    extractGeneric: extractGeneric,
    readCookies: readCookies
  }
};
