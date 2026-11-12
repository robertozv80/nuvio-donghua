/**
 * AnimeXin (https://animexin.dev) - plugin Nuvio TV.
 *
 * Port del provider CloudStream AnimeXinProvider (repo donghua-ext).
 * Solo interesan BUSQUEDA de serie, LISTADO de episodios y PLAYER.
 *
 *  - Buscador: GET /?s=<query> (WordPress). Cards: article.bs .bsx a con
 *    atributo title y href a la ficha (/swallowed-star-season-5/). Las cards
 *    de episodio se normalizan a su ficha recortando "-episode-N...".
 *    El titulo se muestra como "X 5" en vez de "X Season 5" para que la
 *    logica de familia de temporadas del core (findSeries) las agrupe.
 *
 *  - Ficha: .eplister li a con .epl-num ("41 [249]" = local [global]) y
 *    .epl-title. El mapa se indexa por numero LOCAL: TMDB fusiona las
 *    temporadas de donghua en S1 y el core (resolveMergedSeasons) recorre
 *    la familia de fichas acumulando maximos.
 *
 *  - Episodio: <select class="mirror"> con <option value="<base64>">. Cada
 *    value decodifica (atob) a un HTML con <iframe src="<embed>">. Hosts:
 *    Dailymotion, Odysee, Ok.ru, Rumble, DoodStream (playmogo & cia),
 *    gdriveplayer, YouTube/Mega/Dtube (no extraibles).
 *
 *  - DoodStream: flujo anonimo pass_md5 (verificado en vivo, NO usa AES):
 *      1) GET /e/<id> -> $.get('/pass_md5/<hash>/<token>')
 *      2) GET /pass_md5/... (Referer: embed, X-Requested-With) -> prefijo
 *      3) URL final = prefijo + 10 chars aleatorios + ?token&expiry (mp4).
 *
 *  - Odysee: el embed es un shell JS pero trae JSON-LD con "contentUrl"
 *    (mp4 directo en player.odycdn.com); tambien "hls"/"videoUrl".
 *
 *  - gdriveplayer: playlist XOR-ofuscada (k="<hex>", b=atob(...)) en el
 *    HTML del embed; decodificada queda HLS="hlsplaylist.php?...m3u8".
 */

var BASE = "https://animexin.dev";

/** Alias: titulo original de TMDB -> titulo con el que lo publica el sitio. */
var ALIASES = {
  "\u541e\u566c\u661f\u7a7a": ["Swallowed Star"],
  "\u5996\u795e\u8bb0": ["Tales of Demons and Gods"],
  "\u6597\u7f57\u5927\u9646": ["Soul Land", "Douluo Dalu"],
  "\u5b8c\u7f8e\u4e16\u754c": ["Perfect World"],
  "\u6597\u7834\u82cd\u7a79": ["Battle Through the Heavens", "BTTH"]
};

function R(u) { return absUrl(BASE, u); }

/** Hosts de DoodStream y sus mirrors (mismo regex que el provider Kotlin). */
var DOOD_HOST = /(?:playmogo|do+od|dsvplay|ds2play|d000d|doply|doodstream)/i;
/** Sufijo de URL de episodio: recortado para casar con el slug de la ficha. */
var EP_SUFFIX = /-episode-\d+(?:-\d+)?[^/]*$/i;

// ==================== busqueda ====================

/** URL de ficha a partir de una card (las de episodio apuntan a /x-episode-N.../). */
function seriesUrlOf(u) {
  var clean = String(u || "").split("?")[0].replace(/\/+$/, "");
  var last = clean.split("/").pop() || "";
  var slug = last.replace(EP_SUFFIX, "");
  if (!slug || slug === last) return clean + "/";
  return clean.substring(0, clean.length - last.length) + slug + "/";
}

/**
 * Titulo de card: limpia "Episode N" y convierte "Season N" en "N" para que
 * findSeries agrupe la familia ("swallowed star", "swallowed star 2", ...).
 */
function displayTitle(t) {
  var s = cleanSeriesTitle(decodeEntities(String(t || "")));
  s = s.replace(/\bseason\s+(\d+)\b/i, "$1").replace(/\s+/g, " ").trim();
  return s || String(t || "").trim();
}

/** Numero de temporada a partir de la URL de la ficha (-season-5). */
function seasonOfUrl(u) {
  var m = /-season-(\d+)(?:\/|$)/i.exec(String(u || ""));
  return m ? parseInt(m[1], 10) : null;
}

/** Buscador WordPress del sitio. Devuelve solo fichas de serie. */
async function searchSite(query) {
  var out = [], seen = {};
  var html = await fetchText(BASE + "/?s=" + encodeURIComponent(query), { referer: BASE + "/" });
  if (!html) return out;
  var $ = cheerio.load(html);
  $("article.bs").each(function (i, el) {
    var a = $(el).find("a").first();
    var href = a.attr("href");
    if (!href) return;
    var title = a.attr("title") || $(el).find("h2").first().text() ||
      $(el).find("img").first().attr("alt") || "";
    title = displayTitle(title);
    if (!title) return;
    var url = seriesUrlOf(href);
    if (seen[url]) return;
    seen[url] = 1;
    out.push({ title: title, url: url });
  });
  return out;
}

// ==================== episodios ====================

/** Grid de la ficha (.eplister): {map:{numLocal:url}, min, max}. */
async function seriesEpisodes(seriesUrl) {
  var map = {};
  var html = await fetchText(seriesUrl, { referer: BASE + "/" });
  if (html) {
    var raw = [];
    var $ = cheerio.load(html);
    $(".eplister li a").each(function (i, el) {
      var href = $(el).attr("href");
      if (!href || !/-episode-\d+/i.test(href)) return;
      // La URL es autoritativa: "-episode-<local>-<global>-..." (el texto
      // .epl-num a veces solo trae el global: "181" para el local 51).
      var n = 0, g = 0;
      var mu = /-episode-(\d+)(?:-(\d+))?/i.exec(href);
      if (mu) { n = parseInt(mu[1], 10); g = parseInt(mu[2], 10) || 0; }
      if (!n) {
        var txt = String($(el).find(".epl-num").text() || "");
        n = parseInt(txt, 10);
        g = parseInt((/\[(\d+)\]/.exec(txt) || [])[1], 10) || 0;
      }
      if (n) raw.push({ n: n, g: g, url: R(href) });
    });
    // El sitio a veces repite el numero local por error tipografico (p.ej.
    // "30 [238]" y "30 [239]"): si hay global [g], el local real es g - offset
    // (offset constante de la temporada, medido en la primera entrada).
    var offset = null;
    for (var i = 0; i < raw.length; i++) {
      if (raw[i].g) { offset = raw[i].g - raw[i].n; break; }
    }
    for (var j = 0; j < raw.length; j++) {
      var e = raw[j];
      var key = e.n;
      if (e.g && offset != null && e.g - offset >= 1) key = e.g - offset;
      if (!map[key]) map[key] = e.url;
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
 * Probe de URL directa: NO es posible en este sitio. El slug del episodio
 * combina numero local, global y un sufijo variable ("-episode-41-249-
 * indonesia-english-sub", "-episode-1-subbed", ...). Devolver null deja que
 * el core use el grid de la ficha y resolveMergedSeasons (TMDB fusiona las
 * temporadas de donghua en S1 y el sitio las separa en fichas).
 */
async function episodeUrlFor(slug, numbers) { return null; }

// ==================== extractores propios ====================

/**
 * DoodStream (playmogo.com & mirrors) via pass_md5. Verificado en vivo:
 * prefijo + 10 chars aleatorios + "?token=<token>&expiry=<ms>" -> mp4 206.
 */
async function extractDood(embedUrl, referer, out) {
  var html = await fetchText(embedUrl, { referer: referer });
  if (!html) return false;
  var m = /\/pass_md5\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/.exec(html);
  if (!m) return false;
  var origin = (/^https?:\/\/[^/]+/.exec(embedUrl) || [""])[0];
  if (!origin) return false;
  var base = (await fetchText(origin + m[0], {
    referer: embedUrl,
    headers: { "X-Requested-With": "XMLHttpRequest" }
  })).trim();
  if (!base || base.indexOf("http") !== 0) return false;

  // Pistas VTT multi-idioma expuestas en la pagina (los data: son placeholders).
  var re = /\{src:'([^']+)',\s*label:'([^']*)',kind:'captions',srclang:'([^']*)'\}/g, sm;
  while ((sm = re.exec(html))) {
    var raw = sm[1];
    if (raw.indexOf("data:") === 0) continue;
    var su = raw.indexOf("//") === 0 ? "https:" + raw : raw;
    if (su.indexOf("http") !== 0 || out.subs[su]) continue;
    out.subs[su] = 1;
    out.subtitles.push({
      url: su,
      language: (sm[3] || "es").substring(0, 2),
      name: sm[2].trim() || "Subtitle"
    });
  }

  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  var rnd = "";
  for (var i = 0; i < 10; i++) rnd += chars.charAt(Math.floor(Math.random() * chars.length));
  var finalUrl = base + rnd + "?token=" + m[2] + "&expiry=" + Date.now();
  pushStream(out, finalUrl, "Auto", "Dood", origin + "/");
  return true;
}

/**
 * Odysee: el embed actual es un shell JS con JSON-LD ("contentUrl", mp4 en
 * player.odycdn.com). Ese mp4 exige credenciales de edge (401 sin ellas), asi
 * que se valida con un Range GET antes de emitir; la API de Odysee pide
 * firma de sesion y no es replicable. Los campos "hls"/"videoUrl" del embed
 * antiguo se siguen aceptando. Espejo secundario: el primary es Dailymotion.
 */
async function extractOdysee(embedUrl, referer, out) {
  var html = await fetchText(embedUrl, { referer: referer });
  if (!html) return false;
  var found = false;
  // El JSON-LD del embed actual trae espacios tras ":" ("contentUrl": "...").
  var re = /"hls"\s*:\s*"(https:[^"]+?\.m3u8[^"]*)"/g, m;
  while ((m = re.exec(html))) {
    if (await tryPlaylist(unescJson(m[1]), out, "Odysee", "https://odysee.com/")) found = true;
  }
  if (!found) {
    var re2 = /"(?:videoUrl|contentUrl)"\s*:\s*"(https:[^"]+?\.mp4[^"]*)"/g, m2;
    while ((m2 = re2.exec(html))) {
      var u = unescJson(m2[1]);
      var res = await fetchRaw(u, {
        referer: "https://odysee.com/",
        headers: { "Range": "bytes=0-1023" }
      });
      var ok = res && (res.status === 200 || res.status === 206);
      try { if (res) await res.text(); } catch (e) {}
      if (ok) {
        pushStream(out, u, "Auto", "Odysee", "https://odysee.com/");
        found = true;
      }
    }
  }
  return found;
}

/**
 * gdriveplayer.to (JWPlayer): el embed esconde la playlist tras XOR.
 * k="<hex>" (se usa como texto latin1, NO se hex-decodifica), b=atob("..."),
 * o[i] = b[i] ^ k[i % k.len]. En el JS resultante: HLS="...m3u8".
 */
async function extractGdrive(embedUrl, referer, out) {
  var html = await fetchText(embedUrl, { referer: referer });
  if (!html) return false;
  var re = /<script>([\s\S]*?)<\/script>/g, m, script = null;
  while ((m = re.exec(html))) {
    if (m[1].indexOf("atob(") >= 0 && m[1].indexOf('k="') >= 0) { script = m[1]; break; }
  }
  if (!script) return false;
  var key = (/k="([0-9a-f]+)"/.exec(script) || [])[1];
  var b64 = (/atob\("([^"]+)"\)/.exec(script) || [])[1];
  if (!key || !b64) return false;
  var raw;
  try { raw = atob(b64); } catch (e) { return false; }
  var decoded = "";
  for (var i = 0; i < raw.length; i++) {
    decoded += String.fromCharCode(raw.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  decoded = decoded.replace(/\\\//g, "/");
  var hls = (/HLS="([^"]+\.m3u8)"/.exec(decoded) || [])[1];
  if (!hls) return false;
  var origin = (/^https?:\/\/[^/]+/.exec(embedUrl) || [""])[0];
  var playlist = hls.indexOf("http") === 0 ? hls : origin + "/" + hls;
  return await tryPlaylist(playlist, out, "Gdrive", embedUrl);
}

// ==================== player ====================

/** Prioridad de cada mirror (menor = antes), igual que el provider Kotlin. */
function mirrorPriority(label) {
  var l = String(label || "").toLowerCase();
  if (l.indexOf("all sub") >= 0) return 0;
  if (l.indexOf("dailymotion") >= 0 && l.indexOf("english") >= 0) return 1;
  if (l.indexOf("dailymotion") >= 0) return 2;
  if (l.indexOf("odysee") >= 0 && l.indexOf("english") >= 0) return 3;
  if (l.indexOf("rumble") >= 0) return 4;
  if (l.indexOf("ok.ru") >= 0) return 5;
  if (l.indexOf("dood") >= 0) return 6;
  if (l.indexOf("odysee") >= 0) return 7;
  return 8;
}

/** Decodifica los <option value=base64> del select.mirror a URLs de embed. */
function collectMirrors(html) {
  var list = [], seen = {};
  var $ = cheerio.load(html);
  $("select.mirror option").each(function (i, el) {
    var b64 = String($(el).attr("value") || "").trim();
    if (b64.length < 20) return;
    var decoded;
    try { decoded = atob(b64); } catch (e) { return; }
    var m = /src=["']([^"']+)["']/.exec(decoded);
    if (!m) return; // p.ej. "Video Not Available" (Streamwish muerto)
    var u = decodeEntities(m[1]).trim();
    if (u.indexOf("//") === 0) u = "https:" + u;
    if (u.indexOf("http") !== 0 || seen[u]) return;
    seen[u] = 1;
    list.push({ url: u, label: $(el).text().trim() });
  });
  list.sort(function (a, b) { return mirrorPriority(a.label) - mirrorPriority(b.label); });
  return list;
}

/** Resuelve los mirrors de una pagina de episodio/pelicula ya descargada. */
async function streamsFromHtml(html, referer) {
  var out = newEmit();
  if (!html) return finishEmit(out);
  // _t0 lo pone runSite; si se llama la pagina suelta (harness) no vale.
  var start = (typeof _t0 === "number" && _t0 > 0) ? _t0 : Date.now();
  var mirrors = collectMirrors(html);
  var tried = 0;
  for (var i = 0; i < mirrors.length; i++) {
    if (tried >= 12 || out.streams.length >= 4) break;
    if (Date.now() - start > BUDGET_MS) { log("presupuesto agotado en mirrors"); break; }
    var mr = mirrors[i];
    var u = mr.url;
    tried++;
    try {
      if (u.indexOf("dailymotion") >= 0) { await extractDailymotion(u, BASE + "/", out); continue; }
      if (u.indexOf("rumble.com") >= 0) { await extractRumble(u, BASE + "/", out); continue; }
      if (DOOD_HOST.test(u)) { await extractDood(u, BASE + "/", out); continue; }
      if (u.indexOf("ok.ru") >= 0) { await extractOkRu(u, BASE + "/", out); continue; }
      if (u.indexOf("odysee.com") >= 0) { await extractOdysee(u, BASE + "/", out); continue; }
      if (u.indexOf("gdriveplayer") >= 0) { await extractGdrive(u, BASE + "/", out); continue; }
      // YouTube/Mega/Dtube: no extraibles de forma fiable sin JS.
      if (u.indexOf("youtube.com") >= 0 || u.indexOf("youtu.be") >= 0 ||
          u.indexOf("mega.nz") >= 0 || u.indexOf("d.tube") >= 0) continue;
      await routeEmbed(u, referer, mr.label || "AnimeXin", out);
    } catch (e) {
      log("mirror fallo (" + mr.label + "): " + (e && e.message));
    }
  }
  if (!out.streams.length) await extractEmbedsFromHtml(html, referer, out, "AnimeXin");
  return finishEmit(out);
}

/** Extrae los streams de una pagina de episodio. */
async function episodeStreams(episodeUrl, preloaded) {
  var html = preloaded && preloaded.html ? preloaded.html : "";
  if (!html) html = await fetchText(episodeUrl, { referer: BASE + "/" });
  if (!html) return [];
  return await streamsFromHtml(html, episodeUrl);
}

/** Las fichas de pelicula llevan los mirrors en la propia pagina. */
async function movieStreams(seriesUrl) {
  return await episodeStreams(seriesUrl);
}

var SITE = {
  id: "animexin",
  name: "AnimeXin",
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
    findSeries: function (titles, season) { return findSeries(SITE, titles, season); },
    seriesEpisodes: seriesEpisodes,
    episodeStreams: episodeStreams,
    movieStreams: movieStreams,
    collectMirrors: collectMirrors,
    extractDood: extractDood,
    extractOdysee: extractOdysee,
    extractGdrive: extractGdrive
  }
};