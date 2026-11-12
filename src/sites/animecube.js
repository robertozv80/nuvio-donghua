/**
 * AnimeCube (https://animecube.live) - plugin Nuvio TV.
 *
 * Port del provider CloudStream AnimeCubeProvider (repo donghua-ext).
 * SPA Next.js con API JSON propia. Solo interesan BUSQUEDA, EPISODIOS y PLAYER.
 *
 * Contrato verificado en vivo (2026-11):
 *  - Catalogo: /sitemap.xml lista las fichas /anime/<slug>; el home (/) trae el
 *    flight RSC con los titulos reales ("slug":"x",...,"title":"y").
 *  - Ficha: GET /anime/<slug>?_rsc=1 con header RSC:1 devuelve el flight con
 *    "primaryTabs":[{"id":"primary-1","seasons":[{"id":"tab-<ts>","title":
 *    "Season N","episodes":[{"id":"<slug>-tab-<ts>-ep-<N>","number":N,...}]}]}].
 *    La numeracion varia por serie: unas usan numero GLOBAL (Mortal: S2=22..46)
 *    y otras por temporada (Ling Cage: S2=1..12). Se normaliza a absoluto.
 *    Hay pseudo-tabs de titulo vacio con PVs/trailers que se descartan.
 *  - Registro de versiones: GET /api/anime-sources-versions -> {"bySeason":
 *    {"<slug>":{"primary-1":{"tab-<ts>":"<version>"}}}} (o shape plano).
 *  - Fuentes: GET /api/anime/<slug>/episode/<epId>/sources?v=<version>
 *    &primaryTabId=<pt>&seasonId=<se> -> {"sources":[{"platform":"dailymotion",
 *    "privateId":"<idLargo>","videoId":"<idCorto>","quality":"4K",...}]}.
 *
 * IMPORTANTE: la API responde JSON PLANO si NO se envia la cabecera X-Obf.
 * El provider Kotlin descifra AES-GCM cuando se manda X-Obf; CryptoJS 4.2.0 no
 * tiene GCM, asi que aqui se usa siempre la ruta sin X-Obf (verificado en vivo).
 *
 * Reproduccion: Dailymotion (metadata API) y Rumble (embedJS) via core.
 */

var BASE = "https://animecube.live";
var ALIASES = {
  "\u6597\u7f57\u5927\u9646": ["Soul Land", "Combat Continent"],
  "\u541e\u566c\u661f\u7a7a": ["Swallowed Star"],
  "\u5996\u795e\u8bb0": ["Tales of Demons and Gods"],
  "\u9006\u5929\u81f3\u5c0a": ["Against The Sky Supreme"]
};

function R(u) { return absUrl(BASE, u); }

/** Titulo legible a partir del slug (respaldo si el home no lo trae). */
function titleFromSlug(slug) {
  return String(slug || "").replace(/-/g, " ")
    .replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
}

// ==================== catalogo / busqueda ====================

var _catalog = null;   // [{slug,title}] cacheado (el catalogo cambia poco)
var _catalogTs = 0;

/** Une los chunks del flight RSC y desescapa las comillas. */
function unescapeFlight(html) {
  var joined = String(html || "")
    .replace(/"\]<\/script><script>self\.__next_f\.push\(\[1,"/g, "");
  return joined.replace(/\\"/g, '"').replace(/\\u0026/g, "&");
}

/** Catalogo completo: slugs del sitemap + titulos del flight del home. */
async function fetchCatalog() {
  if (_catalog && Date.now() - _catalogTs < 600000) return _catalog;
  var bySlug = {}, order = [];
  // Titulos reales desde el home (flight RSC embebido en el HTML).
  var home = await fetchText(BASE + "/", { headers: { "Accept": "text/html" } });
  var un = unescapeFlight(home);
  var re = /"slug":"([a-z0-9-]+)"[^}]*?"title":"((?:[^"\\]|\\.)*)"/g, m;
  while ((m = re.exec(un))) {
    var t = unescJson(m[2]).trim();
    if (!bySlug[m[1]]) { bySlug[m[1]] = t || titleFromSlug(m[1]); order.push(m[1]); }
  }
  // Slugs autoritativos del sitemap (incluye fichas que el home no liste).
  var sm = await fetchText(BASE + "/sitemap.xml");
  var re2 = /<loc>https?:\/\/[^/]+\/anime\/([a-z0-9-]+)<\/loc>/g, m2;
  while ((m2 = re2.exec(sm))) {
    if (!bySlug[m2[1]]) { bySlug[m2[1]] = titleFromSlug(m2[1]); order.push(m2[1]); }
  }
  var list = [];
  for (var i = 0; i < order.length; i++) list.push({ slug: order[i], title: bySlug[order[i]] });
  if (list.length) { _catalog = list; _catalogTs = Date.now(); }
  return list;
}

/** Busqueda: solo fichas de serie (/anime/<slug>), por titulo o slug. */
async function searchSite(query) {
  var q = norm(query);
  if (!q) return [];
  var cat = await fetchCatalog();
  var dashQ = String(query).trim().toLowerCase().replace(/\s+/g, "-");
  var scored = [], seen = {};
  for (var i = 0; i < cat.length; i++) {
    var it = cat[i];
    var nt = norm(it.title);
    var sc = titleScore(query, it.title);
    var hit = nt.indexOf(q) >= 0 || it.slug.indexOf(dashQ) >= 0 || sc >= 0.6;
    if (!hit) continue;
    var url = R("/anime/" + it.slug);
    if (seen[url]) continue;
    seen[url] = 1;
    scored.push({ title: it.title, url: url, sc: sc });
  }
  scored.sort(function (a, b) { return b.sc - a.sc; });
  var out = [];
  for (var j = 0; j < scored.length; j++) out.push({ title: scored[j].title, url: scored[j].url });
  return out;
}

// ==================== episodios ====================

/**
 * Parsea el flight de la ficha: temporadas (tabs) en orden + episodios.
 * Normaliza la numeracion a ABSOLUTA: si una temporada continua la numeracion
 * de la anterior (min > maxPrevio) es global; si no, es por temporada y se
 * acumula un offset. Descarta pseudo-tabs de titulo vacio (PVs) y colisiones.
 */
function parseEpisodes(flight, slug) {
  var map = {};
  // Cabeceras de temporada en orden de aparicion (id tab-..., title).
  var tabs = [], tabSeen = {};
  var reH = /"id":"(tab-[\w-]+)","number":\d+,"title":"((?:[^"\\]|\\.)*)"/g, mh;
  while ((mh = reH.exec(flight))) {
    if (tabSeen[mh[1]]) continue;
    tabSeen[mh[1]] = 1;
    tabs.push({ id: mh[1], title: unescJson(mh[2]).trim() });
  }
  // Episodios agrupados por tab (el id lleva el tab dentro).
  var byTab = {};
  var reE = /"id":"([a-z0-9-]+)-(tab-[\w-]+)-ep-(\d+(?:-\d+)?)","number":(\d+)/g, me;
  while ((me = reE.exec(flight))) {
    if (me[1] !== slug) continue;
    var epId = me[1] + "-" + me[2] + "-ep-" + me[3];
    var num = parseInt(me[4], 10);
    if (!num) continue;
    if (!byTab[me[2]]) byTab[me[2]] = [];
    byTab[me[2]].push({ num: num, epId: epId });
  }
  // Temporadas reales: las de titulo no vacio; si todas vacias, se quedan todas.
  var real = tabs.filter(function (t) { return t.title && byTab[t.id]; });
  if (!real.length) real = tabs.filter(function (t) { return byTab[t.id]; });
  var offset = 0, prevMax = 0;
  for (var i = 0; i < real.length; i++) {
    var eps = byTab[real[i].id].slice().sort(function (a, b) { return a.num - b.num; });
    var min = eps[0].num, max = eps[eps.length - 1].num;
    // min > prevMax => numeracion global continua; si no => por temporada.
    var global = offset > 0 && min > prevMax;
    var maxKey = 0;
    for (var j = 0; j < eps.length; j++) {
      var key = global ? eps[j].num : offset + eps[j].num;
      if (!map[key]) map[key] = BASE + "/anime/" + slug + "#" + eps[j].epId;
      if (key > maxKey) maxKey = key;
    }
    offset = maxKey; prevMax = maxKey;
  }
  var all = Object.keys(map).map(Number);
  return {
    map: map,
    min: all.length ? Math.min.apply(null, all) : 0,
    max: all.length ? Math.max.apply(null, all) : 0
  };
}

/** Listado de episodios de una ficha: {map:{num:url}, min, max}. */
async function seriesEpisodes(seriesUrl) {
  var slug = String(seriesUrl || "").split("?")[0].split("#")[0].replace(/\/+$/, "").split("/").pop();
  var ts = Date.now();
  var flight = await fetchText(BASE + "/anime/" + slug + "?_rsc=1&_t=" + ts, {
    headers: { "RSC": "1", "Accept": "*/*", "Cache-Control": "no-cache" }
  });
  if (!flight || flight.indexOf("-ep-") < 0) {
    // Respaldo: el HTML trae el mismo flight escapado.
    var html = await fetchText(BASE + "/anime/" + slug + "?_t=" + ts, {
      headers: { "Cache-Control": "no-cache" }
    });
    flight = unescapeFlight(html);
  }
  if (!flight) return { map: {}, min: 0, max: 0 };
  return parseEpisodes(flight, slug);
}

// ==================== versiones / fuentes ====================

/** Registro de versiones (JSON plano, SIN X-Obf). {slug:[{ptId,seId,ver}]}. */
async function fetchRegistry() {
  var out = {};
  var body = await fetchText(BASE + "/api/anime-sources-versions?_t=" + Date.now(), {
    headers: { "Accept": "application/json", "Cache-Control": "no-cache", "Pragma": "no-cache" }
  });
  var j;
  try { j = JSON.parse(body); } catch (e) { log("registry ilegible: " + (e && e.message)); return out; }
  var bySeason = (j && j.bySeason) || {};
  for (var slug in bySeason) {
    if (!Object.prototype.hasOwnProperty.call(bySeason, slug)) continue;
    var perSlug = bySeason[slug] || {};
    var keys = Object.keys(perSlug);
    var entries = [];
    var hasPrimary = keys.some(function (k) { return k.indexOf("primary-") === 0; });
    if (hasPrimary) {
      for (var a = 0; a < keys.length; a++) {
        var pt = keys[a];
        if (pt.indexOf("primary-") !== 0) continue;
        var perPt = perSlug[pt] || {};
        for (var se in perPt) {
          if (!Object.prototype.hasOwnProperty.call(perPt, se)) continue;
          if (se.indexOf("tab-") === 0 && perPt[se]) entries.push({ ptId: pt, seId: se, ver: String(perPt[se]) });
        }
      }
    } else {
      for (var b = 0; b < keys.length; b++) {
        var se2 = keys[b];
        if (se2.indexOf("tab-") === 0 && perSlug[se2]) entries.push({ ptId: "primary-1", seId: se2, ver: String(perSlug[se2]) });
      }
    }
    if (entries.length) out[slug] = entries;
  }
  return out;
}

/** Fuentes de un episodio (JSON plano, SIN X-Obf). [{platform,id,quality}]. */
async function fetchSources(slug, epId, entry) {
  var u = BASE + "/api/anime/" + slug + "/episode/" + epId + "/sources" +
    "?v=" + encodeURIComponent(entry.ver) +
    "&primaryTabId=" + encodeURIComponent(entry.ptId) +
    "&seasonId=" + encodeURIComponent(entry.seId) +
    "&_t=" + Date.now();
  var body = await fetchText(u, {
    headers: { "Accept": "application/json", "Cache-Control": "no-cache", "Pragma": "no-cache" }
  });
  var j;
  try { j = JSON.parse(body); } catch (e) { return []; }
  if (j && j.d) { log("sources cifrado (inesperado sin X-Obf); se omite"); return []; }
  var arr = (j && j.sources) || [];
  var out = [], seen = {};
  for (var i = 0; i < arr.length; i++) {
    var s = arr[i] || {};
    var platform = String(s.platform || "").trim();
    // DM necesita el id LARGO (privateId); el corto responde "contenido privado".
    var id = String(s.privateId || "").trim() || String(s.videoId || "").trim();
    if (!platform || !id) continue;
    var k = platform + "|" + id;
    if (seen[k]) continue;
    seen[k] = 1;
    out.push({ platform: platform, id: id, quality: String(s.quality || "").trim() });
  }
  return out;
}

// ==================== player ====================

/**
 * Streams de un episodio. La URL es sintetica: /anime/<slug>#<epId> donde
 * epId = <slug>-<tabId>-ep-<N>. Tambien acepta el epId desnudo.
 */
async function episodeStreams(episodeUrl) {
  var s = String(episodeUrl || "");
  var frag = s.indexOf("#") >= 0 ? s.substring(s.indexOf("#") + 1) : s;
  var m = /([a-z0-9-]+)-(tab-[\w-]+)-ep-(\d+(?:-\d+)?)/.exec(frag);
  var out = newEmit();
  if (!m) { log("episodeUrl sin epId valido: " + s); return finishEmit(out); }
  var slug = m[1], seId = m[2], epId = m[1] + "-" + m[2] + "-ep-" + m[3];
  var start = (typeof _t0 === "number" && _t0 > 0) ? _t0 : Date.now();

  var registry = await fetchRegistry();
  var entries = registry[slug] || [];
  if (!entries.length) { log("registry sin entradas para " + slug); return finishEmit(out); }
  // Prioriza la temporada exacta del epId.
  entries = entries.slice().sort(function (a, b) {
    return (a.seId === seId ? 0 : 1) - (b.seId === seId ? 0 : 1);
  });

  var sources = [];
  for (var i = 0; i < entries.length && i < 3; i++) {
    sources = await fetchSources(slug, epId, entries[i]);
    if (sources.length) break;
  }
  if (!sources.length) { log("sources vacio para " + epId); return finishEmit(out); }

  for (var k = 0; k < sources.length; k++) {
    if (out.streams.length >= 4) break;
    if (Date.now() - start > BUDGET_MS) { log("presupuesto agotado en fuentes"); break; }
    var src = sources[k];
    try {
      if (src.platform === "dailymotion") {
        await extractDailymotion("https://www.dailymotion.com/embed/video/" + src.id, BASE + "/", out);
      } else if (src.platform === "rumble") {
        await extractRumble("https://rumble.com/embed/" + src.id + "/", BASE + "/", out);
      } else {
        log("platform no soportada: " + src.platform);
      }
    } catch (e) { log("fuente fallo (" + src.platform + "): " + (e && e.message)); }
  }
  return finishEmit(out);
}

var SITE = {
  id: "animecube",
  name: "AnimeCube",
  base: BASE,
  aliases: ALIASES,
  search: searchSite,
  episodes: seriesEpisodes,
  streams: episodeStreams,
  seasonOfUrl: null,
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
    findSeries: function (t, s) { return findSeries(SITE, t, s); },
    seriesEpisodes: seriesEpisodes,
    episodeStreams: episodeStreams,
    parseEpisodes: parseEpisodes,
    fetchRegistry: fetchRegistry,
    fetchSources: fetchSources,
    fetchCatalog: fetchCatalog
  }
};