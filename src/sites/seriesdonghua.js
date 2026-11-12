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
