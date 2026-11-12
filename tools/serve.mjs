#!/usr/bin/env node
/**
 * Servidor HTTP estatico del repo para probar los plugins en el emulador/TV
 * sin publicar nada en GitHub. Nuvio acepta repos http (sanitizeScheme) y
 * tiene cleartextTrafficPermitted=true, asi que vale con:
 *
 *   node tools/serve.mjs --port 8099
 *   adb reverse tcp:8099 tcp:8099
 *   -> repo en Nuvio: http://127.0.0.1:8099/manifest.json
 */
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1] || 8099);

const TYPES = {
  ".json": "application/json; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg"
};

createServer((req, res) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = path.resolve(root, "." + (rel.endsWith("/") ? rel + "manifest.json" : rel));
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403).end("fuera del repo");
    return;
  }
  let st;
  try { st = statSync(file); } catch (e) { st = null; }
  if (!st || !st.isFile()) {
    console.log(`404 ${rel}`);
    res.writeHead(404).end("no existe");
    return;
  }
  console.log(`200 ${rel} (${(st.size / 1024).toFixed(1)} KB)`);
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Content-Length": st.size,
    "Cache-Control": "no-store"
  });
  createReadStream(file).pipe(res);
}).listen(port, "0.0.0.0", () => {
  console.log(`repo en http://127.0.0.1:${port}/manifest.json (raiz ${root})`);
});