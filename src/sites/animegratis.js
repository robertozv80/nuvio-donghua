/**
 * AnimeGratis (https://animegratis.net) - plugin Nuvio TV.
 *
 * Port del provider CloudStream AnimeGratisProvider (repo donghua-ext).
 * El provider Kotlin tambien trae home/ratings/descargas; aqui solo interesan
 * la BUSQUEDA de serie, el LISTADO de episodios y el PLAYER de un episodio.
 *
 *  - Buscador: endpoint JSON propio del sitio (el que usa el buscador del home):
 *      GET /api/animes/search?q=<texto>&limit=<n>
 *      -> { animes: [ { id, title, slug, image, genres, isMovie } ] }
 *    El slug devuelto es el "crudo": la ficha es /anime/<slug>-anime y el
 *    episodio /anime/<slug>/episodio-<N> (verificado en vivo: la ficha de
 *    Naruto es /anime/naruto-anime y sus episodios /anime/naruto/episodio-1).
 *    Fallback: /directorio?q=<texto> con el JSON #ssr-init (filtra por titulo).
 *
 *  - Ficha: grid #episodes-grid. El HTML solo renderiza 24 episodios (rango
 *    inicial) pero lleva data-total-episodes; el resto se completa con el
 *    patron de URL. Cada ficha de temporada numera desde 1.
 *
 *  - Episodio: los servidores vienen en dos sitios:
 *      a) <script id="player-ui-data" type="application/json"> con la estructura
 *         { defaultLang, groups: { <idioma>: [ { name, players: [ {name,url} ] } ] } }
 *      b) botones con atributo data-url="<embed>" (lo usan las peliculas).
 *    Ademas hay un <iframe id="videoFrame"> con el reproductor principal.
 *
 *  - Servidores: jkanime.net/jkplayer (HLS: el manifest .m3u8 esta en el HTML
 *    del player), OK.ru, VOE y el resto via extractor generico del core.
 */

var BASE = "https://animegratis.net";

/** Alias: titulo original de TMDB -> titulo con el que lo publica el sitio. */
var ALIASES = {
  "\u6211\u7684\u4e00\u7ea7\u5b66\u5382": ["Ore dake Level Up na Ken", "Solo Leveling"],
  "\u9006\u5929\u90aa\u795e": ["Against the Gods", "Ni Tian Xie Shen"],
  "\u6b66\u795e\u4e3b\u5b9a": ["Martial Master", "Wu Shen Zhu Zai"],
  "\u6597\u7f57\u5927\u9646": ["Soul Land", "Douluo Dalu"],
  "\u5411\u5929\u4e00\u5200": ["Blade of the Gods", "Xiang Tian Yi Dao"]
};

function R(u) { return absUrl(BASE, u); }

/**
 * GET con cabeceras grandes.
 *
 * Las paginas del player de AnimeGratis devuelven ~19 KB de cabeceras (las dos
 * CSP del sitio). El fetch de Nuvio (OkHttp) las aguanta sin problema, pero el
 * de Node (undici) aborta con "Headers Overflow Error" a partir de 16 KB, asi
 * que aqui se hace un reintento por HTTP puro cuando el fetch global falla.
 * Ese reintento solo existe en Node (en la TV el import dinamico falla y se
 * ignora), por eso no se usa require/process/Buffer.
 */
var _nodeHttps;   // undefined = sin probar, null = no disponible

async function nodeHttps() {
  if (_nodeHttps !== undefined) return _nodeHttps;
  _nodeHttps = null;
  try {
    var imp = new Function("m", "return import(m);");
    var mod = await imp("node:https");
    _nodeHttps = (mod && mod.default) ? mod.default : mod;
  } catch (e) { _nodeHttps = null; }
  return _nodeHttps;
}

/** Peticion HTTP cruda (solo Node): no tiene limite de cabeceras. */
function rawGet(https, url, opts) {
  return new Promise(function (resolve) {
    try {
      var u = new URL(url);
      var headers = { "User-Agent": UA, "Accept": "text/html,*/*" };
      if (opts && opts.referer) headers["Referer"] = opts.referer;
      if (opts && opts.headers) {
        for (var k in opts.headers) {
          if (Object.prototype.hasOwnProperty.call(opts.headers, k)) headers[k] = opts.headers[k];
        }
      }
      var req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: (opts && opts.method) || "GET",
        headers: headers,
        // Node corta las cabeceras a 16 KB; la TV (OkHttp) aguanta 256 KB.
        maxHeaderSize: 256 * 1024
      }, function (res) {
        var data = "";
        res.setEncoding("utf8");
        res.on("data", function (c) { data += c; });
        res.on("end", function () { resolve({ status: res.statusCode, text: data, res: null }); });
      });
      req.on("error", function () { resolve({ status: 0, text: "", res: null }); });
      req.setTimeout(25000, function () {
        try { req.destroy(); } catch (e) {}
        resolve({ status: 0, text: "", res: null });
      });
      if (opts && opts.body != null) req.write(opts.body);
      req.end();
    } catch (e) {
      resolve({ status: 0, text: "", res: null });
    }
  });
}

/** GET que devuelve {status, text, res}; cae a HTTP crudo si el fetch falla. */
async function httpGet(url, opts) {
  opts = opts || {};
  try {
    var h = baseHeaders(opts.referer);
    if (opts.headers) {
      for (var k in opts.headers) {
        if (Object.prototype.hasOwnProperty.call(opts.headers, k)) h[k] = opts.headers[k];
      }
    }
    var init = { headers: h };
    if (opts.method) init.method = opts.method;
    if (opts.body != null) init.body = opts.body;
    var res = await fetch(url, init);
    var txt = await res.text();
    return { status: res.status, text: txt, res: res };
  } catch (e) {
    var https = await nodeHttps();
    if (!https) return { status: 0, text: "", res: null };
    return await rawGet(https, url, opts);
  }
}

/** Slug "crudo" de una ficha: /anime/naruto-anime -> naruto. */
function rawSlug(url) {
  var s = String(url || "").split("?")[0].replace(/\/+$/, "");
  var last = s.split("/").pop() || "";
  return last.replace(/-anime$/, "");
}

/** Nombre legible del servidor a partir del host del embed. */
function serverName(url) {
  var m = /^(?:https?:)?\/\/([^/?#]+)/i.exec(String(url || ""));
  var host = m ? m[1] : "";
  host = host.replace(/^www\./, "").split(":")[0];
  if (!host) return "Servidor";
  return host.charAt(0).toUpperCase() + host.slice(1);
}

// ==================== busqueda ====================

/** Respaldo: /directorio?q= con el JSON #ssr-init (filtra por titulo). */
async function searchDirectorio(query) {
  var out = [];
  var r = await httpGet(BASE + "/directorio?q=" + encodeURIComponent(query));
  var html = r.text || "";
  if (!html) return out;
  var m = /<script[^>]*id="ssr-init"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return out;
  var j;
  try { j = JSON.parse(m[1]); } catch (e) { return out; }
  var list = (j && j.animes) || [];
  var q = norm(query);
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a || !a.t || !a.sl) continue;
    if (q && norm(a.t).indexOf(q) < 0) continue;
    out.push({ title: a.t, url: BASE + "/anime/" + a.sl + "-anime" });
  }
  return out;
}

/**
 * Buscador real del sitio (endpoint JSON). Devuelve solo fichas de serie
 * (no episodios): cada resultado es /anime/<slug>-anime.
 */
async function searchSite(query) {
  var out = [], seen = {};
  try {
    var r = await httpGet(BASE + "/api/animes/search?q=" + encodeURIComponent(query) + "&limit=20", {
      headers: { "Accept": "application/json" }
    });
    var j = JSON.parse(r.text || "null");
    var list = (j && j.animes) || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || !a.slug || !a.title) continue;
      var u = BASE + "/anime/" + a.slug + "-anime";
      if (seen[u]) continue;
      seen[u] = 1;
      out.push({ title: a.title, url: u });
    }
  } catch (e) {
    log("api de busqueda fallo: " + (e && e.message));
  }
  if (!out.length) out = await searchDirectorio(query);
  return out;
}

// ==================== episodios ====================

/** Grid de la ficha: {map:{num:url}, min, max}. */
async function seriesEpisodes(seriesUrl) {
  var map = {};
  var r = await httpGet(seriesUrl);
  var html = r.text;
  if (html) {
    var $ = cheerio.load(html);
    var grid = $("#episodes-grid");
    var total = parseInt(grid.attr("data-total-episodes"), 10) || 0;
    var slug = null;
    $("#episodes-grid a[href]").each(function (i, el) {
      var href = el.attr("href");
      if (!href || href.indexOf("episodio-") < 0) return;
      var mm = /episodio-(\d+)/.exec(href);
      if (!mm) return;
      var n = parseInt(mm[1], 10);
      map[n] = R(href);
      if (!slug) {
        var sm = /\/anime\/([^\/]+)\/episodio-/.exec(href.split("?")[0]);
        if (sm) slug = sm[1];
      }
    });
    // El grid solo trae el primer rango: se completa con el patron de URL.
    if (slug && total) {
      var nums = Object.keys(map).map(Number);
      var from = nums.length ? Math.min.apply(null, nums) : 1;
      for (var n2 = from; n2 <= total; n2++) {
        if (!map[n2]) map[n2] = BASE + "/anime/" + slug + "/episodio-" + n2;
      }
    }
  }
  var all = Object.keys(map).map(Number);
  return {
    map: map,
    min: all.length ? Math.min.apply(null, all) : 0,
    max: all.length ? Math.max.apply(null, all) : 0
  };
}

/**
 * Probe de URL directa /anime/<slug>/episodio-<N> (patron del sitio).
 * Evita descargar la ficha entera (las series largas rondan el limite de 1MB).
 * Devuelve {url, res, html} con el body ya consumido.
 */
async function probeEpisodeUrl(slug, numbers) {
  var cands = [String(slug || "").replace(/-anime$/, "")];
  if (cands[0] !== String(slug || "")) cands.push(String(slug || ""));
  for (var i = 0; i < numbers.length; i++) {
    var n = parseInt(numbers[i], 10);
    if (!n || n < 1) continue;
    for (var c = 0; c < cands.length; c++) {
      if (!cands[c]) continue;
      var u = BASE + "/anime/" + cands[c] + "/episodio-" + n;
      try {
        var r = await httpGet(u);
        if (r.status !== 200) continue;
        var html = r.text;
        if (html.indexOf("player-ui-data") >= 0 || html.indexOf("data-url") >= 0) {
          return { url: u, res: r.res, html: html };
        }
      } catch (e) { /* siguiente candidato */ }
    }
  }
  return null;
}

// ==================== player ====================

/** jkanime.net/jkplayer: el manifest .m3u8 esta en el HTML del player. */
async function extractJkPlayer(playerUrl, referer, out) {
  var r = await httpGet(playerUrl, { referer: referer });
  var html = r.text || "";
  if (!html) return false;
  var re = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/g, m, found = false;
  while ((m = re.exec(html))) {
    if (found) break;
    var u = m[0].replace(/\\\//g, "/");
    if (await tryPlaylist(u, out, "HLS", playerUrl)) found = true;
  }
  return found;
}
/** Prioridad de cada servidor (menor = antes). */
function serverPriority(name, url) {
  var n = String(name || "").toLowerCase();
  var u = String(url || "").toLowerCase();
  if (u.indexOf("jkanime.net") >= 0 || n.indexOf("hls") >= 0) return 0;
  if (u.indexOf("ok.ru") >= 0 || n.indexOf("okru") >= 0) return 1;
  if (u.indexOf("voe.") >= 0 || n.indexOf("voe") >= 0) return 2;
  if (n.indexOf("streamwish") >= 0 || n.indexOf("sfast") >= 0) return 3;
  if (n.indexOf("mp4upload") >= 0 || n.indexOf("yourupload") >= 0) return 4;
  if (u.indexOf("dailymotion") >= 0) return 2;
  if (u.indexOf("rumble") >= 0) return 3;
  if (u.indexOf("mega.nz") >= 0) return 6;
  return 5;
}

/** Prioridad del idioma del grupo (el subbed japones suele ir primero). */
function langPriority(lang) {
  var l = String(lang || "").toLowerCase();
  if (l === "ja" || l === "es" || l === "sub" || l === "espa") return 0;
  if (l === "lat" || l === "cast" || l === "en") return 1;
  return 2;
}

/**
 * Recoge los reproductores de una pagina de episodio/pelicula.
 * Fuentes: JSON #player-ui-data, atributos data-url e iframes.
 */
function collectPlayers(html) {
  var list = [], seen = {};
  function add(url, name, lang) {
    url = decodeEntities(String(url || "").trim());
    if (url.indexOf("http") !== 0 && url.indexOf("//") !== 0) return;
    if (url.indexOf("//") === 0) url = "https:" + url;
    if (seen[url]) return;
    seen[url] = 1;
    list.push({ url: url, name: name || serverName(url), lang: lang || "" });
  }

  // a) JSON #player-ui-data
  var m = /<script[^>]*id="player-ui-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (m) {
    try {
      var j = JSON.parse(m[1]);
      var groups = (j && j.groups) || {};
      var langs = Object.keys(groups);
      for (var li = 0; li < langs.length; li++) {
        var lang = langs[li];
        var arr = groups[lang] || [];
        for (var gi = 0; gi < arr.length; gi++) {
          var g = arr[gi] || {};
          var players = g.players || [];
          for (var pi = 0; pi < players.length; pi++) {
            var p = players[pi] || {};
            if (!p.url) continue;
            add(p.url, g.name || p.name || serverName(p.url), lang);
          }
        }
      }
    } catch (e) {
      log("player-ui-data ilegible: " + (e && e.message));
    }
  }

  // b) botones data-url
  var re2 = /data-url\s*=\s*"([^"]+)"/g, m2;
  while ((m2 = re2.exec(html))) add(m2[1], serverName(m2[1]), "");

  // c) iframes
  var re3 = /<iframe[^>]*\ssrc\s*=\s*"([^"]+)"/g, m3;
  while ((m3 = re3.exec(html))) add(m3[1], serverName(m3[1]), "");

  list.sort(function (a, b) {
    var pa = langPriority(a.lang) * 10 + serverPriority(a.name, a.url);
    var pb = langPriority(b.lang) * 10 + serverPriority(b.name, b.url);
    return pa - pb;
  });
  return list;
}

/** Resuelve los reproductores de una pagina ya descargada. */
async function streamsFromHtml(html, referer) {
  var out = newEmit();
  if (!html) return finishEmit(out);
  // _t0 lo pone runSite; si se llama la pagina suelta (harness) no vale.
  var start = (typeof _t0 === "number" && _t0 > 0) ? _t0 : Date.now();
  var players = collectPlayers(html);
  var tried = 0;
  for (var i = 0; i < players.length; i++) {
    if (tried >= 8) break;
    if (out.streams.length >= 3) break;
    if (Date.now() - start > BUDGET_MS) {
      log("presupuesto agotado en reproductores");
      break;
    }
    var p = players[i];
    tried++;
    try {
      if (p.url.indexOf("jkanime.net") >= 0) {
        if (await extractJkPlayer(p.url, referer, out)) continue;
      }
      await routeEmbed(p.url, referer, p.name, out);
    } catch (e) {
      log("reproductor fallo (" + p.name + "): " + (e && e.message));
    }
  }
  if (!out.streams.length) await extractEmbedsFromHtml(html, referer, out, "Servidor");
  return finishEmit(out);
}

/** Extrae los streams de una pagina de episodio. */
async function episodeStreams(episodeUrl, preloaded) {
  var html = preloaded && preloaded.html ? preloaded.html : "";
  if (!html) {
    var r = await httpGet(episodeUrl);
    html = r.text || "";
    if (!html) return [];
  }
  return await streamsFromHtml(html, episodeUrl);
}

/** Ficha de pelicula -> pagina /anime/<slug>/pelicula. */
async function movieStreams(seriesUrl) {
  var slug = rawSlug(seriesUrl);
  var page = BASE + "/anime/" + slug + "/pelicula";
  var r = await httpGet(page);
  var html = r.text || "";
  if (!html || (html.indexOf("data-url") < 0 && html.indexOf("player-ui-data") < 0)) {
    var r2 = await httpGet(seriesUrl);
    html = r2.text || "";
    page = seriesUrl;
  }
  if (!html) return [];
  return await streamsFromHtml(html, page);
}

var SITE = {
  id: "animegratis",
  name: "AnimeGratis",
  base: BASE,
  aliases: ALIASES,
  search: searchSite,
  episodes: seriesEpisodes,
  streams: episodeStreams,
  seasonOfUrl: null,
  episodeUrlFor: probeEpisodeUrl,
  movieStreams: movieStreams
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
    movieStreams: movieStreams,
    probeEpisodeUrl: probeEpisodeUrl,
    collectPlayers: collectPlayers,
    extractJkPlayer: extractJkPlayer,
    rawSlug: rawSlug,
    resolveMergedSeasons: function (series, ep) { return resolveMergedSeasons(SITE, series, ep); }
  }
};
