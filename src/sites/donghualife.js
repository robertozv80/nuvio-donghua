/**
 * DonghuaLife (https://donghualife.com) - adaptador JS para Nuvio TV.
 *
 * Port del provider CloudStream DonghuaLifeProvider.kt (proyecto donghua-ext).
 *
 * El sitio es Next.js (App Router): los datos viajan en el payload RSC
 * ("flight"). Con la cabecera "RSC: 1" el servidor responde SOLO con el
 * payload (text/x-component), mucho mas ligero que el HTML completo
 * (40 KB frente a 180 KB en una ficha larga), lo que mantiene el plugin
 * dentro del limite de 1 MB por fetch de Nuvio. Si el servidor ignora esa
 * cabecera se cae al HTML y se decodifica el payload de la pagina.
 *
 *  - Buscador: GET /series?q=<query> -> a.poster-card[href^='/series/']
 *  - Ficha:    GET /series/<slug>  -> "seasons":[{slug,label,episodeCount,...}]
 *  - Episodio: GET /watch/<seasonSlug>-<n> -> "sources":[{label,token,provider}]
 *  - Player:   POST /api/player/source {"token":...} -> {"url":"https://ok.ru/videoembed/..."}
 *  - Servidores: ok.ru, Rumble, Dailymotion (extractores del core).
 *
 * Numeracion: el sitio numera por temporada (1..N dentro de cada una) y
 * TMDB suele fusionar todas las temporadas en S1, asi que el mapa de
 * episodios de este adaptador usa el numero GLOBAL (concatenando las
 * temporadas regulares en el orden de la web), que es lo que espera TMDB.
 */

var BASE = "https://donghualife.com";

/** Alias: titulos con los que la web no responde al titulo de TMDB. */
var ALIASES = {
  "\u541e\u566c\u661f\u7a7a": ["Swallowed Star"],        // 吞嚥星空
  "\u541e\u5665\u661f\u7a7a": ["Swallowed Star"],        // 吞噬星空
  "\u5996\u795e\u8bb0": ["Tales of Demons and Gods"],  // 妖神记
  "\u6597\u7f57\u5927\u9646": ["Soul Land", "Combat Continent"],  // 斗罗大陆
  "\u6597\u7834\u82cd\u7a79": ["Battle Through the Heavens", "DouPo Cangqiong"], // 斗破苍穹
  "\u9006\u5929\u81f3\u5c0a": ["Against The Sky Supreme"] // 逆天至尊
};

function R(u) { return absUrl(BASE, u); }

/** Margen de tiempo propio (el core mata el plugin a los 60 s). */
var DEADLINE = 38000;

/** Cabeceras de navegador: la web esta protegida por Cloudflare. */
var BROWSER_HEADERS = {
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
  "Sec-Ch-Ua": "\"Chromium\";v=\"130\", \"Not_A Brand\";v=\"24\", \"Google Chrome\";v=\"130\"",
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": "\"Windows\"",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1"
};

/** Cabeceras para pedir el payload RSC (flight) en vez del HTML. */
function rscHeaders(url) {
  var h = {};
  for (var k in BROWSER_HEADERS) if (Object.prototype.hasOwnProperty.call(BROWSER_HEADERS, k)) h[k] = BROWSER_HEADERS[k];
  h["RSC"] = "1";
  h["Accept"] = "*/*";
  h["Referer"] = url || BASE + "/";
  return h;
}

/** Cabeceras para pedir el HTML normal. */
function docHeaders(url) {
  var h = {};
  for (var k in BROWSER_HEADERS) if (Object.prototype.hasOwnProperty.call(BROWSER_HEADERS, k)) h[k] = BROWSER_HEADERS[k];
  h["Referer"] = url || BASE + "/";
  return h;
}

// ==================== payload RSC ====================

/** Des-escape del contenido de un push de Next.js (mismo orden que el Kotlin). */
function unescapePush(s) {
  return String(s || "")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&");
}

/**
 * Convierte la respuesta de la web en el texto del payload RSC.
 * - HTML: se concatenan los self.__next_f.push([1,"..."]).
 * - Flight (cabecera RSC: 1): se concatenan las filas "<id>:<contenido>".
 * En ambos casos el texto resultante tiene el mismo formato (el Kotlin
 * aplica los mismos regex sobre el payload decodificado).
 */
function decodePayload(text) {
  if (!text) return "";
  if (text.indexOf("self.__next_f.push") >= 0) {
    var re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
    var m, all = "";
    while ((m = re.exec(text))) all += unescapePush(m[1]);
    return all;
  }
  var lines = text.split("\n"), out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || line.indexOf(":") <= 0) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** Descarga el payload RSC de una pagina (con respaldo al HTML completo). */
async function fetchPayload(url) {
  var txt = await fetchText(url, { headers: rscHeaders(url) });
  var payload = decodePayload(txt);
  if (payload && (payload.indexOf("\"seasons\":[") >= 0 ||
    payload.indexOf("\"sources\":[") >= 0 ||
    payload.indexOf("\"seriesSlug\"") >= 0)) return payload;
  // Respaldo: el servidor ignoro "RSC: 1" -> HTML completo.
  var html = await fetchText(url, { headers: docHeaders(url) });
  var p2 = decodePayload(html);
  if (p2 && p2.length > payload.length) return p2;
  return payload || p2;
}

// ==================== parsers del payload ====================

/** Texto del array JSON que empieza en el indice dado (la '['). */
function balancedArray(text, start) {
  var depth = 0, inStr = false, esc = false;
  for (var i = start; i < text.length; i++) {
    var ch = text.charAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) return text.substring(start + 1, i); }
  }
  return text.substring(start + 1);
}

/** Objetos de primer nivel de un array JSON (sin arrays anidados sueltos). */
function splitTopObjects(arrText) {
  var out = [], depth = 0, start = -1, inStr = false, esc = false;
  for (var i = 0; i < arrText.length; i++) {
    var ch = arrText.charAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && start >= 0) { out.push(arrText.substring(start, i + 1)); start = -1; }
    }
  }
  return out;
}

/**
 * Temporadas de la ficha: "seasons":[{id,slug,label/name,isSpecial,
 * episodeCount,initialEpisodes:[{number}]}].
 * La ficha solo trae initialEpisodes de la primera temporada; el resto se
 * deduce de episodeCount (numeracion 1..N dentro de cada temporada).
 */
function parseSeasons(payload) {
  var seasons = [];
  var i = payload.indexOf("\"seasons\":[");
  if (i < 0) return seasons;
  var arrText = balancedArray(payload, i + 10);
  var objs = splitTopObjects(arrText);
  for (var k = 0; k < objs.length; k++) {
    var o = objs[k];
    if (o.charAt(0) !== "{") continue;
    var slug = /"slug":"([^"]+)"/.exec(o);
    if (!slug) continue;
    var label = /"(?:label|name)":"([^"]*)"/.exec(o);
    var special = /"isSpecial":(true|false)/.exec(o);
    var count = /"episodeCount":(\d+)/.exec(o);
    var numbers = [];
    var ini = /"initialEpisodes":\[([^\]]*)\]/.exec(o);
    if (ini) {
      var re = /"number":(\d+)/g, m;
      while ((m = re.exec(ini[1]))) numbers.push(parseInt(m[1], 10));
    } else {
      // Variante de la pagina de watch: "episodes":[{"id":...},...]
      var eps = /"episodes":\[([^\]]*)\]/.exec(o);
      if (eps) {
        var re2 = /\{"id":/g;
        while (re2.exec(eps[1])) numbers.push(numbers.length + 1);
      }
    }
    seasons.push({
      slug: slug[1],
      label: label ? label[1] : "",
      isSpecial: special ? special[1] === "true" : false,
      count: count ? parseInt(count[1], 10) : numbers.length,
      numbers: numbers
    });
  }
  return seasons;
}

/** Fuentes de reproduceccion: "sources":[{id,label,name,token,provider,type}]. */
function parseSources(payload) {
  var out = [];
  var i = payload.indexOf("\"sources\":[");
  if (i < 0) return out;
  var objs = splitTopObjects(balancedArray(payload, i + 10));
  for (var k = 0; k < objs.length; k++) {
    var o = objs[k];
    if (o.charAt(0) !== "{") continue;
    var id = /"id":"([^"]*)"/.exec(o);
    var label = /"label":"([^"]*)"/.exec(o);
    var name = /"name":"([^"]*)"/.exec(o);
    var token = /"token":"([^"]*)"/.exec(o);
    var provider = /"provider":"([^"]*)"/.exec(o);
    var type = /"type":"([^"]*)"/.exec(o);
    var working = /"isWorking":(true|false)/.exec(o);
    var priority = /"priority":(\d+)/.exec(o);
    if (working && working[1] === "false") continue;
    out.push({
      id: id ? id[1] : "",
      label: (label ? label[1] : "") || (name ? name[1] : "") || "Servidor",
      name: name ? name[1] : "",
      token: token ? token[1] : "",
      provider: provider ? provider[1] : "",
      type: type ? type[1] : "",
      priority: priority ? parseInt(priority[1], 10) : 99
    });
  }
  // "R2" (CMAF avc1 que se ve negro en algunos equipos) al final.
  out.sort(function (a, b) {
    var ar = /r2/i.test(a.label) ? 1 : 0, br = /r2/i.test(b.label) ? 1 : 0;
    if (ar !== br) return ar - br;
    return a.priority - b.priority;
  });
  return out;
}

// ==================== busqueda ====================

var _searchCache = {};

/** Buscador del sitio: /series?q=<query> (tarjetas a.poster-card). */
async function searchSite(query) {
  var q = String(query || "").trim();
  if (!q) return [];
  if (_searchCache[q]) return _searchCache[q];
  var url = BASE + "/series?q=" + encodeURIComponent(q);
  var html = await fetchText(url, { headers: docHeaders(url) });
  var cards = [];
  if (html) {
    try {
      var $ = cheerio.load(html);
      $("a.poster-card").each(function (i, el) {
        var card = $(el);
        var href = card.attr("href");
        if (!href || href.indexOf("/series/") !== 0) return;
        var title = (card.find("img").first().attr("alt") || "").trim();
        if (!title) title = (card.find("p").first().text() || "").trim();
        if (!title) return;
        cards.push({ title: title, url: R(href) });
      });
    } catch (e) {
      log("busqueda: fallo al parsear tarjetas: " + (e && e.message));
    }
  }
  _searchCache[q] = cards;
  return cards;
}

/** La ficha del sitio cubre todas sus temporadas: no hay temporada en la URL. */
function seasonOfUrl(url) {
  return null;
}

// ==================== episodios ====================

var _seriesCache = {};

/** Contexto de la peticion en curso (id TMDB) para alinear temporadas. */
var CTX = { tmdbId: "", flatTotal: 0 };

/**
 * Total de episodios de la temporada plana de TMDB (el site fusiona todas
 * las temporadas en S1, asi que el total es la suma de sus temporadas).
 */
async function tmdbFlatTotal() {
  if (CTX.flatTotal) return CTX.flatTotal;
  var key = (typeof TMDB_API_KEY !== "undefined") ? TMDB_API_KEY : "";
  if (!CTX.tmdbId || !key) return 0;
  try {
    var res = await fetch("https://api.themoviedb.org/3/tv/" + CTX.tmdbId + "?api_key=" + key, { headers: baseHeaders() });
    var j = await res.json();
    var total = 0;
    (j.seasons || []).forEach(function (s) {
      if ((s.season_number || 0) > 0) total += s.episode_count || 0;
    });
    CTX.flatTotal = total;
  } catch (e) {
    log("TMDB total fallo: " + (e && e.message));
  }
  return CTX.flatTotal;
}

/**
 * Datos de la ficha: temporadas + slug de la serie (con cache).
 * "total" = episodios regulares en total; "offset" = desplazamiento para
 * que el mapa use la numeracion global de TMDB (0 si la web tiene todas las
 * temporadas desde la primera).
 */
async function getSeriesData(seriesUrl) {
  var key = String(seriesUrl || "");
  if (!key) return null;
  if (_seriesCache[key]) return _seriesCache[key];
  var payload = await fetchPayload(key);
  var seasons = parseSeasons(payload);
  var data = {
    seasons: seasons,
    seriesSlug: (/\"seriesSlug\":\"([^\"]+)\"/.exec(payload) || [])[1] || "",
    total: 0,
    offset: 0
  };
  for (var i = 0; i < seasons.length; i++) {
    var s = seasons[i];
    if (s.isSpecial || !s.slug) continue;
    data.total += (s.numbers && s.numbers.length) ? s.numbers.length : s.count;
  }
  // Numero de la primera temporada regular segun la web ("Temporada 8"...)
  var firstLabel = 0;
  for (var k = 0; k < seasons.length; k++) {
    if (seasons[k].isSpecial || !seasons[k].slug) continue;
    var m = /(\d+)/.exec(seasons[k].label || "");
    firstLabel = m ? parseInt(m[1], 10) : 0;
    break;
  }
  // Si la web solo tiene las ULTIMAS temporadas ("Temporada 8", 9, 10...) los
  // numeros de TMDB van desplazados: se alinea por la cola.
  if (firstLabel > 1 && data.total > 0) {
    var flat = await tmdbFlatTotal();
    if (flat > data.total) data.offset = flat - data.total;
  }
  if (data.seasons.length) _seriesCache[key] = data;
  return data;
}

/**
 * Mapa de episodios con numeracion GLOBAL: el sitio numera por temporada
 * (1..N) y TMDB fusiona las temporadas en S1, asi que se concatenan las
 * temporadas regulares en el orden de la web (los especiales se saltan:
 * en TMDB van a S0).
 */
async function seriesEpisodes(seriesUrl) {
  var map = {};
  var data = await getSeriesData(seriesUrl);
  if (data) {
    var num = 0;
    for (var i = 0; i < data.seasons.length; i++) {
      var s = data.seasons[i];
      if (s.isSpecial || !s.slug) continue;
      var numbers = (s.numbers && s.numbers.length) ? s.numbers.slice(0) : null;
      if (!numbers) {
        numbers = [];
        for (var k = 1; k <= s.count; k++) numbers.push(k);
      }
      for (var j = 0; j < numbers.length; j++) {
        num++;
        map[data.offset + num] = BASE + "/watch/" + s.slug + "-" + numbers[j];
      }
    }
  }
  var nums = Object.keys(map).map(Number);
  return {
    map: map,
    min: nums.length ? Math.min.apply(null, nums) : 0,
    max: nums.length ? Math.max.apply(null, nums) : 0
  };
}

/**
 * URL directa de un episodio cuando cae en la primera temporada (patron
 * /watch/<slugTemporada>-<n>). Solo se acepta el numero EXACTO pedido: si
 * pertenece a otra temporada se devuelve null y el core usa el mapa global
 * de la ficha (que si conoce la numeracion global correcta).
 */
async function episodeUrlFor(slug, numbers) {
  if (!slug) return null;
  var data = await getSeriesData(BASE + "/series/" + slug);
  if (!data || !data.seasons.length) return null;
  var first = null;
  for (var i = 0; i < data.seasons.length; i++) {
    var s = data.seasons[i];
    if (s.isSpecial || !s.slug) continue;
    if (!s.count && !(s.numbers && s.numbers.length)) continue;
    first = s;
    break;
  }
  if (!first) return null;
  var list = numbers || [];
  var n = list[0];
  if (!n || n < 1) return null;
  if (first.numbers && first.numbers.length) {
    if (first.numbers.indexOf(n) >= 0) return { url: BASE + "/watch/" + first.slug + "-" + n };
  } else if (n <= first.count) {
    return { url: BASE + "/watch/" + first.slug + "-" + n };
  }
  return null;
}

// ==================== reproduccion ====================

/**
 * API real del sitio: POST /api/player/source {"token":...} -> {"url":...}.
 * (/api/sources y sus variantes devuelven datos mock de example.com)
 */
async function resolveToken(token, referer) {
  if (!token) return null;
  try {
    var res = await fetch(BASE + "/api/player/source", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": BASE,
        "Referer": referer,
        "Sec-Ch-Ua": BROWSER_HEADERS["Sec-Ch-Ua"],
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin"
      },
      body: JSON.stringify({ token: token })
    });
    var txt = await res.text();
    if (!txt || txt === "{}" || txt.indexOf("example.com") >= 0) return null;
    var m = /"url"\s*:\s*"([^"]+)"/.exec(txt);
    if (!m) return null;
    return R(m[1]);
  } catch (e) {
    log("player/source fallo: " + (e && e.message));
    return null;
  }
}

/** Streams de una pagina de episodio (/watch/<slug>-<n>). */
async function episodeStreams(episodeUrl, preloaded) {
  var out = newEmit();
  var payload = (preloaded && preloaded.payload) ? preloaded.payload : "";
  if (!payload) payload = await fetchPayload(episodeUrl);
  if (!payload) return finishEmit(out);

  var sources = parseSources(payload);
  var start = Date.now();
  for (var i = 0; i < sources.length; i++) {
    if (Date.now() - start > DEADLINE) { log("presupuesto agotado, corte en fuente " + i); break; }
    var s = sources[i];
    var embed = s.token ? await resolveToken(s.token, episodeUrl) : null;
    if (!embed) continue;
    try {
      await routeEmbed(embed, episodeUrl, s.label, out);
    } catch (e) {
      log("embed fallo (" + s.label + "): " + (e && e.message));
    }
  }

  if (!out.streams.length) await extractEmbedsFromHtml(payload, episodeUrl, out, "Servidor");
  return finishEmit(out);
}

/** Pagina de pelicula (/peliculas/<slug>): mismas fuentes con token. */
async function movieStreams(seriesUrl) {
  var out = newEmit();
  var payload = await fetchPayload(seriesUrl);
  if (!payload) return finishEmit(out);
  var sources = parseSources(payload);
  for (var i = 0; i < sources.length; i++) {
    var s = sources[i];
    var embed = s.token ? await resolveToken(s.token, seriesUrl) : null;
    if (!embed) continue;
    try {
      await routeEmbed(embed, seriesUrl, s.label, out);
    } catch (e) {
      log("embed fallo (" + s.label + "): " + (e && e.message));
    }
  }
  if (!out.streams.length) await extractEmbedsFromHtml(payload, seriesUrl, out, "Servidor");
  return finishEmit(out);
}

var SITE = {
  id: "donghualife",
  name: "DonghuaLife",
  base: BASE,
  aliases: ALIASES,
  search: searchSite,
  episodes: seriesEpisodes,
  streams: episodeStreams,
  seasonOfUrl: seasonOfUrl,
  episodeUrlFor: episodeUrlFor,
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
    findSeries: function (t, s) { return findSeries(SITE, t, s); },
    seriesEpisodes: seriesEpisodes,
    episodeStreams: episodeStreams,
    movieStreams: movieStreams,
    parseSeasons: parseSeasons,
    parseSources: parseSources,
    resolveToken: resolveToken,
    episodeUrlFor: episodeUrlFor
  }
};
