/**
 * DonghuaZone (https://www.donghuazone.com) - plugin Nuvio TV.
 *
 * Port del provider CloudStream DonghuaZoneProvider (repo donghua-ext).
 * El sitio es un blog de Blogger; todo se resuelve con sus feeds JSON
 * publicos (sin scrapear la web, que pesa ~800 KB por pagina):
 *
 *  - Busqueda: GET /feeds/posts/default?alt=json&q=<query>&max-results=50.
 *    Cada entry: title.$t, link[rel=alternate].href, category[].term
 *    (labels) y content.$t (HTML del post). Blogger indexa CADA post de
 *    episodio por el nombre de la serie -> se devuelve UNA card por serie:
 *    el label que no es genero/meta ("Swallowed star") y, de sus posts, el
 *    mas rico (el que trae nota como label "8.44" o el que no es episodio).
 *    La URL de la "ficha" es la pagina de label /search/label/<Label>.
 *
 *  - Episodios: feed por label /feeds/posts/default/-/<Label>?alt=json con
 *    paginacion (max-results=100, ~400 KB/pagina; el limite de Nuvio es 1 MB).
 *    El numero sale del titulo "X Episode 250 [4K | Indo Sub]". Los posts
 *    sin "Episode N" pero con botones changeServer (peliculas) se numeran
 *    del mas viejo al mas nuevo si no hay episodios numerados.
 *
 *  - Player: el content del post (feed ?alt=json&path=<ruta>, ~40 KB) trae
 *    <button class="serverBtn" onclick="changeServer(this,'<embed>')">.
 *    Los embeds son geo.dailymotion.com/player/<id>.html?video=<vid> ->
 *    extractDailymotion del core (HLS muxed + subtitulos es/en). "Multi Sub"
 *    primero (es el que trae las pistas de subtitulos).
 *
 * Nota: el sitio solo publica desde ~mayo 2025 (Swallowed Star empieza en
 * el E165); para episodios anteriores el core cae al ultimo disponible.
 */

var BASE = "https://www.donghuazone.com";
var FEED = "/feeds/posts/default";
var ALIASES = {
  "\u6597\u7f57\u5927\u9646": ["Soul Land", "Combat Continent"],
  "\u541e\u566c\u661f\u7a7a": ["Swallowed Star"],
  "\u5996\u795e\u8bb0": ["Tales of Demons and Gods"],
  "\u9006\u5929\u81f3\u5c0a": ["Against The Sky Supreme"]
};

var PAGE_SIZE = 100;  // entradas por pagina del feed (~400 KB con content)
var MAX_PAGES = 6;    // hasta 600 episodios por serie

function R(u) { return absUrl(BASE, u); }

/** Labels de genero (no son nombres de serie). */
var GENRE_SET = {
  "Action": 1, "Adventure": 1, "Cars": 1, "Comedy": 1, "Dementia": 1, "Demons": 1,
  "Drama": 1, "Ecchi": 1, "Fantasy": 1, "Game": 1, "Harem": 1, "Historical": 1,
  "Horror": 1, "Josei": 1, "Kids": 1, "Magic": 1, "Martial Arts": 1, "Mecha": 1,
  "Military": 1, "Music": 1, "Mysteri": 1, "Parody": 1, "Police": 1,
  "Psychological": 1, "Romance": 1, "Samurai": 1, "School": 1, "Sci-Fi": 1,
  "Seinen": 1, "Shoujo": 1, "Shoujo Ai": 1, "Shounen": 1, "Shounen Ai": 1,
  "Slice of Life": 1, "Space": 1, "Sport": 1, "Sports": 1, "Super Power": 1,
  "Supernatural": 1, "Thriller": 1, "Vampire": 1, "Isekai": 1, "Erotica": 1,
  "Hentai": 1, "Danger": 1, "Hot": 1, "Sub": 1, "Episode": 1, "Eps. Donghua": 1
};

/** Labels meta que tampoco son series (fichas: Censored/China/Ongoing/...).
 *  Japan/Korea anadidos: el feed de movies los usa como label de pais. */
var META_LABELS = {
  "Danger": 1, "Hot": 1, "Sub": 1, "Episode": 1, "Eps. Donghua": 1, "Movie": 1,
  "Series": 1, "Ongoing": 1, "Completed": 1, "Censored": 1, "China": 1, "Donghua": 1,
  "Japan": 1, "Korea": 1, "Japanese": 1, "Chinese": 1
};

/** Labels meta con formato variable: estaciones ("Summer 2026"), notas ("8.44"). */
function isMetaLike(l) {
  l = String(l || "").trim();
  return /^(?:Spring|Summer|Fall|Winter)\s+\d{4}$/i.test(l) ||
    /^\d\.\d+$/.test(l) || /^Eps?\.?/i.test(l) || /\d{4}/.test(l);
}

function isSeriesLabel(l) {
  return !GENRE_SET[l] && !META_LABELS[l] && !isMetaLike(l);
}

// ==================== feeds ====================

/** GET de un feed Blogger -> {entries, total}. */
async function fetchFeed(url) {
  var text = await fetchText(url, { headers: { "Accept": "application/json" } });
  try {
    var j = JSON.parse(text);
    var f = j && j.feed;
    if (!f) return { entries: [], total: 0 };
    var tot = f["openSearch$totalResults"];
    return { entries: f.entry || [], total: parseInt(tot && tot.$t, 10) || 0 };
  } catch (e) {
    return { entries: [], total: 0 };
  }
}

function entryTitle(e) { return (e && e.title && e.title.$t) || ""; }
function entryContent(e) { return (e && e.content && e.content.$t) || ""; }

function entryLink(e) {
  var links = (e && e.link) || [];
  for (var i = 0; i < links.length; i++) {
    if (links[i] && links[i].rel === "alternate") return links[i].href || "";
  }
  return "";
}

function labelsOf(e) {
  var cats = (e && e.category) || [], out = [];
  for (var i = 0; i < cats.length; i++) {
    if (cats[i] && cats[i].term) out.push(String(cats[i].term).trim());
  }
  return out;
}

/** Label de SERIE de una entrada (primer label que no es genero/meta). */
function seriesLabelOf(e) {
  var ls = labelsOf(e);
  for (var i = 0; i < ls.length; i++) if (isSeriesLabel(ls[i])) return ls[i];
  return null;
}

/** Riqueza de un post: nota como label (+4) y no ser de episodio (+2). */
function rankEntry(e) {
  var r = 0, ls = labelsOf(e);
  for (var i = 0; i < ls.length; i++) if (/^\d\.\d+$/.test(ls[i])) r += 4;
  if (!/Episode\s+\d+/i.test(entryTitle(e))) r += 2;
  return r;
}

// ==================== busqueda ====================

/** Una card por serie (label), con la URL de su pagina de label. */
async function searchSite(query) {
  var feed = await fetchFeed(BASE + FEED + "?alt=json&q=" +
    encodeURIComponent(String(query || "").trim()) + "&max-results=50");
  var chosen = {}, order = [];
  for (var i = 0; i < feed.entries.length; i++) {
    var e = feed.entries[i];
    var label = seriesLabelOf(e);
    if (!label) continue;
    var r = rankEntry(e);
    if (!chosen[label]) { chosen[label] = { e: e, r: r }; order.push(label); }
    else if (r > chosen[label].r) chosen[label] = { e: e, r: r };
  }
  var out = [], seen = {};
  for (var k = 0; k < order.length; k++) {
    var lab = order[k];
    var url = BASE + "/search/label/" + encodeURIComponent(lab);
    if (seen[url]) continue;
    seen[url] = 1;
    var t = cleanSeriesTitle(entryTitle(chosen[lab].e)) || lab;
    // titulos truncados por el sitio: "... [4K" sin cierre
    t = t.replace(/\s*\[[^\]]*$/, "").trim() || lab;
    out.push({ title: t, url: url });
  }
  return out;
}

/** Temporada a partir del label de la URL (/search/label/X%20Season%202). */
function seasonOfUrl(u) {
  var m = /\/search\/label\/([^?#]+)/i.exec(String(u || ""));
  if (!m) return null;
  var lab;
  try { lab = decodeURIComponent(m[1]); } catch (e) { lab = m[1]; }
  var s = /season\s*(\d+)/i.exec(lab);
  return s ? parseInt(s[1], 10) : null;
}

// ==================== episodios ====================

/** Label de serie de una URL de ficha (/search/label/<Label>). */
function labelOfUrl(u) {
  var m = /\/search\/label\/([^?#]+)/i.exec(String(u || ""));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

/**
 * URL de episodio -> label de serie via feed ?path= (labels REALES del post;
 * el q=slug falla con slugs raros). Se prefiere el label contenido en el slug.
 */
async function labelFromEpisode(u) {
  if (!/\/\d{4}\/\d{2}\/.+\.html/i.test(String(u || ""))) return null;
  var path = String(u).replace(BASE, "").split("?")[0].split("#")[0];
  var feed = await fetchFeed(BASE + FEED + "?alt=json&path=" + encodeURIComponent(path));
  for (var i = 0; i < feed.entries.length; i++) {
    var e = feed.entries[i];
    if (entryLink(e) !== u) continue;
    var ls = labelsOf(e).filter(isSeriesLabel);
    if (!ls.length) return null;
    var slugNorm = norm(path.split("/").pop().replace(/\.html$/i, "").replace(/-/g, " "));
    for (var k = 0; k < ls.length; k++) {
      if (slugNorm.indexOf(norm(ls[k])) >= 0) return ls[k];
    }
    return ls[0];
  }
  return null;
}

/** Feed por label -> {map:{num:url}, min, max} (numeracion global del sitio). */
async function seriesEpisodes(seriesUrl) {
  var start = (typeof _t0 === "number" && _t0 > 0) ? _t0 : Date.now();
  var label = labelOfUrl(seriesUrl);
  if (!label) label = await labelFromEpisode(seriesUrl);
  if (!label) {
    // ultimo recurso: el slug del post como nombre de serie
    label = String(seriesUrl || "").split("?")[0].replace(/\/+$/, "")
      .split("/").pop().replace(/\.html$/i, "").replace(/-/g, " ");
  }
  var map = {}, seen = {}, noEp = [];
  var startIndex = 1;
  for (var p = 0; p < MAX_PAGES; p++) {
    if (Date.now() - start > BUDGET_MS) { log("presupuesto agotado en el feed de label"); break; }
    var feed = await fetchFeed(BASE + FEED + "/-/" + encodeURIComponent(label) +
      "?alt=json&max-results=" + PAGE_SIZE + "&start-index=" + startIndex);
    if (!feed.entries.length) break;
    for (var i = 0; i < feed.entries.length; i++) {
      var e = feed.entries[i];
      var link = entryLink(e);
      if (!link || seen[link]) continue;
      seen[link] = 1;
      var m = /Episode\s+(\d+(?:-\d+)?)/i.exec(entryTitle(e));
      if (m) {
        var n = parseInt(m[1], 10);
        if (n && !map[n]) map[n] = link;
      } else if (entryContent(e).indexOf("changeServer(") >= 0) {
        noEp.push(link); // post de player/pelicula sin "Episode N"
      }
    }
    if (feed.entries.length < PAGE_SIZE) break;
    if (feed.total && startIndex + PAGE_SIZE > feed.total) break;
    startIndex += PAGE_SIZE;
  }
  // Sin episodios numerados: numerar los posts de player (el mas viejo = 1).
  if (!Object.keys(map).length && noEp.length) {
    for (var j = 0; j < noEp.length; j++) map[noEp.length - j] = noEp[j];
  }
  var all = Object.keys(map).map(Number);
  return {
    map: map,
    min: all.length ? Math.min.apply(null, all) : 0,
    max: all.length ? Math.max.apply(null, all) : 0
  };
}

// ==================== player ====================

/** Botones changeServer del content HTML -> [{url,label}], Multi Sub primero. */
function parseServers(text) {
  var list = [], seen = {};
  var re = /<button[^>]*onclick\s*=\s*"changeServer\(this,\s*'([^']*)'\)"[^>]*>\s*([^<]*?)\s*<\/button>/gi, m;
  while ((m = re.exec(String(text || "")))) {
    var u = decodeEntities(m[1]).trim();
    if (!u || u.indexOf("http") !== 0 || seen[u]) continue;
    seen[u] = 1;
    list.push({ url: u, label: decodeEntities(m[2]).trim() || "Servidor" });
  }
  list.sort(function (a, b) {
    var pa = /multi/i.test(a.label) ? 0 : 1;
    var pb = /multi/i.test(b.label) ? 0 : 1;
    return pa - pb;
  });
  return list;
}

/** Respaldo: players geo.dailymotion sueltos en el HTML/content. */
async function geoPlayers(text, referer, out) {
  var re = /https?:\/\/geo\.dailymotion\.com\/player\/[a-z0-9]+\.html\?video=[A-Za-z0-9]+/gi, m;
  var seen = {};
  while ((m = re.exec(String(text || "")))) {
    if (seen[m[0]]) continue;
    seen[m[0]] = 1;
    await extractDailymotion(m[0], referer, out);
  }
}

/** Extrae los streams de un post de episodio/pelicula. */
async function episodeStreams(episodeUrl) {
  var out = newEmit();
  var start = (typeof _t0 === "number" && _t0 > 0) ? _t0 : Date.now();

  // 1) content del post via feed ?path= (~40 KB frente a ~800 KB de la pagina).
  var content = "";
  var path = String(episodeUrl).replace(BASE, "").split("?")[0].split("#")[0];
  var feed = await fetchFeed(BASE + FEED + "?alt=json&path=" + encodeURIComponent(path));
  for (var i = 0; i < feed.entries.length; i++) {
    if (entryLink(feed.entries[i]) === episodeUrl) { content = entryContent(feed.entries[i]); break; }
  }
  var servers = parseServers(content);

  // 2) respaldo: la pagina completa (por si el feed no trae el post).
  var html = "";
  if (!servers.length) {
    html = await fetchText(episodeUrl, { referer: BASE + "/" });
    servers = parseServers(html);
  }

  var tried = 0;
  for (var s = 0; s < servers.length; s++) {
    if (tried >= 6 || out.streams.length >= 4) break;
    if (Date.now() - start > BUDGET_MS) { log("presupuesto agotado en servidores"); break; }
    tried++;
    try {
      await routeEmbed(servers[s].url, BASE + "/", "Dailymotion (" + servers[s].label + ")", out);
    } catch (e) {
      log("servidor fallo (" + servers[s].label + "): " + (e && e.message));
    }
  }
  if (!out.streams.length) await geoPlayers(content || html, BASE + "/", out);
  return finishEmit(out);
}

var SITE = {
  id: "donghuazone",
  name: "DonghuaZone",
  base: BASE,
  aliases: ALIASES,
  search: searchSite,
  episodes: seriesEpisodes,
  streams: episodeStreams,
  seasonOfUrl: seasonOfUrl,
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
    findSeries: function (titles, season) { return findSeries(SITE, titles, season); },
    seriesEpisodes: seriesEpisodes,
    episodeStreams: episodeStreams,
    parseServers: parseServers,
    labelFromEpisode: labelFromEpisode
  }
};