/**
 * DonghuaWorld — plugin Nuvio TV (repo nuvio-donghua).
 * Archivo GENERADO por tools/build.mjs: no editar a mano.
 * Fuentes: src/core.js + src/sites/donghuaworld.js
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
 * DonghuaWorld (https://donghuaworld.com) - plugin Nuvio TV.
 *
 * Port del provider CloudStream DonghuaWorldProvider (repo donghua-ext).
 * Solo interesan BUSQUEDA, LISTADO de episodios y PLAYER (el Kotlin ademas
 * cachea paginas/ratings y puentea imagenes por WebView: nada de eso aqui).
 *
 *  - Buscador: GET /?s=<texto> (WordPress). Cards <article> con a[href] a la
 *    ficha /anime/<slug>/; titulo en a[title] o h2.
 *
 *  - Ficha: grid .eplister li a (URLs ...-episode-<N>...). OJO: el sitio solo
 *    conserva los ~100 episodios mas recientes (el boton "First Episode"
 *    apunta a "#"); para episodios fuera del grid se prueban las plantillas
 *    de URL derivadas del propio grid (episodeUrlFor).
 *
 *  - Episodio: botones a[data-hash] con el iframe en base64. Dos servidores:
 *      a) "Dark Server": iframe a playi.donghuaworld.com/<id> (antes
 *         player.donghuaplanet.com). El player actual consulta un relay JSON:
 *           GET https://playing.donghuaworld.com/?json=1&id=<id>
 *         con cabecera Origin (sin ella devuelve 403 "forbidden").
 *         Respuesta: { ok, data: { ua: { hls, tar, mp4, ... }, u, cc } }.
 *         ua.hls.auto.url = master HLS (rumble.com/hls-vod/...),
 *         ua.tar.<altura>.url = HLS por calidad (contenedor .tar?r_file=
 *         chunklist.m3u8), ua.cc.<lang> = subtitulos .vtt (Spanish/English).
 *         Se ignoran ua.timeline (thumbnails) y ua.audio (solo audio).
 *         Fallbacks: sources/tracks inline en el HTML del player (formato
 *         antiguo de player.donghuaplanet.com) y embed de Rumble con el id.
 *      b) "DM Player" / "Eng-Sub": iframe de Dailymotion -> extractor del core.
 *    Sin botones: iframe renderizado en #pembed.
 */

var BASE = "https://donghuaworld.com";
var PLAYER_BASE = "https://player.donghuaplanet.com";
var RELAY_BASE = "https://playing.donghuaworld.com";

/** Alias: titulo original de TMDB -> titulo con el que lo publica el sitio. */
var ALIASES = {
  "\u6597\u7f57\u5927\u9646": ["Soul Land", "Combat Continent"],
  "\u541e\u566c\u661f\u7a7a": ["Swallowed Star"],
  "\u5996\u795e\u8bb0": ["Tales of Demons and Gods"],
  "\u9006\u5929\u81f3\u5c0a": ["Against The Sky Supreme"]
};

function R(u) { return absUrl(BASE, u); }

/** Cache de fichas ya descargadas (episodes + episodeUrlFor comparten pagina). */
var _pageCache = {};

async function cachedPage(url) {
  if (_pageCache[url]) return _pageCache[url];
  var html = await fetchText(url, { referer: BASE + "/" });
  if (html) _pageCache[url] = html;
  return html;
}

/** Base64 -> texto UTF-8 (atob devuelve los bytes como chars latin1). */
function b64ToHtml(s) {
  try {
    var bin = atob(String(s || "").replace(/\s+/g, ""));
    try {
      var pct = "";
      for (var i = 0; i < bin.length; i++) {
        pct += "%" + ("0" + bin.charCodeAt(i).toString(16)).slice(-2);
      }
      return decodeURIComponent(pct);
    } catch (e) { return bin; }
  } catch (e) { return ""; }
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// ==================== busqueda ====================

/**
 * Buscador WordPress del sitio. Devuelve solo fichas de serie (/anime/<slug>/),
 * no episodios ni el catalogo /anime/?status=...
 */
async function searchSite(query) {
  var out = [], seen = {};
  var html = await fetchText(BASE + "/?s=" + encodeURIComponent(query), { referer: BASE + "/" });
  if (!html) return out;
  var $ = cheerio.load(html);
  $("article").each(function (i, el) {
    var a = el.find("a[href]").first();
    var href = a.attr("href");
    if (!href) return;
    var url = R(href);
    // solo fichas: /anime/<slug>/ (excluye /anime/?filtros y episodios)
    if (!/\/anime\/[^\/?#]+\/?$/.test(url.split("?")[0])) return;
    if (seen[url]) return;
    var title = a.attr("title") || el.find("h2").first().text() || el.find(".tt").first().text();
    title = cleanSeriesTitle(decodeEntities(title).replace(/\s+/g, " "));
    if (!title) return;
    // Solo fichas de SERIE: las peliculas ("... The Movie ...") empatan o
    // superan a la serie en titleScore y desviarian el match de TMDB tv.
    if (/\bmovie\b/i.test(title) || /\bmovie\b/i.test(url)) return;
    seen[url] = 1;
    out.push({ title: title, url: url });
  });
  return out;
}

// ==================== episodios ====================

/**
 * Grid .eplister de la ficha -> {map:{num:url}, min, max} + plantillas de URL
 * (el numero de episodio sustituido por {N}) para probing fuera del grid.
 */
function parseEpisodeGrid(html) {
  var map = {}, templates = [], seenTpl = {};
  var $ = cheerio.load(html);
  $(".eplister li a[href]").each(function (i, el) {
    var href = el.attr("href");
    if (!href) return;
    var url = R(href);
    var m = /-episode-(\d+(?:-\d+)?)/i.exec(url);
    var isMovie = /-movie-/i.test(url);
    if (!m && !isMovie) return;
    var n = m ? parseInt(m[1], 10) : NaN;
    if (!n) {
      // .epl-num puede traer "249 (4K)" o texto sin numero ("Full Movie")
      var numText = el.find(".epl-num").first().text();
      n = parseInt(numText, 10) || episodeNumberFrom(numText);
      if (!n) n = episodeNumberFrom(el.find(".epl-title").first().text());
    }
    if (!n || map[n]) return;
    map[n] = url;
    if (m) {
      var tpl = url.replace(/-episode-\d+(?:-\d+)?/i, "-episode-{N}");
      if (!seenTpl[tpl]) { seenTpl[tpl] = 1; templates.push(tpl); }
    }
  });
  // Respaldo (tema antiguo): cualquier enlace de episodio fuera del grid.
  if (!Object.keys(map).length) {
    var re = /href="([^"]*-episode-\d+[^"]*)"/g, mm;
    while ((mm = re.exec(html))) {
      var u2 = R(decodeEntities(mm[1]));
      var m2 = /-episode-(\d+)/i.exec(u2);
      if (!m2) continue;
      var n2 = parseInt(m2[1], 10);
      if (n2 && !map[n2]) map[n2] = u2;
    }
  }
  var all = Object.keys(map).map(Number);
  return {
    map: map,
    min: all.length ? Math.min.apply(null, all) : 0,
    max: all.length ? Math.max.apply(null, all) : 0,
    templates: templates
  };
}

/** Grid de la ficha: {map:{num:url}, min, max}. */
async function seriesEpisodes(seriesUrl) {
  var html = await cachedPage(seriesUrl);
  if (!html) return { map: {}, min: 0, max: 0 };
  var g = parseEpisodeGrid(html);
  return { map: g.map, min: g.min, max: g.max };
}

/**
 * Probe de episodio fuera del grid: el sitio solo lista los ~100 ultimos
 * episodios, pero los posts antiguos siguen el mismo patron de URL. Se
 * derivan plantillas del grid y se comprueba cuales existen (200 + player).
 * Devuelve {url, html} con la pagina ya descargada, o null.
 */
async function episodeUrlFor(slug, numbers) {
  var seriesUrl = BASE + "/anime/" + String(slug || "").replace(/^\/+|\/+$/g, "") + "/";
  var html = await cachedPage(seriesUrl);
  if (!html) return null;
  var g = parseEpisodeGrid(html);
  for (var i = 0; i < numbers.length; i++) {
    var n = parseInt(numbers[i], 10);
    if (!n || n < 1) continue;
    if (g.map[n]) return { url: g.map[n] };
    for (var t = 0; t < g.templates.length; t++) {
      var u = g.templates[t].replace("{N}", String(n));
      var probe = await fetchText(u, { referer: seriesUrl });
      if (probe && (probe.indexOf("data-hash") >= 0 || probe.indexOf("pembed") >= 0)) {
        return { url: u, html: probe };
      }
    }
  }
  return null;
}

// ==================== player ====================

/** Host del "Dark Server" (actual playi.donghuaworld.com, antes donghuaplanet). */
function isDarkHost(u) {
  return /playi\.donghuaworld\.com|donghuaplanet\.com/i.test(String(u || ""));
}

/**
 * Recoge los servidores de la pagina de episodio: botones a[data-hash]
 * (iframe en base64) y, si no hay, el iframe renderizado en #pembed.
 * Orden: Dark Server primero (subs Spanish/English), luego Dailymotion.
 */
function collectServers(html) {
  var list = [], seen = {};
  function add(src, label) {
    src = decodeEntities(String(src || "").trim()).replace(/\\\//g, "/");
    if (src.indexOf("//") === 0) src = "https:" + src;
    if (src.indexOf("http") !== 0 || seen[src]) return;
    seen[src] = 1;
    var dark = isDarkHost(src) || /dark/i.test(label || "");
    var dm = /dailymotion|dai\.ly/i.test(src);
    list.push({ src: src, label: stripTags(label) || (dark ? "Dark Server" : "Servidor"), dark: dark, dm: dm });
  }
  var re = /<a[^>]*data-hash="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, m;
  while ((m = re.exec(html))) {
    var decoded = b64ToHtml(m[1]);
    var src = /src=["']([^"']+)["']/i.exec(decoded);
    if (src) add(src[1], m[2]);
  }
  if (!list.length) {
    // respaldo: iframe principal en #pembed (o cualquier iframe de player)
    var pe = /id="pembed"[\s\S]*?<iframe[^>]*src="([^"]+)"/.exec(html) ||
      /<iframe[^>]*src="([^"]*(?:dailymotion|donghuaplanet|playi\.donghuaworld|rumble)[^"]*)"/.exec(html);
    if (pe) add(pe[1], "");
  }
  list.sort(function (a, b) {
    var pa = a.dark ? 0 : (a.dm ? 1 : 2);
    var pb = b.dark ? 0 : (b.dm ? 1 : 2);
    return pa - pb;
  });
  return list;
}

/** Nodo de fuente del relay: {url, meta:{h}} o mapa altura -> nodo. */
function relayNodes(group) {
  var out = [];
  if (!group || typeof group !== "object") return out;
  if (typeof group.url === "string" && group.url) {
    out.push({ url: group.url, h: group.meta && group.meta.h });
    return out;
  }
  for (var k in group) {
    if (!Object.prototype.hasOwnProperty.call(group, k)) continue;
    var node = group[k];
    if (node && typeof node.url === "string" && node.url) {
      out.push({ url: node.url, h: (node.meta && node.meta.h) || k });
    }
  }
  return out;
}

/** Subs del relay (data.cc): solo Spanish/English, como el provider Kotlin. */
function relaySubtitles(cc, out) {
  if (!cc || typeof cc !== "object") return;
  for (var k in cc) {
    if (!Object.prototype.hasOwnProperty.call(cc, k)) continue;
    var v = cc[k];
    if (!v || !v.path) continue;
    var label = String(v.language || k).toLowerCase();
    var lang = null;
    if (/^es|spanish|espa/.test(label)) lang = "es";
    else if (/^en|english/.test(label)) lang = "en";
    if (!lang) continue;
    var url = String(v.path).replace(/\\\//g, "/").replace("1a-1791.com", "hugh.cdn.rumble.cloud");
    if (url.indexOf("http") !== 0 || out.subs[url]) continue;
    out.subs[url] = 1;
    out.subtitles.push({ url: url, language: lang, name: lang === "es" ? "Spanish" : "English" });
  }
}

/**
 * Dark Server via relay JSON (formato actual del player). El endpoint exige
 * la cabecera Origin del host del player; sin ella responde 403 "forbidden".
 */
async function extractDarkRelay(playerUrl, out) {
  var id = String(playerUrl).split("?")[0].replace(/\/+$/, "").split("/").pop();
  if (!id) return false;
  var origin = (/^https?:\/\/[^\/]+/.exec(playerUrl) || [""])[0];
  var relayUrl = RELAY_BASE + "/?json=1&id=" + encodeURIComponent(id);
  var text = await fetchText(relayUrl, {
    referer: playerUrl,
    headers: { "Origin": origin, "Accept": "application/json, text/plain, */*" }
  });
  if (!text) return false;
  var j;
  try { j = JSON.parse(text); } catch (e) { return false; }
  if (!j || !j.ok || !j.data) return false;
  var d = j.data;
  var ua = (d.ua && Object.keys(d.ua).length) ? d.ua : (d.u || {});
  var before = out.streams.length;

  // 1) master HLS (Auto): el core expande variantes H264 con audio
  var hls = relayNodes(ua.hls);
  for (var i = 0; i < hls.length; i++) {
    await tryPlaylist(hls[i].url.replace(/\\\//g, "/"), out, "Dark Server", PLAYER_BASE + "/");
  }
  // 2) HLS por calidad en contenedor TAR (r_file=chunklist.m3u8): NO son mp4,
  //    se emiten tal cual con su calidad (el player de la TV los trata como HLS)
  var tar = relayNodes(ua.tar);
  for (var t = 0; t < tar.length; t++) {
    var turl = tar[t].url.replace(/\\\//g, "/");
    if (turl.indexOf("r_file=") < 0 && turl.indexOf("chunklist.m3u8") < 0 && !/\.m3u8/i.test(turl)) continue;
    pushStream(out, turl, qualityFromHeight(tar[t].h) || "Auto", "Dark Server", PLAYER_BASE + "/");
  }
  // 3) mp4 progresivos si los hubiera
  var mp4 = relayNodes(ua.mp4);
  for (var p = 0; p < mp4.length; p++) {
    pushStream(out, mp4[p].url.replace(/\\\//g, "/"), qualityFromHeight(mp4[p].h) || "Auto", "Dark Server", PLAYER_BASE + "/");
  }
  relaySubtitles(d.cc, out);
  return out.streams.length > before;
}

/**
 * Dark Server formato antiguo: sources/tracks inline en el HTML del player
 * (player.donghuaplanet.com). Port de extractAndParseSources/Tracks del Kotlin.
 */
async function extractDarkInline(playerUrl, referer, out) {
  var html = await fetchText(playerUrl, { referer: referer });
  if (!html) return false;
  var before = out.streams.length;

  var tr = /(?:const|var|let)?\s*tracks\s*[:=]\s*(\[[\s\S]*?\])\s*[;,]/.exec(html);
  if (tr) {
    var reT = /\{[^{}]*\}/g, mt;
    while ((mt = reT.exec(tr[1]))) {
      var file = /"(?:file|src|url)"\s*:\s*"([^"]+)"/.exec(mt[0]);
      var label = /"(?:label|language|lang|name)"\s*:\s*"([^"]+)"/.exec(mt[0]);
      if (!file || !label) continue;
      var lang = null, ll = label[1].toLowerCase();
      if (/spanish|espa|^es/.test(ll)) lang = "es";
      else if (/english|eng|^en/.test(ll)) lang = "en";
      if (!lang) continue;
      var su = file[1].replace(/\\\//g, "/").replace(/\\u0026/g, "&");
      if (su.indexOf("http") !== 0 || out.subs[su]) continue;
      out.subs[su] = 1;
      out.subtitles.push({ url: su, language: lang, name: lang === "es" ? "Spanish" : "English" });
    }
  }

  var src = /sources\s*[:=]\s*(\[[\s\S]*?\])\s*[;,]/.exec(html);
  if (src) {
    var reS = /\{\s*"file"\s*:\s*"([^"]+)"\s*,\s*"type"\s*:\s*"([^"]+)"\s*,\s*"label"\s*:\s*"([^"]+)"\s*\}/g, ms;
    while ((ms = reS.exec(src[1]))) {
      var u = ms[1].replace(/\\\//g, "/").replace(/\\u0026/g, "&");
      var type = ms[2], q = qualityFromHeight((/(\d{3,4})/.exec(ms[3]) || [])[1]) || "Auto";
      if (/mpegurl/i.test(type)) {
        await tryPlaylist(u, out, "Dark Server", PLAYER_BASE + "/");
      } else if (u.indexOf("r_file=") >= 0 || u.indexOf("chunklist.m3u8") >= 0) {
        pushStream(out, u, q, "Dark Server", PLAYER_BASE + "/");
      } else if (/mp4/i.test(type)) {
        pushStream(out, u, q, "Dark Server", PLAYER_BASE + "/");
      }
    }
  }
  if (out.streams.length === before) {
    var hls = /["'](https:\/\/rumble\.com\/hls-vod\/[^"']+\.m3u8[^"']*)["']/.exec(html) ||
      /["'](https:\/\/[^"']*\.m3u8[^"']*)["']/.exec(html);
    if (hls) await tryPlaylist(hls[1].replace(/\\\//g, "/"), out, "Dark Server", PLAYER_BASE + "/");
  }
  return out.streams.length > before;
}

/** Dark Server completo: relay JSON -> inline antiguo -> embed Rumble. */
async function extractDarkServer(playerUrl, referer, out) {
  if (await extractDarkRelay(playerUrl, out)) return true;
  if (await extractDarkInline(playerUrl, referer, out)) return true;
  var id = String(playerUrl).split("?")[0].replace(/\/+$/, "").split("/").pop();
  if (id) return await extractRumble("https://rumble.com/embed/" + id + "/", referer, out);
  return false;
}

/** Extrae los streams de una pagina de episodio. */
async function episodeStreams(episodeUrl, preloaded) {
  var html = preloaded && preloaded.html ? preloaded.html : "";
  if (!html) html = await fetchText(episodeUrl, { referer: BASE + "/" });
  var out = newEmit();
  if (!html) return finishEmit(out);
  // _t0 lo pone runSite; si se llama la pagina suelta (harness) no vale.
  var start = (typeof _t0 === "number" && _t0 > 0) ? _t0 : Date.now();
  var servers = collectServers(html);
  var tried = 0;
  for (var i = 0; i < servers.length; i++) {
    if (tried >= 6 || out.streams.length >= 3) break;
    if (Date.now() - start > BUDGET_MS) { log("presupuesto agotado en servidores"); break; }
    var s = servers[i];
    tried++;
    try {
      if (s.dark) {
        await extractDarkServer(s.src, episodeUrl, out);
      } else {
        await routeEmbed(s.src, episodeUrl, s.label, out);
      }
    } catch (e) {
      log("servidor fallo (" + s.label + "): " + (e && e.message));
    }
  }
  if (!out.streams.length) await extractEmbedsFromHtml(html, episodeUrl, out, "DonghuaWorld");
  return finishEmit(out);
}

var SITE = {
  id: "donghuaworld",
  name: "DonghuaWorld",
  base: BASE,
  aliases: ALIASES,
  search: searchSite,
  episodes: seriesEpisodes,
  streams: episodeStreams,
  seasonOfUrl: null,
  episodeUrlFor: episodeUrlFor,
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
    findSeries: function (titles, season) { return findSeries(SITE, titles, season); },
    seriesEpisodes: seriesEpisodes,
    episodeStreams: episodeStreams,
    episodeUrlFor: episodeUrlFor,
    collectServers: collectServers,
    extractDarkServer: extractDarkServer
  }
};