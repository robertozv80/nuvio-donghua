/**
 * MundoDonghua (https://www.mundodonghua.com) - plugin Nuvio TV.
 *
 * Port del provider CloudStream MundoDonghuaProvider (repo donghua-ext).
 * Solo interesan BUSQUEDA de serie, LISTADO de episodios y PLAYER de episodio.
 *
 *  - Buscador: GET /busquedas/<query> -> div.md-card con h5.md-card-title y
 *    a[href*=/donghua/]. Devuelve solo fichas de serie.
 *
 *  - Ficha: GET /donghua/<slug> -> li.md-episode-item[data-ep] con a.md-ep-link
 *    href="/ver/<slug>/<N>". Todos los episodios van renderizados (sin paginar).
 *    Cada ficha de temporada numera desde 1; el slug termina en -N (temporada).
 *
 *  - Episodio: GET /ver/<slug>/<N>. Los servidores viajan como llamadas eval()
 *    empaquetadas (Dean Edwards) dentro de <script>. Se desempaquetan y se
 *    recogen los embeds. El servidor vivo principal es "fmoon" = bysekoze.com.
 *
 *  - bysekoze.com es una SPA con API propia. GET /api/videos/<code> (cabeceras
 *    de embed de mundodonghua.com) devuelve {playback:{algorithm,iv,payload,
 *    key_parts[],version}} cifrado con AES-256-GCM, SIN captcha ni PoW.
 *    key = b64url(key_parts[version-1]) + b64url(key_parts[30-version]);
 *    payload = ciphertext || tag(16). Se descifra con AES-GCM en JS puro
 *    (QuickJS no tiene WebCrypto y CryptoJS 4.2.0 no trae GCM) -> sources[]
 *    con master.m3u8 (HLS H264+aac). Referer del player: https://bysekoze.com/.
 *    Auditado en vivo: bysekoze 20/20; vgembed/voe/asura/tamamo muertos.
 */

var BASE = "https://www.mundodonghua.com";
var ALIASES = {
  "\u6597\u7f57\u5927\u9646": ["Combat Continent", "Soul Land"],
  "\u541e\u566c\u661f\u7a7a": ["Swallowed Star"],
  "\u5996\u795e\u8bb0": ["Tales of Demons and Gods"],
  "\u9006\u5929\u81f3\u5c0a": ["Against The Sky Supreme"]
};

var BYSE_API = "https://bysekoze.com";
var EMBED_ORIGIN = "https://www.mundodonghua.com";
var EMBED_REFERER = "https://www.mundodonghua.com/";
var PLAYER_REFERER = "https://bysekoze.com/";

function R(u) { return absUrl(BASE, u); }

// ==================== AES-256-GCM en JS puro ====================
// QuickJS no expone WebCrypto y el CryptoJS global no incluye GCM. Se implementa
// AES (solo cifrado de bloque, para el keystream CTR) y se descifra GCM sin
// verificar el tag (el JSON resultante se valida al parsear). Verificado contra
// Node crypto: coincide byte a byte.

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

/** GCM: keystream = AES(inc32(J0)+i); plaintext = ct XOR keystream. */
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

/** Descifra el bloque playback de la API Byse -> objeto {sources:[...]}. */
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

/** Embed bysekoze.com -> streams HLS (API publica + AES-GCM). */
async function extractByse(embedUrl, out) {
  var m = /bysekoze\.com\/[ev]\/([a-zA-Z0-9]+)/.exec(embedUrl);
  if (!m) return false;
  var api = BYSE_API + "/api/videos/" + m[1];
  var txt = await fetchText(api, {
    referer: EMBED_REFERER,
    headers: {
      "Accept": "application/json",
      "Origin": EMBED_ORIGIN,
      "X-Embed-Origin": EMBED_ORIGIN,
      "X-Embed-Referer": EMBED_REFERER,
      "X-Embed-Parent": EMBED_REFERER
    }
  });
  if (!txt || txt.indexOf('"playback"') < 0) return false;
  var j;
  try { j = JSON.parse(txt); } catch (e) { return false; }
  var dec = byseDecryptPlayback(j.playback);
  if (!dec || !dec.sources) return false;
  var found = false;
  for (var i = 0; i < dec.sources.length; i++) {
    var src = dec.sources[i], url = String(src.url || "").trim();
    if (!url || url.indexOf("http") !== 0) continue;
    var isHls = /mpegurl/i.test(src.mime_type || "") || url.indexOf(".m3u8") >= 0;
    if (isHls) {
      if (await tryPlaylist(url, out, "Fm", PLAYER_REFERER)) found = true;
    } else {
      pushStream(out, url, qualityFromHeight(src.height) || "Auto", "Fm", PLAYER_REFERER);
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

/** Desempaqueta una linea eval(function(p,a,c,k,e,d){...}('...',a,c,'...'.split('|'),0,{})). */
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

// ==================== busqueda ====================

async function searchSite(query) {
  var out = [], seen = {};
  var html = await fetchText(BASE + "/busquedas/" + encodeURIComponent(query));
  if (!html) return out;
  var $ = cheerio.load(html);
  $("div.md-card").each(function (i, el) {
    var title = (el.find(".md-card-title").text() || "").trim();
    var href = el.find("a").attr("href") || "";
    if (!title || href.indexOf("/donghua/") < 0) return;
    var u = R(href);
    if (seen[u]) return;
    seen[u] = 1;
    out.push({ title: title, url: u });
  });
  return out;
}

// ==================== episodios ====================

async function seriesEpisodes(seriesUrl) {
  var map = {};
  var html = await fetchText(seriesUrl);
  if (html) {
    var $ = cheerio.load(html);
    $("li.md-episode-item").each(function (i, el) {
      var href = el.find("a.md-ep-link").attr("href") || el.find("a").attr("href") || "";
      if (!href || href.indexOf("/ver/") < 0) return;
      var n = parseInt(el.attr("data-ep"), 10);
      if (!n) { var mm = /\/(\d+)\/?$/.exec(href.split("?")[0]); n = mm ? parseInt(mm[1], 10) : 0; }
      if (n) map[n] = R(href);
    });
  }
  var all = Object.keys(map).map(Number);
  return {
    map: map,
    min: all.length ? Math.min.apply(null, all) : 0,
    max: all.length ? Math.max.apply(null, all) : 0
  };
}

/** Temporada desde el slug: swallowed-star-2 -> 2; base sin numero -> null
 *  (el core premia la ficha base cuando se pide la temporada 1). */
function seasonOfUrl(url) {
  var slug = String(url || "").replace(/\/+$/, "").split("/").pop() || "";
  var m = /-(\d+)$/.exec(slug);
  return m ? parseInt(m[1], 10) : null;
}

/** Probe de URL directa /ver/<slug>/<N>. Devuelve {url, html} con body consumido. */
async function probeEpisodeUrl(slug, numbers) {
  for (var i = 0; i < numbers.length; i++) {
    var n = parseInt(numbers[i], 10);
    if (!n || n < 1) continue;
    var u = BASE + "/ver/" + slug + "/" + n;
    var html = await fetchText(u);
    if (html && (html.indexOf("md-server-tab") >= 0 || html.indexOf("eval(function(p,a,c,k,e") >= 0)) {
      return { url: u, html: html };
    }
  }
  return null;
}

// ==================== player ====================

function serverPriority(u) {
  u = String(u || "").toLowerCase();
  if (u.indexOf("bysekoze.com") >= 0) return 4;
  if (u.indexOf("embedwish.com") >= 0 || u.indexOf("streamwish.to") >= 0) return 3;
  if (u.indexOf("vidhidepro.com") >= 0 || u.indexOf("filemoon") >= 0) return 2;
  return 0;
}

/** Recoge embeds de los eval desempaquetados + HTML crudo, ordenados por prioridad. */
function collectEmbeds(html) {
  var unpacked = "", m;
  var re = /eval\(function\(p,a,c,k,e,[^\r\n]+/g;
  while ((m = re.exec(html))) {
    var u = unpackPacked(m[0]);
    if (u && u.indexOf("eval(function(p,a,c,k,e") < 0) unpacked += "\n" + u;
  }
  var hay = unpacked + "\n" + html;
  var seen = {}, list = [];
  var patterns = [
    /https?:\/\/[^\s"'<>]*bysekoze\.com\/e\/[a-zA-Z0-9]+/g,
    /https?:\/\/[^\s"'<>]*embedwish\.com\/e\/[a-zA-Z0-9]+/g,
    /https?:\/\/[^\s"'<>]*streamwish\.to\/e\/[a-zA-Z0-9]+/g,
    /https?:\/\/[^\s"'<>]*vidhidepro\.com\/[ve]\/[a-zA-Z0-9]+/g,
    /https?:\/\/[^\s"'<>]*filemoon\.to\/e\/[a-zA-Z0-9]+/g,
    /https?:\/\/[^\s"'<>]*vgembed\.com\/e\/[a-zA-Z0-9]+/g,
    /https?:\/\/voe\.sx\/e\/[a-zA-Z0-9]+/g
  ];
  for (var p = 0; p < patterns.length; p++) {
    var mm;
    while ((mm = patterns[p].exec(hay))) {
      var u2 = decodeEntities(mm[0]);
      if (seen[u2]) continue;
      seen[u2] = 1;
      list.push(u2);
    }
  }
  list.sort(function (a, b) { return serverPriority(b) - serverPriority(a); });
  return list;
}

/** m3u8/mp4 sueltos en un texto ya desempaquetado (vidhide/embedwish/filemoon). */
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

/** Resuelve un embed no-Byse: desempaqueta si hace falta y extrae. */
async function resolveOtherEmbed(embedUrl, referer, out) {
  if (embedUrl.indexOf("voe.") >= 0) return await extractVoe(embedUrl, referer, out);
  var html = await fetchText(embedUrl, { referer: referer });
  if (!html) return false;
  if (await extractFromText(html, embedUrl, out, "Servidor")) return true;
  var unpacked = "", m, re = /eval\(function\(p,a,c,k,e,[^\r\n]+/g;
  while ((m = re.exec(html))) { var u = unpackPacked(m[0]); if (u) unpacked += "\n" + u; }
  if (unpacked && await extractFromText(unpacked, embedUrl, out, "Servidor")) return true;
  return await routeEmbed(embedUrl, referer, "Servidor", out);
}

async function streamsFromHtml(html, referer) {
  var out = newEmit();
  if (!html) return finishEmit(out);
  var start = (typeof _t0 === "number" && _t0 > 0) ? _t0 : Date.now();
  var embeds = collectEmbeds(html);
  for (var i = 0; i < embeds.length; i++) {
    if (out.streams.length >= 3) break;
    if (Date.now() - start > BUDGET_MS) { log("presupuesto agotado en embeds"); break; }
    var u = embeds[i];
    try {
      if (u.indexOf("bysekoze.com") >= 0) {
        // Byse es el servidor vivo principal (20/20): si responde, no gastar
        // peticiones en los demas (vgembed/vidhide/voe suelen estar muertos).
        if (await extractByse(u, out)) break;
      } else {
        await resolveOtherEmbed(u, referer, out);
      }
    } catch (e) { log("embed fallo (" + u + "): " + (e && e.message)); }
  }
  return finishEmit(out);
}

async function episodeStreams(episodeUrl, preloaded) {
  var html = preloaded && preloaded.html ? preloaded.html : "";
  if (!html) html = await fetchText(episodeUrl);
  if (!html) return [];
  return await streamsFromHtml(html, episodeUrl);
}

var SITE = {
  id: "mundodonghua",
  name: "MundoDonghua",
  base: BASE,
  aliases: ALIASES,
  search: searchSite,
  episodes: seriesEpisodes,
  streams: episodeStreams,
  seasonOfUrl: seasonOfUrl,
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
    collectEmbeds: collectEmbeds,
    unpackPacked: unpackPacked,
    extractByse: extractByse,
    byseDecryptPlayback: byseDecryptPlayback
  }
};