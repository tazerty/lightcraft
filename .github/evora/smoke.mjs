#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Evora — test de fumée du moteur web dans Chrome sans interface, depuis une AUTRE origine.
//
// Le site du moteur est servi sur l'origine A (http://127.0.0.1:<port A>), avec la CSP prévue pour
// l'origine moteur (ARCHITECTURE §3.6 : empreintes de csp-hashes.txt, 'wasm-unsafe-eval',
// frame-ancestors limité à B). Une page parente servie sur l'origine B (http://localhost:<port B>,
// autre port et autre site) l'embarque dans une iframe. Le moteur doit s'initialiser : canvas
// dimensionné, écran de chargement retiré, API d'automatisation présente et boucle de frames
// vivante (la commande web.stats répond), sans exception ni erreur de console dans aucune cible
// (page, iframe, workers). Chaque scénario part d'un profil Chrome neuf : la durée mesurée est un
// démarrage à froid.
//
// Pilotage par le protocole DevTools sur tube (--remote-debugging-pipe) : aucune dépendance, aucune
// action tierce, seulement les modules intégrés de Node et le Chrome préinstallé du runner.
//
// Usage : node smoke.mjs --site <dossier> --out <dossier> [--chrome <binaire>] [--timeout <s>]
//                        [--scenario nom=requête]... [--sabotage-csp]
// --sabotage-csp remplace les empreintes par une empreinte fausse : le script inline est bloqué et
// le test DOIT échouer (preuve que la porte sait rougir).
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
  '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
};

function parseArgs(argv) {
  const o = { scenarios: [], timeout: 150, sabotageCsp: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--site') { o.site = v; i += 1; } else if (k === '--out') { o.out = v; i += 1; } else if (k === '--chrome') { o.chrome = v; i += 1; } else if (k === '--timeout') { o.timeout = Number(v); i += 1; } else if (k === '--sabotage-csp') { o.sabotageCsp = true; } else if (k === '--scenario') { const [n, q] = v.split('='); o.scenarios.push({ name: n, query: q || '' }); i += 1; }
  }
  if (o.scenarios.length === 0) o.scenarios = [{ name: 'defaut', query: '' }, { name: 'memoire', query: '?store=memory' }];
  return o;
}

function findChrome(explicit) {
  const candidates = [explicit, process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`Chrome introuvable (essayés : ${candidates.join(', ')})`);
  return found;
}

function listen(server, host) {
  return new Promise((ok, ko) => { server.once('error', ko); server.listen(0, host, () => ok(server.address().port)); });
}

function staticServer(root, headers) {
  const base = resolve(root);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = resolve(base, '.' + rel);
      if (file !== base && !file.startsWith(base + sep)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404');
    }
  });
}

class Cdp {
  constructor(proc) {
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.buf = Buffer.alloc(0);
    this.out = proc.stdio[3];
    proc.stdio[4].on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      for (let i = this.buf.indexOf(0); i >= 0; i = this.buf.indexOf(0)) {
        const text = this.buf.subarray(0, i).toString('utf8');
        this.buf = this.buf.subarray(i + 1);
        if (text) this.dispatch(JSON.parse(text));
      }
    });
  }
  send(method, params = {}, sessionId = undefined) {
    const id = (this.id += 1);
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.out.write(JSON.stringify(msg) + '\0');
    return new Promise((ok, ko) => this.pending.set(id, { ok, ko, method }));
  }
  dispatch(msg) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.ko(new Error(`${p.method} : ${msg.error.message}`)); else p.ok(msg.result);
      return;
    }
    for (const h of this.handlers) h(msg);
  }
  on(h) { this.handlers.push(h); }
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what} : pas de réponse en ${ms} ms`); })]);

// Sonde évaluée dans l'iframe du moteur.
const PROBE = `(async () => {
  const c = document.getElementById('lightcraft_canvas');
  const st = { href: location.href, origin: location.origin, canvas: !!c, w: c ? c.width : 0, h: c ? c.height : 0,
    loading: !!document.getElementById('lightcraft_loading'), api: typeof globalThis.lightcraft?.command === 'function',
    status: document.getElementById('lightcraft_status')?.textContent || '', t: performance.now(), ready: false };
  if (st.api && !st.loading && st.w > 0 && st.h > 0) {
    const stats = await Promise.race([globalThis.lightcraft.command('web.stats', '{}'),
      new Promise((_, ko) => setTimeout(() => ko(new Error('web.stats sans réponse en 10 s')), 10000))]);
    st.stats = JSON.parse(stats);
    st.ready = true;
    st.tReady = performance.now();
  }
  return JSON.stringify(st);
})()`;

async function scenario(opts, chrome, sc, cspHashes) {
  const engineHost = '127.0.0.1';
  const parentHost = 'localhost';
  const parent = http.createServer();
  const parentPort = await listen(parent, '127.0.0.1');
  const parentOrigin = `http://${parentHost}:${parentPort}`;
  const csp = [
    "default-src 'self'", `script-src 'self' 'wasm-unsafe-eval' ${cspHashes.join(' ')}`, "worker-src 'self' blob:", "connect-src 'self'",
    "img-src 'self' data: blob:", "style-src 'self' 'unsafe-inline'", "font-src 'self' data:", `frame-ancestors ${parentOrigin}`,
    "object-src 'none'", "base-uri 'none'",
  ].join('; ');
  const engine = staticServer(opts.site, { 'Content-Security-Policy': csp });
  const enginePort = await listen(engine, engineHost);
  const engineOrigin = `http://${engineHost}:${enginePort}`;
  const engineUrl = `${engineOrigin}/index.html${sc.query}`;
  parent.on('request', (req, res) => {
    if (req.url.startsWith('/favicon')) { res.writeHead(204).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; frame-src ${engineOrigin}; style-src 'unsafe-inline'; img-src data:` });
    res.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Evora : hôte de test</title><link rel="icon" href="data:,">
<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><iframe id="engine" src="${engineUrl}" sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-modals"
allow="fullscreen; clipboard-read; clipboard-write" title="moteur"></iframe></body></html>`);
  });

  const profile = await mkdtemp(join(tmpdir(), `evora-smoke-${sc.name}-`));
  const args = ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--mute-audio',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1440,900', '--no-sandbox', 'about:blank'];
  const proc = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stdio[2].on('data', (d) => { stderr += d.toString(); });
  const cdp = new Cdp(proc);
  const errors = [];
  const warnings = [];
  const appLog = [];
  const targets = new Map(); // sessionId -> { type, url }
  let frameSession = null;
  const label = (sid) => (targets.get(sid)?.type || 'page');
  const text = (args) => args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');

  cdp.on(async (msg) => {
    const { method, params, sessionId } = msg;
    if (method === 'Target.attachedToTarget') {
      const sid = params.sessionId;
      const info = params.targetInfo;
      targets.set(sid, { type: info.type, url: info.url });
      if (info.type === 'iframe') frameSession = sid;
      // Envoyés d'un bloc (le protocole les traite dans l'ordre) : la cible reste en pause le moins
      // longtemps possible, mais aucune erreur de démarrage n'échappe à l'écoute.
      const calls = [cdp.send('Runtime.enable', {}, sid), cdp.send('Log.enable', {}, sid)];
      if (info.type === 'iframe' || info.type === 'page') {
        calls.push(cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid));
      }
      calls.push(cdp.send('Runtime.runIfWaitingForDebugger', {}, sid));
      await Promise.allSettled(calls);
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails;
      errors.push(`[${label(sessionId)}] exception : ${d.exception?.description || d.text} (${d.url || ''}:${d.lineNumber})`);
    } else if (method === 'Runtime.consoleAPICalled') {
      const line = `[${label(sessionId)}] console.${params.type} : ${text(params.args)}`;
      if (params.type === 'error' || params.type === 'assert') errors.push(line);
      else if (params.type === 'warning') warnings.push(line);
      else appLog.push(line);
    } else if (method === 'Log.entryAdded') {
      const e = params.entry;
      const line = `[${label(sessionId)}] ${e.source}/${e.level} : ${e.text}${e.url ? ` (${e.url})` : ''}`;
      if (e.level === 'error') errors.push(line); else if (e.level === 'warning') warnings.push(line);
    } else if (method === 'Inspector.targetCrashed' || method === 'Target.targetCrashed') {
      errors.push(`[${label(sessionId)}] plantage de la cible`);
    }
  });

  const result = { scenario: sc.name, engineUrl, parentOrigin, engineOrigin, ok: false };
  try {
    const version = await withTimeout(cdp.send('Browser.getVersion'), 20000, 'Browser.getVersion');
    result.browser = version.product;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: page } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    targets.set(page, { type: 'page', url: 'about:blank' });
    for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable']) await cdp.send(m, {}, page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page);
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, page);
    const t0 = Date.now();
    await cdp.send('Page.navigate', { url: `${parentOrigin}/` }, page);
    let last = null;
    while (Date.now() - t0 < opts.timeout * 1000) {
      await sleep(250);
      if (!frameSession) continue;
      try {
        const r = await withTimeout(cdp.send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true }, frameSession), 15000, 'sonde');
        if (r.exceptionDetails) { last = { probeError: r.exceptionDetails.exception?.description || r.exceptionDetails.text }; continue; }
        last = JSON.parse(r.result.value);
        if (last.ready) break;
      } catch (err) {
        last = { probeError: String(err.message || err) };
      }
      // une erreur déjà relevée et rien de prêt après 20 s : inutile d'attendre la fin du délai
      if (errors.length > 0 && Date.now() - t0 > 20000) break;
    }
    result.wallMs = Date.now() - t0;
    result.last = last;
    if (last?.ready) {
      await sleep(3000); // erreurs tardives (workers, premières frames)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, page);
      await writeFile(join(opts.out, `smoke-${sc.name}.png`), Buffer.from(shot.data, 'base64'));
      const webgl = await cdp.send('Runtime.evaluate', {
        expression: `(() => { const g = document.createElement('canvas').getContext('webgl2'); if (!g) return 'aucun'; const d = g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); })()`,
        returnByValue: true }, frameSession);
      result.webgl2 = webgl.result?.value;
    }
    result.targets = [...targets.values()].map((t) => t.type);
  } catch (err) {
    errors.push(`pilotage : ${err.message}`);
  } finally {
    proc.kill('SIGKILL');
    engine.close();
    parent.close();
  }
  const firstFrame = appLog.map((l) => /first UI frame at (\d+) ms/.exec(l)).find(Boolean);
  result.appFirstFrameMs = firstFrame ? Number(firstFrame[1]) : null;
  result.errors = errors;
  result.warnings = warnings;
  result.appLog = appLog.slice(0, 40);
  result.crossOrigin = !!result.last?.origin && result.last.origin === engineOrigin && engineOrigin !== parentOrigin;
  result.ok = !!result.last?.ready && errors.length === 0 && result.crossOrigin && result.targets?.includes('iframe');
  if (!result.ok) result.chromeStderr = stderr.split('\n').slice(-30);
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.site || !opts.out) { console.error('usage : node smoke.mjs --site <dossier> --out <dossier>'); return 2; }
  await mkdir(opts.out, { recursive: true });
  const chrome = findChrome(opts.chrome);
  const cspFile = join(opts.site, 'csp-hashes.txt');
  let cspHashes = existsSync(cspFile) ? readFileSync(cspFile, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t')[1]) : [];
  if (opts.sabotageCsp) cspHashes = ["'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='"];
  console.log(`Chrome : ${chrome} ; empreintes CSP : ${cspHashes.join(' ') || 'aucune'}`);
  const results = [];
  for (const sc of opts.scenarios) {
    const r = await scenario(opts, chrome, sc, cspHashes);
    results.push(r);
    const s = r.last || {};
    console.log(`\n== Scénario ${r.scenario} : ${r.ok ? 'OK' : 'ÉCHEC'} (${r.browser || 'navigateur ?'})`);
    console.log(`page parente ${r.parentOrigin} -> iframe ${r.engineUrl} (origine ${s.origin || '?'}, ${r.crossOrigin ? 'origine différente confirmée' : 'origine NON confirmée'})`);
    console.log(`cibles attachées : ${(r.targets || []).join(', ')} ; WebGL2 : ${r.webgl2 || '?'}`);
    console.log(`démarrage à froid : prêt à ${s.tReady ? Math.round(s.tReady) : '?'} ms après la navigation de l'iframe (performance.now), ${r.wallMs} ms d'horloge depuis la navigation de la page parente ; première frame UI annoncée par l'app : ${r.appFirstFrameMs ?? '?'} ms`);
    console.log(`état final : canvas ${s.w}x${s.h}, chargement retiré ${s.loading === false}, API ${s.api}, web.stats ${s.stats ? JSON.stringify(s.stats) : 'absent'}${s.probeError ? `, erreur de sonde ${s.probeError}` : ''}${s.status ? `, statut « ${s.status} »` : ''}`);
    for (const e of r.errors) console.log(`ERREUR ${e}`);
    for (const w of r.warnings.slice(0, 20)) console.log(`avertissement ${w}`);
    for (const l of r.appLog.slice(0, 15)) console.log(`journal ${l}`);
    if (r.chromeStderr) for (const l of r.chromeStderr) console.log(`chrome ${l}`);
  }
  await writeFile(join(opts.out, 'smoke.json'), JSON.stringify(results, null, 2));
  const ok = results.every((r) => r.ok);
  console.log(`\nTest de fumée : ${ok ? 'OK' : 'ÉCHEC'}`);
  return ok ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 1; });
