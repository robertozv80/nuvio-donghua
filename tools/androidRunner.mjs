#!/usr/bin/env node
/**
 * AndroidRunner para Nuvio TV: captura logcat del emulador durante pruebas
 * de los plugins y consulta el servidor de configuracion local
 * (puerto 8090) para ver/agregar repositorios sin navegar la UI.
 *
 * No instala ni desinstala nada.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const value = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = name => args.includes(name);
const serial = value('--serial', process.env.ANDROID_SERIAL || '');
const pkg = value('--package', process.env.NUVIO_PACKAGE || 'com.nuvio.tv');
const seconds = Number(value('--seconds', process.env.NUVIO_RUN_SECONDS || '20'));
const capture = has('--capture');
const full = has('--full');
const launch = has('--launch');
const output = value('--output', process.env.NUVIO_RUN_OUTPUT || 'androidRunner.log');
const hostPort = Number(value('--port', process.env.NUVIO_HOST_PORT || '18090'));

const adbCandidates = ['adb', `${process.env.LOCALAPPDATA || ''}/Android/Sdk/platform-tools/adb.exe`];
const ADB = process.env.ANDROID_ADB || adbCandidates.find(existsSync) || 'adb';

function adb(adbArgs, allowFailure = false) {
  const fullArgs = [...(serial ? ['-s', serial] : []), ...adbArgs];
  const r = spawnSync(ADB, fullArgs, { encoding: 'utf8' });
  if (r.error) throw new Error(`adb no está disponible: ${r.error.message}`);
  if (r.status !== 0 && !allowFailure) {
    throw new Error(`adb ${fullArgs.join(' ')}\n${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout || '').trim();
}

function summarize(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const relevant = lines.filter(line =>
    /Plugin|seriesdonghua|scrape|repo|manifest|dailymotion|okcdn|rumble|voe|exoplayer|mediacodec|m3u8|subtitle|exception|error|failed|fatal|stream/i.test(line)
  );
  const summaryFile = file.replace(/(\.[^.]+)?$/, '.summary.log');
  writeFileSync(summaryFile, `${relevant.join('\n')}\n`, 'utf8');
  console.log(`SUMMARY: ${summaryFile} (${relevant.length}/${lines.length} líneas relevantes)`);
  return { lines, relevant };
}

function usage() {
  console.log(`Uso: node tools/androidRunner.mjs [opciones]

  --list            lista devices conectados
  --repos           lista repositorios configurados en Nuvio (via puerto 8090)
  --launch          lanza Nuvio (monkey) antes de capturar
  --seconds N       ventana fija de captura (default 20; con --capture se ignora)
  --capture         captura continua hasta Ctrl+C
  --full            captura todos los tags de logcat (recomendado p/diagnóstico)
  --output FILE     archivo de captura (default androidRunner.log)
  --serial SERIAL   device elegido
  --package PKG     package de Nuvio (default com.nuvio.tv)
  --provider ID     añade el tag Plugin:<ID> al filtro de logcat
  --port PORT       puerto host mapeado al 8090 del device (default 18090)`);
}

function hostFetch(path, opts = {}) {
  return spawnSync('curl', ['-s', '-m', '8', ...([]), `http://127.0.0.1:${hostPort}${path}`], { encoding: 'utf8' });
}

async function run() {
  if (has('--help') || has('-h')) { usage(); process.exit(0); }

  if (has('--list')) {
    console.log(adb(['devices', '-l']));
    process.exit(0);
  }

  const state = adb(['get-state'], true);
  if (state !== 'device') throw new Error(`device no listo: ${state || 'sin respuesta'}`);

  if (has('--repos')) {
    adb(['forward', `tcp:${hostPort}`, 'tcp:8090']);
    const r = spawnSync('curl', ['-s', '-m', '8', `http://127.0.0.1:${hostPort}/api/repositories`], { encoding: 'utf8' });
    if (r.error || r.status !== 0) throw new Error('no se pudo consultar el servidor de configuracion (¿app abierta?)');
    console.log(r.stdout || '[]');
    process.exit(0);
  }

  if (launch) {
    console.log('LAUNCH:', adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], true));
  }

  adb(['logcat', '-c']);
  const providerTag = value('--provider', process.env.NUVIO_PROVIDER || '');
  const filter = full ? '*:V'
    : ['*:S', 'PluginManager:D', 'PluginRuntime:D', 'ExoPlayer:D', 'AndroidRunner:D']
      .concat(providerTag ? [`Plugin:${providerTag}:D`] : []).join(' ');
  if (capture) {
    const file = createWriteStream(output, { flags: 'w' });
    const child = spawn(ADB, [...(serial ? ['-s', serial] : []), 'logcat', '-v', 'threadtime', filter], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(file);
    child.stderr.pipe(process.stderr);
    console.log(`CAPTURING: ${output} (${full ? 'FULL' : 'FILTERED'})`);
    console.log('Realiza manualmente la prueba; pulsa Ctrl+C para terminar.');
    const stop = () => {
      child.kill('SIGTERM');
      file.end(() => {
        try { summarize(output); } catch (e) { console.error(`Resumen no generado: ${e.message}`); }
        process.exit(0);
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    child.once('error', error => {
      file.end();
      console.error(`AndroidRunner FAIL: ${error.message}`);
      process.exit(1);
    });
    child.once('exit', code => {
      file.end();
      if (code && code !== 0) process.exit(code);
    });
  } else {
    if (seconds > 0) spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${Math.min(seconds, 300) * 1000})`], { stdio: 'ignore' });
    const r = spawnSync(ADB, [...(serial ? ['-s', serial] : []), 'logcat', '-d', '-v', 'threadtime', filter], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const lines = (r.stdout || '').split(/\r?\n/).filter(Boolean);
    writeFileSync(output, `${lines.join('\n')}\n`, 'utf8');
    const { relevant } = summarize(output);
    const plugin = relevant.filter(l => /Plugin:|PluginRuntime|PluginManager/i.test(l));
    const errors = relevant.filter(l => /exception|error|failed|fatal/i.test(l));
    console.log(`LOGCAT lines=${lines.length} relevant=${relevant.length} plugin=${plugin.length} errors=${errors.length}`);
    if (plugin.length) console.log(`--- plugin ---\n${plugin.slice(-60).join('\n')}`);
    if (errors.length) console.log(`--- errors ---\n${errors.slice(-40).join('\n')}`);
    process.exit(0);
  }
}

run().catch(e => { console.error('AndroidRunner FAIL:', e.message); process.exit(1); });
