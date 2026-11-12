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