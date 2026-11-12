/**
 * LmAnime (https://lmanime.com) - plugin Nuvio TV.
 *
 * Port del provider CloudStream LmAnimeProvider (repo donghua-ext).
 * WordPress con tema AnimeStream (familia Tsukuyomi). Solo interesan la
 * BUSQUEDA de serie, el LISTADO de episodios y el PLAYER de un episodio.
 *
 * Contrato verificado en vivo (2026-11):
 *  - Busqueda: GET /?s=<texto> -> cards <article class="bs"> dentro de
 *    .postbody .listupd, con <a href itemprop="url" title="...">. Los cards
 *    pueden apuntar a la ficha (/<slug>/) o a un episodio (/<slug>-episode-N/);
 *    aqui se convierten siempre a la ficha de serie.
 *  - Ficha: GET /<slug>/ -> .eplister li a[href] con .epl-num (numero) y la URL
 *    /<slug>-episode-NN/ (ceros a la izquierda para 1-9). La lista completa
 *    viene en el HTML (Swallowed Star: 249 eps en ~400 KB).
 *  - Episodio: GET /<slug>-episode-N/ -> <select class="mirror"> con una
 *    <option value="https://lmanime.com/<slug>-episode-N/v/K/" > por servidor,
 *    etiquetada por idioma ("English", "Multisub", "Portugues"...).
 *  - Mirror: GET .../v/K/ (referer = episodio) -> #pembed con UN iframe:
 *      Dailymotion (geo.dailymotion.com/player), Rumble, Ok.ru, etc.
 *
 * Prioridad de idiomas (como el Kotlin): Multisub/Espanol primero, luego
 * English, y solo si no hubo streams de ES/EN se prueban el resto.
 *
 * NOTA: el catalogo es donghua; no tiene Naruto/One Piece/Bleach (verificado:
 * /naruto/ da 404 y ?s=naruto devuelve "Not Found").
 */

var BASE = "https://lmanime.com";
var ALIASES = {
  "\u6597\u7f57\u5927\u9646": ["Soul Land", "Combat Continent"],
  "\u541e\u566c\u661f\u7a7a": ["Swallowed Star"],
  "\u5996\u795e\u8bb0": ["Tales of Demons and Gods"],
  "\u9006\u5929\u81f3\u5c0a": ["Against The Sky Supreme"]
};

function R(u) { return absUrl(BASE, u); }

/** Slugs de navegacion que NO son fichas de serie. */
var NAV_SLUGS = {
  "anime-list": 1, "genres": 1, "schedule": 1, "ongoing": 1, "upcoming": 1,
  "bookmarks": 1, "about-us": 1, "support-us": 1, "random": 1, "anime": 1,
  "page": 1, "search": 1, "favorites": 1, "privacy": 1, "terms": 1,
  "contact": 1, "dmca": 1, "home": 1, "completed": 1
};

function titleFromSlug(slug) {
  return String(slug || "").replace(/-/g, " ")
    .replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
}

/** True si la URL es una ficha de serie de un solo segmento (no nav). */
function isSeriesUrl(url) {
  var p = String(url || "").replace(/^https?:\/\/[^/]+/, "").split("?")[0].replace(/\/+$/, "");
  var seg = p.split("/").filter(Boolean);
  if (seg.length !== 1) return false;
  var slug = seg[0];
  if (NAV_SLUGS[slug]) return false;
  return /^[a-z0-9-]+$/i.test(slug);
}

/** Convierte una URL de episodio en la ficha de serie (quita -episode-N). */
function toSeriesUrl(url) {
  return String(url || "").replace(/-episode-\d+\/?$/i, "/");
}

// ==================== busqueda ====================

/** Busqueda: solo fichas de serie. GET /?s=<query>, cards article.bs. */
async function searchSite(query) {
  var q = String(query || "").trim();
  if (!q) return [];
  var html = await fetchText(BASE + "/?s=" + encodeURIComponent(q));
  if (!html) return [];
  var $ = cheerio.load(html);
  var cards = $(".postbody article.bs");
  if (!cards.length) cards = $("article.bs");
  var out = [], seen = {};
  cards.each(function (i, el) {
    var a = el.find("a[href]").first();
    var href = a.attr("href");
    if (!href) return;
    var url = toSeriesUrl(absUrl(BASE, href));
    if (!isSeriesUrl(url)) return;
    var title = a.attr("title") ||
      el.find("h2, h3, .tt, .eggtitle").first().text() ||
      a.find("img").attr("alt") || "";
    title = cleanSeriesTitle(decodeEntities(title)).trim();
    if (!title) {
      var slug = url.replace(/\/+$/, "").split("/").pop();
      title = titleFromSlug(slug);
    }
    if (seen[url]) return;
    seen[url] = 1;
    out.push({ title: title, url: url });
  });
  return out;
}

// ==================== episodios ====================

/** Grid de la ficha: .eplister li a -> {map:{num:url}, min, max}. */
async function seriesEpisodes(seriesUrl) {
  var html = await fetchText(seriesUrl);
  var map = {};
  if (html) {
    var $ = cheerio.load(html);
    $(".eplister li a[href]").each(function (i, el) {
      var href = el.attr("href");
      if (!href || !/-episode-\d+/i.test(href)) return;
      var url = absUrl(BASE, href);
      var n = parseInt(el.find(".epl-num").first().text().trim(), 10);
      if (!n) {
        var mm = /-episode-(\d+)/i.exec(href);
        n = mm ? parseInt(mm[1], 10) : 0;
      }
      if (!n) return;
      if (!map[n]) map[n] = url;
    });
  }
  var all = Object.keys(map).map(Number);
  return {
    map: map,
    min: all.length ? Math.min.apply(null, all) : 0,
    max: all.length ? Math.max.apply(null, all) : 0
  };
}

/**
 * Probe de URL directa /<slug>-episode-<N>/ (patron del sitio, con ceros a la
 * izquierda para 1-9). Evita descargar la ficha en series de una temporada.
 * Devuelve {url, html} con el body ya consumido, o null.
 */
async function probeEpisodeUrl(slug, numbers) {
  slug = String(slug || "").replace(/\/+$/, "");
  for (var i = 0; i < numbers.length; i++) {
    var n = parseInt(numbers[i], 10);
    if (!n || n < 1) continue;
    var pads = [n < 10 ? "0" + n : String(n), String(n)];
    for (var c = 0; c < pads.length; c++) {
      var u = BASE + "/" + slug + "-episode-" + pads[c] + "/";
      var html = await fetchText(u);
      if (html && html.indexOf("mirror") >= 0 && html.indexOf("pembed") >= 0) {
        return { url: u, html: html };
      }
    }
  }
  return null;
}

// ==================== player ====================

/** Prioridad de idioma del mirror (0 = ES/multisub, 1 = EN, 2 = resto). */
function langPrio(label) {
  var l = String(label || "").toLowerCase();
  if (l.indexOf("multi") >= 0) return 0;
  if (l.indexOf("espa") >= 0 || l.indexOf("spanish") >= 0 || l.indexOf("latino") >= 0) return 0;
  if (l.indexOf("english") >= 0 || l.indexOf("ingles") >= 0 || l.indexOf("ingl") >= 0) return 1;
  return 2;
}

function langTag(label) {
  var l = String(label || "").toLowerCase();
  if (l.indexOf("multi") >= 0) return "Multisub";
  if (langPrio(label) === 0) return "Espanol";
  if (langPrio(label) === 1) return "English";
  return label || "Servidor";
}

/** Iframe del reproductor en la pagina del mirror (/v/K/). */
function playerIframes(html) {
  var out = [], seen = {};
  var re = /<iframe[^>]+src="([^"]+)"/g, m;
  while ((m = re.exec(html))) {
    var u = decodeEntities(m[1]).replace(/\\\//g, "/");
    if (u.indexOf("//") === 0) u = "https:" + u;
    if (u.indexOf("http") !== 0) continue;
    if (!/dailymotion|rumble|ok\.ru|odnoklassniki|voe\.|fembed|femedia|freeplayer|filemoon/i.test(u)) continue;
    if (seen[u]) continue;
    seen[u] = 1;
    out.push(u);
  }
  return out;
}

/** Resuelve los mirrors de una pagina de episodio ya descargada. */
async function streamsFromHtml(html, referer) {
  var out = newEmit();
  if (!html) return finishEmit(out);
  var start = (typeof _t0 === "number" && _t0 > 0) ? _t0 : Date.now();
  var $ = cheerio.load(html);
  var mirrors = [];
  $("select.mirror option").each(function (i, el) {
    var v = el.attr("value");
    if (!v) return;
    var label = el.text().trim();
    mirrors.push({ url: absUrl(BASE, v), label: label, prio: langPrio(label) });
  });
  if (!mirrors.length) return finishEmit(out);
  // Orden estable por idioma (mantiene el orden original dentro de cada grupo).
  mirrors.sort(function (a, b) { return a.prio - b.prio; });

  // Dailymotion suele estar restringido (DM008/403); se cuentan aparte para
  // no bloquear el respaldo hacia Rumble/Ok.ru, que si funcionan.
  function nonDm() {
    var n = 0;
    for (var i = 0; i < out.streams.length; i++) if (out.streams[i].title !== "Dailymotion") n++;
    return n;
  }

  var tried = 0;
  async function runPass(maxPrio) {
    tried = 0; // contador por pasada: el respaldo puede explorar mas mirrors
    for (var i = 0; i < mirrors.length; i++) {
      var m = mirrors[i];
      if (m.prio > maxPrio) continue;
      if (nonDm() >= 3 || tried >= 6) return;
      if (Date.now() - start > BUDGET_MS) { log("presupuesto agotado en mirrors"); return; }
      tried++;
      try {
        var page = await fetchText(m.url, { referer: referer });
        var iframes = playerIframes(page);
        for (var k = 0; k < iframes.length; k++) {
          await routeEmbed(iframes[k], referer, langTag(m.label), out);
        }
      } catch (e) { log("mirror fallo (" + m.label + "): " + (e && e.message)); }
    }
  }
  // 1) ES/EN primero; 2) resto si no hubo streams NO-DM (Rumble/Ok.ru).
  await runPass(1);
  if (!nonDm()) await runPass(2);
  return finishEmit(out);
}

/** Extrae los streams de una pagina de episodio. */
async function episodeStreams(episodeUrl, preloaded) {
  var html = preloaded && preloaded.html ? preloaded.html : "";
  if (!html) html = await fetchText(episodeUrl);
  if (!html) return [];
  return await streamsFromHtml(html, episodeUrl);
}

var SITE = {
  id: "lmanime",
  name: "LmAnime",
  base: BASE,
  aliases: ALIASES,
  search: searchSite,
  episodes: seriesEpisodes,
  streams: episodeStreams,
  seasonOfUrl: null,
  episodeUrlFor: probeEpisodeUrl,
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
    probeEpisodeUrl: probeEpisodeUrl,
    streamsFromHtml: streamsFromHtml,
    playerIframes: playerIframes
  }
};