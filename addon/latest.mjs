// Feeds de "ultimos episodios" de los sitios donghua (fuente de la fila
// "Nuevos episodios" del addon de catalogos). Solo sitios 100% donghua:
// no se mezcla anime japones.
import { execFile } from "node:child_process";
import * as cheerio from "cheerio";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function get(url) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      ["-s", "-m", "30", "-A", UA, "-H", "Accept-Language: es-ES,es;q=0.8", url],
      { maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

const abs = (base, href) => new URL(href, base).toString();

function isoDMY(s, sep) {
  const m = String(s || "").match(new RegExp("(\\d{2})" + sep + "(\\d{2})" + sep + "(\\d{4})"));
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

async function seriesdonghua() {
  const base = "https://seriesdonghua.com";
  let html = await get(base + "/episodios");
  let $ = cheerio.load(html);
  if (!$("article.donghua-card").length) {
    html = await get(base + "/");
    $ = cheerio.load(html);
  }
  const out = [];
  $("article.donghua-card").each((_, el) => {
    const a = $(el).find("a").first();
    const href = a.attr("href");
    const name = $(el).find("h3.card-title").first().text().trim();
    if (!href || !name) return;
    const epBadge = $(el).find(".badge-ep").first().text();
    const ep =
      parseInt((epBadge.match(/(\d+)/) || [])[1], 10) ||
      parseInt((href.match(/-episodio-(\d+)/) || [])[1], 10) ||
      null;
    const dateText = $(el)
      .find(".card-meta span")
      .filter((_, s) => $(s).find(".fa-calendar-alt").length > 0)
      .first()
      .text();
    out.push({
      site: "seriesdonghua",
      title: name,
      episode: ep,
      url: abs(base, href),
      poster: abs(base, $(el).find("img").first().attr("src") || ""),
      date: isoDMY(dateText, "-"),
    });
  });
  return out;
}

async function donghualife() {
  const base = "https://donghualife.com";
  const $ = cheerio.load(await get(base + "/"));
  let scope = $("div.latest-episodes-scroll").first();
  if (!scope.length) scope = $.root();
  const out = [];
  scope.find("a[href^='/watch/']").each((_, el) => {
    const a = $(el);
    const href = a.attr("href");
    const img = a.find("img").first();
    const name =
      a.find("p.line-clamp-2").first().text().trim() || (img.attr("alt") || "").trim();
    if (!href || !name) return;
    const spans = a.find("span");
    let ep = null;
    let date = null;
    spans.each((_, s) => {
      const t = $(s).text().trim();
      const e = t.match(/^EP\s*(\d+)/i);
      if (e) ep = parseInt(e[1], 10);
      const d = isoDMY(t, "/");
      if (d) date = d;
    });
    if (ep == null) ep = parseInt((href.match(/-t\d+-(\d+)$/) || [])[1], 10) || null;
    out.push({
      site: "donghualife",
      title: name,
      episode: ep,
      url: abs(base, href),
      poster: abs(base, img.attr("src") || ""),
      date,
    });
  });
  return out;
}

export const SITES = [
  { id: "seriesdonghua", latest: seriesdonghua },
  { id: "donghualife", latest: donghualife },
];

export async function fetchAllLatest() {
  const results = await Promise.all(
    SITES.map(async (s) => {
      try {
        const rows = await s.latest();
        console.log(`[latest] ${s.id}: ${rows.length} episodios`);
        return rows;
      } catch (e) {
        console.log(`[latest] ${s.id} FALLO: ${e.message}`);
        return [];
      }
    })
  );
  return results.flat();
}