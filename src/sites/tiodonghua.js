/**
 * TioDonghua (https://tiodonghua.lat) - plugin Nuvio TV.
 *
 * Port del provider CloudStream TioDonghuaProvider (repo donghua-ext).
 * El sitio es un Next.js con SSR; el API Laravel (tioplayer.cloudlatino.com)
 * queda de RESPALDO. Solo interesan BUSQUEDA, LISTADO y PLAYER.
 *
 *  - Buscador: GET /explorar?q=<query> -> a[href^=/donghua/] con <h3> titulo.
 *    Respaldo: API /api/v1/donghuas?q=.
 *
 *  - Ficha: GET /donghua/<slug> -> a[href^=/ver/<id>] con span "Capitulo N".
 *    La numeracion es GLOBAL (p.ej. Swallowed Star 241-249). El boton hero
 *    "Empezar a Ver (Ep 1)" no trae "Capitulo" y se descarta. Respaldo: API
 *    /api/v1/donghuas/<slug> (seasons[].episodes[]).
 *    LIMITACION del sitio: cada ficha solo publica los episodios cargados en
 *    el backend (Swallowed Star entrega 241-249 de 249); no hay paginacion.
 *
 *  - Episodio: GET /ver/<id>. Los servidores NO estan en el DOM: viajan en el
 *    vuelo de Next (self.__next_f.push) como "episode":{... "sources":[{server:
 *    {name}, embed_url}], "downloads":[...]}. Se parsea el vuelo y se resuelve
 *    cada embed:
 *      Byse (byselapuix.com/e/CODE)  -> API /api/videos/CODE + AES-256-GCM
 *      VIDARA (vidara.to/e/CODE)     -> POST /api/stream {filecode,device}
 *      VidHide (morencius.com/embed) -> HTML empaquetado (Dean Edwards)
 *      VOE / Dailymotion / Rumble / OkRu -> extractores del core
 *    El API /api/v1/episodes/<id> queda de respaldo si el vuelo no trae sources.
 */

var BASE = "https://tiodonghua.lat";
// El sitio cataloga Soul Land (Douluo Dalu) con su titulo ingles alternativo
// "Combat Continent"; TMDB solo aporta "Soul Land"/pinyin, que no matchean.
var ALIASES = {
  "\u6597\u7f57\u5927\u9646": ["Combat Continent", "Combat Continent 2"]
};
var TD_API = "https://tioplayer.cloudlatino.com/api/v1";
var TD_ORIGIN = "https://tiodonghua.lat";
var TD_REFERER = "https://tiodonghua.lat/";

function R(u) { return absUrl(BASE, u); }

// ==================== AES-256-GCM en JS puro ====================
// QuickJS no expone WebCrypto y el CryptoJS global no incluye GCM. AES (solo
// cifrado de bloque para el keystream CTR) + GCM sin verificar tag (el JSON se
// valida al parsear). Verificado contra Node crypto: coincide byte a byte.

function aesRotl8(x, n) { return ((x << n) | (x >>> (8 - n))) & 0xff; }

function aesBuildSbox() {
  var s = new Uint8Array(256), p = 1, q = 1;
  do {
    p = (p ^ (p << 1) ^ ((p & 0x80) ? 0x11b : 0)) & 0xff;
    q = (q ^ (q << 1)) & 0xff;
    q = (q ^ (q << 2)) & 0xff;
    q = (q ^ (q << 4)) & 0xff;
    if (q & 0x80) q ^= 0x09;
    var x = q ^ aesRotl8(q, 1) ^ aesRotl8(q, 2) ^ aesRotl8(q, 3) ^ aesRotl8(q, 4);
    s[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  s[0] = 0x63;
  return s;
}
var AES_SBOX = aesBuildSbox();

function aesXtime(a) { a <<= 1; if (a & 0x100) a ^= 0x11b; return a & 0xff; }

function aesExpandKey(key) {
  var Nk = key.length / 4, Nr = Nk + 6, w = [], i, j;
  for (i = 0; i < Nk; i++) w[i] = [key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]];
  var rcon = 1;
  for (i = Nk; i < 4 * (Nr + 1); i++) {
    var t = w[i - 1].slice();
    if (i % Nk === 0) {
      t = [t[1], t[2], t[3], t[0]];
      for (j = 0; j < 4; j++) t[j] = AES_SBOX[t[j]];
      t[0] ^= rcon; rcon = aesXtime(rcon);
    } else if (Nk > 6 && i % Nk === 4) {
      for (j = 0; j < 4; j++) t[j] = AES_SBOX[t[j]];
    }
    var prev = w[i - Nk];
    w[i] = [prev[0] ^ t[0], prev[1] ^ t[1], prev[2] ^ t[2], prev[3] ^ t[3]];
  }
  return { w: w, Nr: Nr };
}

function aesEncryptBlock(ks, input) {
  var w = ks.w, Nr = ks.Nr, s = new Uint8Array(16), i, r, c, rr;
  for (i = 0; i < 16; i++) s[i] = input[i] ^ w[i >> 2][i & 3];
  for (r = 1; r <= Nr; r++) {
    for (i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
    var t = new Uint8Array(16);
    for (c = 0; c < 4; c++) for (rr = 0; rr < 4; rr++) t[rr + 4 * c] = s[rr + 4 * ((c + rr) % 4)];
    s = t;
    if (r !== Nr) {
      for (c = 0; c < 4; c++) {
        var a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
        s[4 * c] = aesXtime(a0) ^ (aesXtime(a1) ^ a1) ^ a2 ^ a3;
        s[4 * c + 1] = a0 ^ aesXtime(a1) ^ (aesXtime(a2) ^ a2) ^ a3;
        s[4 * c + 2] = a0 ^ a1 ^ aesXtime(a2) ^ (aesXtime(a3) ^ a3);
        s[4 * c + 3] = (aesXtime(a0) ^ a0) ^ a1 ^ a2 ^ aesXtime(a3);
      }
    }
    for (i = 0; i < 16; i++) s[i] ^= w[r * 4 + (i >> 2)][i & 3];
  }
  return s;
}

function aesGcmDecrypt(key, iv, payload) {
  var body = payload.subarray(0, payload.length - 16);
  var ks = aesExpandKey(key);
  var counter = new Uint8Array(16);
  for (var i = 0; i < iv.length && i < 12; i++) counter[i] = iv[i];
  counter[15] = 1; // J0
  var out = new Uint8Array(body.length), block = 0;
  for (var off = 0; off < body.length; off += 16) {
    block++;
    var n = block + 1; // primer bloque de datos = J0 + 1
    for (var b = 15; b >= 12; b--) { counter[b] = n & 0xff; n >>>= 8; }
    var ksb = aesEncryptBlock(ks, counter);
    for (var j = 0; j < 16 && off + j < body.length; j++) out[off + j] = body[off + j] ^ ksb[j];
  }
  return out;
}

function b64UrlBytes(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  var bin = atob(s), arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function bytesToStr(bytes) {
  var s = "";
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function byseDecryptPlayback(pb) {
  if (!pb || !pb.key_parts || !pb.iv || !pb.payload) return null;
  var ver = parseInt(pb.version, 10);
  if (!ver) { var vm = /\d+/.exec(String(pb.version || "")); ver = vm ? parseInt(vm[0], 10) : 0; }
  var parts = pb.key_parts, sel = [], idxs = [ver, 31 - ver];
  for (var i = 0; i < idxs.length; i++) {
    var idx = idxs[i];
    if (idx >= 1 && idx <= parts.length && parts[idx - 1]) sel.push(parts[idx - 1]);
  }
  if (!sel.length) sel = parts;
  var keyLen = 0, bufs = [];
  for (i = 0; i < sel.length; i++) { var b = b64UrlBytes(sel[i]); bufs.push(b); keyLen += b.length; }
  if (keyLen !== 16 && keyLen !== 24 && keyLen !== 32) return null;
  var key = new Uint8Array(keyLen), pos = 0;
  for (i = 0; i < bufs.length; i++) { key.set(bufs[i], pos); pos += bufs[i].length; }
  var iv = b64UrlBytes(pb.iv), payload = b64UrlBytes(pb.payload);
  if (payload.length <= 16) return null;
  var plain = aesGcmDecrypt(key, iv, payload);
  try { return JSON.parse(bytesToStr(plain)); } catch (e) { log("byse: playback ilegible"); return null; }
}

/** Embed Byse (byselapuix.com u otro mirror) -> streams HLS. Host generico. */
async function extractByse(embedUrl, out) {
  var m = /^(https?:\/\/[^/]+)\/[ev]\/([a-zA-Z0-9]+)/.exec(embedUrl);
  if (!m) return false;
  var host = m[1], code = m[2];
  var txt = await fetchText(host + "/api/videos/" + code, {
    referer: TD_REFERER,
    headers: {
      "Accept": "application/json",
      "Origin": TD_ORIGIN,
      "X-Embed-Origin": TD_ORIGIN,
      "X-Embed-Referer": TD_REFERER,
      "X-Embed-Parent": TD_REFERER
    }
  });
  if (!txt || txt.indexOf('"playback"') < 0) return false;
  var j;
  try { j = JSON.parse(txt); } catch (e) { return false; }
  var dec = byseDecryptPlayback(j.playback);
  if (!dec || !dec.sources) return false;
  var playerRef = host + "/";
  var found = false;
  for (var i = 0; i < dec.sources.length; i++) {
    var src = dec.sources[i], url = String(src.url || "").trim();
    if (!url || url.indexOf("http") !== 0) continue;
    var isHls = /mpegurl/i.test(src.mime_type || "") || url.indexOf(".m3u8") >= 0;
    if (isHls) {
      if (await tryPlaylist(url, out, "Byse", playerRef)) found = true;
    } else {
      pushStream(out, url, qualityFromHeight(src.height) || "Auto", "Byse", playerRef);
      found = true;
    }
  }
  return found;
}

// ==================== desempaquetador Dean Edwards ====================

function b62val(w, a) {
  var n = 0;
  for (var i = 0; i < w.length; i++) {
    var ch = w.charCodeAt(i), d;
    if (ch >= 48 && ch <= 57) d = ch - 48;
    else if (ch >= 97 && ch <= 122) d = ch - 97 + 10;
    else if (ch >= 65 && ch <= 90) d = ch - 65 + 36;
    else return -1;
    if (d >= a) return -1;
    n = n * a + d;
  }
  return n;
}

function unpackPacked(line) {
  var m = /\}\('([\s\S]*)',(\d+),(\d+),'([\s\S]*)'\.split\('\|'\)/.exec(line);
  if (!m) return "";
  var p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  var a = parseInt(m[2], 10), k = m[4].split("|");
  return p.replace(/\b\w+\b/g, function (w) {
    var idx = b62val(w, a);
    if (idx < 0) return w;
    return (idx < k.length && k[idx]) ? k[idx] : w;
  });
}

function unpackAll(html) {
  var out = "", m, re = /eval\(function\(p,a,c,k,e,[^\r\n]+/g;
  while ((m = re.exec(html))) { var u = unpackPacked(m[0]); if (u) out += "\n" + u; }
  return out;
}

async function extractFromText(text, referer, out, server) {
  var m3u8 = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/.exec(text);
  if (m3u8) return await tryPlaylist(m3u8[0].replace(/\\\//g, "/"), out, server, referer);
  var re = /https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/g, m;
  while ((m = re.exec(text))) {
    var u = m[0].replace(/\\\//g, "/");
    if (isJunkVideoUrl(u)) continue;
    pushStream(out, u, "Auto", server, referer);
    return true;
  }
  return false;
}

// ==================== vuelo de Next ====================

/** Concatena los self.__next_f.push([1,"..."]) y desescapa el JSON. */
function tdFlight(html) {
  if (html.indexOf("__next_f") < 0) return "";
  var open = 'self.__next_f.push([1,"', close = '"])', sb = [], idx = 0;
  while (true) {
    var s = html.indexOf(open, idx);
    if (s < 0) break;
    var start = s + open.length, j = start, esc = false;
    while (j < html.length) {
      var ch = html.charAt(j);
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"' && html.substr(j, close.length) === close) break;
      j++;
    }
    sb.push(html.substring(start, Math.min(j, html.length)));
    idx = j + close.length;
  }
  return sb.join("\n").replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\n/g, "\n").replace(/\\u0026/g, "&");
}

/** Subcadena JSON balanceada (objeto o array) tras la primera clave dada. */
function jsonBlock(text, key, openCh, closeCh) {
  var i = text.indexOf('"' + key + '"');
  if (i < 0) return null;
  var s = text.indexOf(openCh, i);
  if (s < 0) return null;
  var depth = 0, inStr = false, esc = false;
  for (var k = s; k < text.length; k++) {
    var ch = text.charAt(k);
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === openCh) depth++;
      else if (ch === closeCh) { depth--; if (depth === 0) return text.substring(s, k + 1); }
    }
  }
  return null;
}

function parseJsonBlock(text, key, openCh, closeCh) {
  var b = jsonBlock(text, key, openCh, closeCh);
  if (!b) return null;
  try { return JSON.parse(b); } catch (e) { return null; }
}

// ==================== busqueda ====================

function cleanTitle(t) {
  return String(t || "").replace(/\s*Sub\s*Espa[nñ]ol\s*$/i, "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

async function searchSite(query) {
  var out = [], seen = {};
  var html = await fetchText(BASE + "/explorar?q=" + encodeURIComponent(query));
  if (html) {
    var $ = cheerio.load(html);
    $("a[href^='/donghua/']").each(function (i, el) {
      var href = el.attr("href") || "";
      var slug = href.split("/donghua/")[1];
      if (!slug) return;
      slug = slug.split("?")[0].replace(/\/+$/, "");
      var title = cleanTitle(el.find("h3").text() || el.find("img").attr("alt") || "");
      if (!title || !slug) return;
      var u = BASE + "/donghua/" + slug;
      if (seen[u]) return;
      seen[u] = 1;
      out.push({ title: title, url: u });
    });
  }
  if (!out.length) out = await searchApi(query);
  return out;
}

/** Respaldo del buscador con el API Laravel. */
async function searchApi(query) {
  var out = [], seen = {};
  var txt = await fetchText(TD_API + "/donghuas?q=" + encodeURIComponent(query), { headers: { "Accept": "application/json" } });
  var j;
  try { j = JSON.parse(txt); } catch (e) { return out; }
  var list = (j && j.data) || [];
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a || !a.slug || !a.title) continue;
    var u = BASE + "/donghua/" + a.slug;
    if (seen[u]) continue;
    seen[u] = 1;
    out.push({ title: cleanTitle(a.title), url: u });
  }
  return out;
}

// ==================== episodios ====================

async function seriesEpisodes(seriesUrl) {
  var map = {};
  var html = await fetchText(seriesUrl);
  if (html) {
    var $ = cheerio.load(html);
    $("a[href^='/ver/']").each(function (i, el) {
      var href = el.attr("href") || "";
      if (!/\/ver\/\d+/.test(href)) return;
      var cm = /Cap[íi]tulo\s*(\d+)/i.exec(el.text());
      if (!cm) return; // boton hero "Empezar a Ver" sin numero
      var n = parseInt(cm[1], 10);
      if (n && !map[n]) map[n] = R(href);
    });
  }
  if (!Object.keys(map).length) {
    var slug = String(seriesUrl).replace(/\/+$/, "").split("/donghua/")[1] || "";
    map = await episodesApi(slug);
  }
  var all = Object.keys(map).map(Number);
  return {
    map: map,
    min: all.length ? Math.min.apply(null, all) : 0,
    max: all.length ? Math.max.apply(null, all) : 0
  };
}

/** Respaldo de episodios con el API: seasons[].episodes[] {id, episode_number}. */
async function episodesApi(slug) {
  var map = {};
  if (!slug) return map;
  var txt = await fetchText(TD_API + "/donghuas/" + slug, { headers: { "Accept": "application/json" } });
  var j;
  try { j = JSON.parse(txt); } catch (e) { return map; }
  var data = (j && j.data) || {};
  var seasons = data.seasons || [];
  for (var i = 0; i < seasons.length; i++) {
    var eps = seasons[i].episodes || [];
    for (var k = 0; k < eps.length; k++) {
      var e = eps[k];
      var n = parseInt(e.episode_number, 10);
      if (n && e.id != null && !map[n]) map[n] = BASE + "/ver/" + e.id;
    }
  }
  return map;
}

// ==================== player ====================

/** Normaliza URLs cortas de descarga al formato canonico del embed. */
function normalizeEmbed(raw) {
  var t = decodeEntities(String(raw || "").replace(/\\\//g, "/")).trim();
  if (t.indexOf("http") !== 0) return "";
  var end = t.search(/["\s]/);
  var url = (end === -1 ? t : t.substring(0, end)).trim();
  if (url.indexOf("dailymotion.com/d/video/") >= 0) url = url.replace("/d/video/", "/embed/video/");
  if (/rumble\.com\/d\/v[a-zA-Z0-9]+/.test(url)) url = url.replace("/d/", "/embed/");
  return url;
}

function serverLabel(url) {
  var m = /^(?:https?:)?\/\/([^/?#]+)/i.exec(String(url || ""));
  var host = m ? m[1].replace(/^www\./, "").split(":")[0] : "";
  if (!host) return "Servidor";
  var first = host.split(".")[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function tdPriority(u) {
  u = String(u || "").toLowerCase();
  if (u.indexOf("byselapuix") >= 0 || u.indexOf("byse") >= 0) return 10;
  if (u.indexOf("rumble.com") >= 0) return 9;
  if (u.indexOf("dailymotion") >= 0 || u.indexOf("dai.ly") >= 0) return 8;
  if (u.indexOf("ok.ru") >= 0 || u.indexOf("odnoklassniki") >= 0) return 7;
  if (u.indexOf("vidara") >= 0) return 6;
  if (u.indexOf("morencius") >= 0 || u.indexOf("vidhide") >= 0) return 5;
  if (u.indexOf("voe.") >= 0) return 3;
  return 1;
}

/** VIDARA: POST <host>/api/stream {filecode, device:"web"} -> streaming_url. */
async function extractVidara(embedUrl, out) {
  var m = /^(https?:\/\/[^/]+)\/e\/([a-zA-Z0-9]+)/.exec(embedUrl);
  if (!m) return false;
  var host = m[1], code = m[2];
  var txt = await fetchText(host + "/api/stream", {
    referer: embedUrl,
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ filecode: code, device: "web" })
  });
  var j;
  try { j = JSON.parse(txt); } catch (e) { return false; }
  var stream = String(j.streaming_url || "");
  if (stream.indexOf("http") !== 0) return false;
  var found = false;
  if (stream.indexOf(".m3u8") >= 0) found = await tryPlaylist(stream, out, "VIDARA", embedUrl);
  if (!found) { pushStream(out, stream, "Auto", "VIDARA", embedUrl); found = true; }
  var subs = j.subtitles || [];
  for (var i = 0; i < subs.length; i++) {
    var f = String(subs[i].file || "");
    if (f.indexOf("http") === 0 && !out.subs[f]) {
      out.subs[f] = 1;
      out.subtitles.push({ url: f, language: "es", name: subs[i].label || "Subtitulos" });
    }
  }
  return found;
}

/** VidHide/morencius y similares: HTML empaquetado -> m3u8/mp4. */
async function extractPackedHost(embedUrl, out, name) {
  var html = await fetchText(embedUrl, { referer: TD_REFERER });
  if (!html) return false;
  if (await extractFromText(html, embedUrl, out, name)) return true;
  var unpacked = unpackAll(html);
  if (unpacked && await extractFromText(unpacked, embedUrl, out, name)) return true;
  return false;
}

/** Resuelve un embed de servidor segun su host. */
async function processTdEmbed(embedUrl, name, out) {
  var u = String(embedUrl || "");
  var n = String(name || "").toLowerCase();
  if (n.indexOf("byse") >= 0 || u.indexOf("byselapuix") >= 0 || /byse[a-z0-9]*\.[a-z]+\/[ev]\//.test(u)) {
    return await extractByse(u, out);
  }
  if (n.indexOf("vidara") >= 0 || u.indexOf("vidara") >= 0) {
    return await extractVidara(u, out);
  }
  if (n.indexOf("vidhide") >= 0 || u.indexOf("morencius") >= 0 || u.indexOf("vidhide") >= 0) {
    return await extractPackedHost(u, out, name);
  }
  if (u.indexOf("voe.") >= 0) return await extractVoe(u, TD_REFERER, out);
  return await routeEmbed(u, TD_REFERER, name, out);
}

/** Recoge sources del vuelo (o del API) y los resuelve por prioridad. */
async function streamsFromEpisode(html, epUrl, epId) {
  var out = newEmit();
  var start = (typeof _t0 === "number" && _t0 > 0) ? _t0 : Date.now();
  var flight = tdFlight(html);
  var sources = parseJsonBlock(flight, "sources", "[", "]") || [];
  var downloads = parseJsonBlock(flight, "downloads", "[", "]") || [];
  if (!sources.length && epId) {
    var txt = await fetchText(TD_API + "/episodes/" + epId, { headers: { "Accept": "application/json" } });
    var j;
    try { j = JSON.parse(txt); } catch (e) { j = null; }
    var data = (j && j.data) || j || {};
    sources = data.sources || [];
    downloads = data.downloads || [];
  }
  var servers = [], seen = {};
  function add(list, isDownload) {
    for (var i = 0; i < list.length; i++) {
      var s = list[i] || {};
      var raw = isDownload ? s.url : s.embed_url;
      var embed = normalizeEmbed(raw);
      if (!embed || seen[embed]) continue;
      if (embed.indexOf("/drive/folders/") >= 0 || embed.indexOf("playerp2p") >= 0) continue;
      seen[embed] = 1;
      var name = (s.server && s.server.name) || s.name || serverLabel(embed);
      servers.push({ url: embed, name: name });
    }
  }
  add(sources, false);
  servers.sort(function (a, b) { return tdPriority(b.url) - tdPriority(a.url); });
  for (var i = 0; i < servers.length; i++) {
    if (out.streams.length >= 3) break;
    if (Date.now() - start > BUDGET_MS) { log("presupuesto agotado en servidores"); break; }
    var sv = servers[i];
    try {
      if (await processTdEmbed(sv.url, sv.name, out)) {
        // Byse es el mas fiable (1080p HLS): si responde, no gastar en el resto.
        if (tdPriority(sv.url) >= 10) break;
      }
    } catch (e) { log("servidor fallo (" + sv.name + "): " + (e && e.message)); }
  }
  // Respaldo: descargas sueltas si no salio nada.
  if (!out.streams.length) {
    add(downloads, true);
    for (var d = 0; d < servers.length; d++) {
      if (out.streams.length >= 3 || Date.now() - start > BUDGET_MS) break;
      try { await processTdEmbed(servers[d].url, servers[d].name, out); } catch (e) {}
    }
  }
  // Respaldo final: iframes / m3u8 en la propia pagina.
  if (!out.streams.length && html) {
    var m3u8 = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/.exec(html);
    if (m3u8) await tryPlaylist(m3u8[0], out, "Servidor", epUrl);
  }
  return finishEmit(out);
}

async function episodeStreams(episodeUrl) {
  var m = /\/ver\/(\d+)/.exec(episodeUrl);
  var epId = m ? m[1] : null;
  var epUrl = epId ? BASE + "/ver/" + epId : episodeUrl;
  var html = await fetchText(epUrl);
  if (!html && !epId) return [];
  return await streamsFromEpisode(html || "", epUrl, epId);
}

var SITE = {
  id: "tiodonghua",
  name: "TioDonghua",
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
    tdFlight: tdFlight,
    extractByse: extractByse,
    extractVidara: extractVidara,
    byseDecryptPlayback: byseDecryptPlayback
  }
};