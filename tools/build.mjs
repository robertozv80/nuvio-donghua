/**
 * Build de los plugins Nuvio TV: src/core.js + src/sites/<id>.js
 * -> providers/<id>.js (archivo autocontenido que Nuvio carga con QuickJS).
 *
 * Uso:
 *   node tools/build.mjs            # todos los sitios
 *   node tools/build.mjs animecube  # solo uno
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corePath = path.join(root, "src", "core.js");
const sitesDir = path.join(root, "src", "sites");
const outDir = path.join(root, "providers");
const manifestPath = path.join(root, "manifest.json");

const core = readFileSync(corePath, "utf8");
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));

const ids = existsSync(sitesDir)
  ? readdirSync(sitesDir).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""))
  : [];

if (!ids.length) {
  console.error("no hay sitios en src/sites");
  process.exit(1);
}

const targets = only.length ? ids.filter((id) => only.includes(id)) : ids;
if (only.length && targets.length !== only.length) {
  const missing = only.filter((id) => !ids.includes(id));
  console.error("sitio desconocido: " + missing.join(", "));
  process.exit(1);
}

for (const id of targets) {
  const sitePath = path.join(sitesDir, id + ".js");
  const site = readFileSync(sitePath, "utf8");
  if (!/module\.exports\s*=/.test(site)) {
    console.error(id + ": el adaptador no define module.exports");
    process.exit(1);
  }
  const name = (/name:\s*"([^"]+)"/.exec(site) || [, id])[1];
  const header =
    "/**\n" +
    " * " + name + " — plugin Nuvio TV (repo nuvio-donghua).\n" +
    " * Archivo GENERADO por tools/build.mjs: no editar a mano.\n" +
    " * Fuentes: src/core.js + src/sites/" + id + ".js\n" +
    " */\n\n";
  const out = header + core + "\n" + site;
  const outPath = path.join(outDir, id + ".js");
  writeFileSync(outPath, out, "utf8");
  console.log("providers/" + id + ".js (" + (out.length / 1024).toFixed(1) + " KB)");
}

// El manifest debe referenciar exactamente los scrapers construidos.
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const declared = new Set((manifest.scrapers || []).map((s) => s.id));
  const built = new Set(ids);
  for (const id of built) {
    if (!declared.has(id)) console.warn("aviso: " + id + " no esta en manifest.json");
  }
  for (const id of declared) {
    if (!built.has(id)) console.warn("aviso: manifest declara " + id + " pero no hay src/sites/" + id + ".js");
  }
}
