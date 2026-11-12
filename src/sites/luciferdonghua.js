/**
 * LuciferDonghua (https://luciferdonghua.org) - plugin Nuvio TV.
 *
 * Port del provider CloudStream LuciferDonghuaProvider (repo donghua-ext).
 * Tema WordPress "Themesia" (igual que DonghuaWorld). Solo interesan
 * BUSQUEDA, LISTADO de episodios y PLAYER (el Kotlin ademas trae home,
 * ratings y recomendaciones: nada de eso aqui).
 *
 *  - Buscador: GET /?s=<texto>. Cards <article> con a[href] a la ficha
 *    /anime/<slug>/; titulo en .tt / h2 / h3 o a[title].
 *
 *  - Ficha: grid .eplister li a con URLs ...-episode-<N>... El numero se
 *    toma de la URL (el .epl-num del sitio tiene erratas). Las fichas de
 *    temporada pueden numerar en GLOBAL (p.ej. "Swallowed Star Season 4"
 *    lista los episodios 1..165 de toda la serie).
 *
 *  - Episodio: <select class="mirror"> con <option value="<base64>"> que
 *    decodifica a un iframe completo. Servidores: Dailymotion (ENG SUB),
 *    Rumble y Ok.ru -> extractores del core. Prioridad: ENG SUB primero.
 */

var BASE = "https://luciferdonghua.org";

/** Alias: titulo original de TMDB -> titulo con el que lo publica el sitio. */
var ALIASES = {
  "\u6597\u7f57\u5927\u9646": ["Soul Land", "Combat Continent"],
  "\u541e\u566c\u661f\u7a7a": ["Swallowed Star"],
  "\u5996\u795e\u8bb0": ["Tales of Demons and Gods"],
  "\u9006\u5929\u81f3\u5c0a": ["Against The Sky Supreme"]
};

function R(u) { return absUrl(BASE, u); }

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
 * Buscador WordPress del sitio. Devuelve solo fichas de serie
 * (/anime/<slug>/), no posts de episodio ni el catalogo con filtros.
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
    var url = R(href).split("?")[0];
    if (!/\/anime\/[^\/?#]+\/?$/.test(url)) return;
    if (/-episode-\d+/i.test(url)) return;
    if (seen[url]) return;
    // .tt contiene el texto suelto Y un h2 duplicado: se prefiere el h2/h3
    // interior y se colapsan blancos para no arrastrar tabuladores.
    var title = el.find(".tt h2").first().text() || el.find(".tt h3").first().text() ||
      el.find("h2").first().text() || el.find("h3").first().text() ||
      el.find(".tt").first().text() || a.attr("title");
    title = cleanSeriesTitle(decodeEntities(title).replace(/\s+/g, " "));
    if (!title) return;
    // Solo fichas de SERIE: las peliculas ("... Movie ...") empatan o superan
    // a la serie en titleScore y desviarian el match de TMDB tv.
    if (/\bmovie\b/i.test(title) || /\bmovie\b/i.test(url)) return;
    seen[url] = 1;
    out.push({ title: title, url: url });
  });
  // El sitio nombra las temporadas "X Season N" y las secuelas "X N: Subtitulo"
  // (p.ej. "Soul Land 2: The Peerless Tang Sect" es OTRA serie). A igualdad de
  // puntuacion findSeries elige la primera card: las fichas de temporada
  // (-season-N) van primero para no desviar el match hacia secuelas.
  out.sort(function (a, b) {
    var sa = /-season-\d+/i.test(a.url) ? 0 : 1;
    var sb = /-season-\d+/i.test(b.url) ? 0 : 1;
    return sa - sb;
  });
  return out;
}

/** Numero de temporada de la ficha a partir del slug (para findSeries). */
function seasonOfUrl(url) {
  var slug = String(url || "").split("?")[0].replace(/\/+$/, "").split("/").pop() || "";
  var m = /-season-(\d{1,2})(?:-|$)/i.exec(slug);
  if (m) return parseInt(m[1], 10);
  // "soul-land-2-the-peerless-tang-sect" -> 2 (secuela numerada con subtitulo)
  m = /-(\d{1,2})(?=-[a-z])/i.exec(slug);
  if (m) return parseInt(m[1], 10);
  // "soul-land-2" -> temporada 2 (solo 1-2 digitos: evita años "2026")
  m = /-(\d{1,2})$/.exec(slug);
  if (m) return parseInt(m[1], 10);
  return null;
}

// ==================== episodios ====================

/** Grid de la ficha: {map:{num:url}, min, max}. El numero sale de la URL. */
async function seriesEpisodes(seriesUrl) {
  var map = {};
  var html = await fetchText(seriesUrl, { referer: BASE + "/" });
  if (html) {
    var $ = cheerio.load(html);
    $(".eplister li a[href]").each(function (i, el) {
      var href = el.attr("href");
      if (!href) return;
      var url = R(href);
      // la URL es fiable; .epl-num tiene erratas (p.ej. num=56 en el ep 96)
      var m = /-episode-(\d+(?:-\d+)?)/i.exec(url);
      var n = m ? parseInt(m[1], 10) : NaN;
      if (!n) n = parseInt(el.find(".epl-num").first().text(), 10);
      if (!n || map[n]) return;
      map[n] = url;
    });
    // Respaldo: tema sin .eplister -> enlaces de episodio de la propia serie
    // (el slug base sin -season-N; evita los episodios de otras series del
    // widget "Latest Release" de la barra lateral).
    if (!Object.keys(map).length) {
      var baseSlug = String(seriesUrl).split("?")[0].replace(/\/+$/, "").split("/").pop() || "";
      baseSlug = baseSlug.replace(/-season-\d+$/i, "");
      var re = /href="([^"]*-episode-\d+[^"]*)"/g, mm;
      while ((mm = re.exec(html))) {
        var u2 = R(decodeEntities(mm[1]));
        if (baseSlug && u2.indexOf(baseSlug) < 0) continue;
        var m2 = /-episode-(\d+)/i.exec(u2);
        if (!m2) continue;
        var n2 = parseInt(m2[1], 10);
        if (n2 && !map[n2]) map[n2] = u2;
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

// ==================== player ====================

/** Prioridad del mirror (menor = antes): ENG SUB / DM / Rumble / Ok.ru. */
function mirrorPriority(label, src) {
  var l = String(label || "").toLowerCase();
  var u = String(src || "").toLowerCase();
  if (l.indexOf("eng sub") >= 0 || l.indexOf("engsub") >= 0) return 0;
  if (u.indexOf("dailymotion") >= 0 || l.indexOf("dailymotion") >= 0) return 1;
  if (u.indexOf("rumble") >= 0 || l.indexOf("rumble") >= 0) return 2;
  if (u.indexOf("ok.ru") >= 0 || l.indexOf("ok") >= 0) return 3;
  return 4;
}

/**
 * Mirrors de la pagina de episodio: <select class="mirror"> con options cuyo
 * value es un iframe completo en base64. Devuelve [{label, src}] ordenados.
 */
function collectMirrors(html) {
  var list = [], seen = {};
  var sel = /<select[^>]*class="mirror"[\s\S]*?<\/select>/.exec(html);
  var block = sel ? sel[0] : html;
  var re = /<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g, m;
  while ((m = re.exec(block))) {
    var b64 = m[1].trim();
    if (b64.length < 20) continue;
    var decoded = b64ToHtml(b64);
    // el iframe puede venir en MAYUSCULAS (<IFRAME SRC=...>)
    var src = /src=["']([^"']+)["']/i.exec(decoded);
    if (!src) continue;
    var u = decodeEntities(src[1]).replace(/\\\//g, "/");
    if (u.indexOf("//") === 0) u = "https:" + u;
    if (u.indexOf("http") !== 0 || seen[u]) continue;
    seen[u] = 1;
    list.push({ label: stripTags(m[2]) || "Servidor", src: u });
  }
  list.sort(function (a, b) {
    return mirrorPriority(a.label, a.src) - mirrorPriority(b.label, b.src);
  });
  return list;
}

/** Extrae los streams de una pagina de episodio. */
async function episodeStreams(episodeUrl) {
  var html = await fetchText(episodeUrl, { referer: BASE + "/" });
  var out = newEmit();
  if (!html) return finishEmit(out);
  // _t0 lo pone runSite; si se llama la pagina suelta (harness) no vale.
  var start = (typeof _t0 === "number" && _t0 > 0) ? _t0 : Date.now();
  var mirrors = collectMirrors(html);
  var tried = 0;
  for (var i = 0; i < mirrors.length; i++) {
    if (tried >= 6 || out.streams.length >= 3) break;
    if (Date.now() - start > BUDGET_MS) { log("presupuesto agotado en mirrors"); break; }
    var mr = mirrors[i];
    tried++;
    try {
      await routeEmbed(mr.src, episodeUrl, mr.label, out);
    } catch (e) {
      log("mirror fallo (" + mr.label + "): " + (e && e.message));
    }
  }
  // Sin select.mirror (markup nuevo): iframes sueltos y embeds en el HTML.
  if (!out.streams.length) {
    var re2 = /<iframe[^>]*src="([^"]+)"/g, m2;
    while ((m2 = re2.exec(html)) && out.streams.length < 3) {
      var u2 = decodeEntities(m2[1]);
      if (u2.indexOf("//") === 0) u2 = "https:" + u2;
      if (u2.indexOf("http") !== 0) continue;
      try { await routeEmbed(u2, episodeUrl, "Servidor", out); } catch (e) {}
    }
  }
  if (!out.streams.length) await extractEmbedsFromHtml(html, episodeUrl, out, "LuciferDonghua");
  return finishEmit(out);
}

var SITE = {
  id: "luciferdonghua",
  name: "LuciferDonghua",
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
    collectMirrors: collectMirrors,
    seasonOfUrl: seasonOfUrl
  }
};