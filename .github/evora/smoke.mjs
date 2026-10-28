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
//                        [--scenario 'nom|requête|langue attendue']... [--sabotage-csp]
//                        [--render-audit --repo <dépôt>] [--terms-blocking]
// --render-audit appelle la commande web.renderAudit du module (patch E10) dans le dernier scénario
// prêt et juge le rendu : aucune face d'émoji dans les familles de l'interface, aucun émoji dans les
// messages affichés, tout symbole affiché (catalogues et littéraux du code) peint par une police
// de texte ; les termes sensibles (E9) restants sont relevés, et bloquants avec --terms-blocking.
// --sabotage-csp remplace les empreintes par une empreinte fausse : le script inline est bloqué et
// le test DOIT échouer (preuve que la porte sait rougir).
// Pont EHP (patch E4, correctif E5) : scénarios « pont-ehp » (coquille minimale, origine parente
// admise par evora-host.json, messages étrangers, ouverture d'une photo en octets, langue et thème à
// chaud, purges de démarrage, current et all) et « pont-muet » (evora-host.json de l'artefact, vide :
// aucun message) ; détail et étiquettes d'erreur dans ehp-bench.mjs. Scénario « hors-pont » (E5) :
// sans ?host=evora, ?storageNs= est ignoré et la bibliothèque s'écrit où l'amont l'écrit.
// --ehp-witness rejoue ce banc contre des moteurs factices, un conforme (doit être vert) et un par
// défaut (chacun doit rougir avec son étiquette), puis contre le vrai moteur sabordé (effacements
// sans effet dans sa page : doit rougir par chaque détecteur de purge).
// EVORA-REV-29 : « pont-ehp » exerce aussi le pont d'enregistrement de Revela (documents de la
// coquille, enveloppe revela-save, accusé d'enregistrement, revela.apply par réglages et par XMP,
// liste blanche de commandes, export de deux photos vers Drive, sélecteur d'Evora, F6 et Ctrl+S) ;
// tout téléchargement y est rouge (sentinelle chargée avant les scripts du moteur, et événements
// Browser.downloadWillBegin de Chrome).
// EVORA-REV-34 : « pont-ehp » juge aussi les finitions du moteur (menus masqués, nom affiché, accent
// de la coquille, types du sélecteur, catalogue des commandes : ehp-bench.mjs). Avec --commands-out, le
// premier catalogue reçu (evora:commands, en français) est écrit dans ce fichier : le commands.json de
// l'artefact, que le provisionnement d'Evora copie dans engines.json avec son empreinte.
// EVORA-REV-38 : avec --command-params-out, les schémas des paramètres déclarés (web.commandParams, jugés
// par le banc), sous la forme des commandes d'engines.json ({id: {params}}) : le command-params.json de
// l'artefact, que le provisionnement recopie dans les commandes de Revela (le catalogue n'en porte aucun).
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { auditRust, isEmoji, isSymbol, loadOverrides, SENSITIVE_TERMS, INFO_TERMS } from './catalog-audit.mjs';
import {
  FOREIGN_HTML, FOREIGN_JS, HARNESS_JS, OBSERVER_HTML, OBSERVER_JS, OTHER_NS, REAL_WITNESS, SABOTAGE_JS, SENTINEL_JS, WITNESS_FLAWS, WITNESS_HTML, WITNESS_JS,
  parentPage, runEhp, runMute,
} from './ehp-bench.mjs';

// Émojis témoins : la police de l'interface ne doit pas pouvoir les peindre en émoji.
const EMOJI_SAMPLES = '\u{1F600}\u2705\u274C\u2B50\u26A1\u{1F50D}\u{1F4C1}\u{1F5D1}\u26A0\u2714\u2716';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
  '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
};

function parseArgs(argv) {
  const o = { scenarios: [], timeout: 150, sabotageCsp: false, renderAudit: false, termsBlocking: false, repo: '.', ehpWitness: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--site') { o.site = v; i += 1; } else if (k === '--out') { o.out = v; i += 1; } else if (k === '--chrome') { o.chrome = v; i += 1; } else if (k === '--timeout') { o.timeout = Number(v); i += 1; } else if (k === '--sabotage-csp') { o.sabotageCsp = true; } else if (k === '--render-audit') { o.renderAudit = true; } else if (k === '--terms-blocking') { o.termsBlocking = true; } else if (k === '--ehp-witness') { o.ehpWitness = true; } else if (k === '--witness-only') { o.witnessOnly = v; i += 1; } else if (k === '--repo') { o.repo = v; i += 1; } else if (k === '--commands-out') { o.commandsOut = v; i += 1; } else if (k === '--command-params-out') { o.commandParamsOut = v; i += 1; } else if (k === '--scenario') { const [n, q, l] = v.split('|'); o.scenarios.push({ name: n, query: q || '', lang: l || undefined }); i += 1; }
  }
  // E3 : langue imposée par ?lang= (codes d'Evora), vérifiée par web.stats.language ; pt sans variante (D-23) reste en anglais.
  if (o.scenarios.length === 0) {
    o.scenarios = [
      // E2 : thème Evora imposé par ?theme=light|dark (accent #4f46e5) ; sans paramètre, le thème de l'app (Charcoal)
      { name: 'defaut', query: '', lang: 'en', theme: { evora: false, dark: true, accent: '#0165dd' } },
      { name: 'memoire-zh-Hans', query: '?store=memory&lang=zh-Hans', lang: 'zh-hans' },
      { name: 'pt-sans-variante', query: '?store=memory&lang=pt', lang: 'en' },
      // E5 (correctif) : l'espace de noms n'arrive plus par l'URL mais par evora:init, et la purge
      // seulement par evora:purge ou evora:init (scénario du pont EHP). Hors pont, comportement amont
      // inchangé : ?storageNs= est ignoré, la bibliothèque s'écrit où l'amont l'écrit.
      { name: 'hors-pont', query: '?storageNs=evoraTest1&lang=de&theme=dark', lang: 'de', upstreamStorage: true, theme: { evora: true, dark: true, accent: '#4f46e5' } },
      // E4 et E5 : pont EHP natif, mémoire imposée en mode hôte (store=opfs ignoré), storageNs de l'URL
      // ignoré (seul celui d'evora:init compte : un autre espace, effacé au démarrage), purges (ehp-bench.mjs)
      { name: 'pont-ehp', query: `?host=evora&store=opfs&storageNs=${OTHER_NS}&lang=en&theme=dark`, lang: 'en', ehp: 'admit', theme: { evora: true, dark: true, accent: '#4f46e5' } },
      // E4 : evora-host.json de l'artefact (vide) : le pont reste muet
      { name: 'pont-muet', query: '?host=evora&lang=en', lang: 'en', ehp: 'mute' },
      { name: 'francais', query: '?store=memory&lang=fr&theme=light', lang: 'fr', theme: { evora: true, dark: false, accent: '#4f46e5' } },
    ];
  }
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

function staticServer(root, headers, extra = () => null) {
  const base = resolve(root);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const served = extra(url.pathname);
      if (served) {
        res.writeHead(200, { 'Content-Type': served.type, 'Cache-Control': 'no-store', ...headers });
        res.end(req.method === 'HEAD' ? undefined : served.body);
        return;
      }
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

// E5 hors pont : ce que l'origine moteur garde dans le navigateur (racine OPFS, bases IndexedDB,
// clés localStorage), lu sans rien créer.
const STORAGE_PROBE = `(async () => {
  const root = await navigator.storage.getDirectory();
  const opfs = [];
  for await (const [n, h] of root.entries()) opfs.push(n + (h.kind === 'directory' ? '/' : ''));
  const idb = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : ['<inconnu>'];
  return JSON.stringify({ opfs: opfs.sort(), idb: idb.sort(), ls: Object.keys(localStorage).sort() });
})()`;

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

const JS = 'text/javascript; charset=utf-8';
const HTML = 'text/html; charset=utf-8';

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
  // E4 : evora-host.json à côté d'index.html. « admit » : ce qu'écrirait le provisionnement d'Evora
  // pour la coquille du banc ; « mute » : le fichier de l'artefact, tel quel.
  const shippedHostConfig = () => { try { return readFileSync(join(opts.site, 'evora-host.json')); } catch { return null; } };
  const engineExtra = (path) => {
    if (!sc.ehp) return null;
    if (path.endsWith('/evora-host.json')) {
      if (sc.ehp === 'admit') return { type: 'application/json', body: JSON.stringify({ parentOrigins: [parentOrigin] }) };
      const body = shippedHostConfig();
      return body ? { type: 'application/json', body } : null;
    }
    const assets = { '/__evora/observer.html': [HTML, OBSERVER_HTML], '/__evora/observer.js': [JS, OBSERVER_JS], '/__evora/sentinel.js': [JS, SENTINEL_JS] };
    if (sc.witness) Object.assign(assets, { '/__evora/witness/index.html': [HTML, WITNESS_HTML], '/__evora/witness/witness.js': [JS, WITNESS_JS] });
    // vrai moteur : la sentinelle des téléchargements (EVORA-REV-29), puis, pour le témoin sabordé,
    // sabotage.js, chargés avant tout autre script de son index.html
    if (!sc.witness) {
      if (sc.sabotage) assets['/__evora/sabotage.js'] = [JS, SABOTAGE_JS];
      try {
        const index = readFileSync(join(opts.site, 'index.html'), 'utf8');
        if (!index.includes('<head>')) throw new Error('<head> absent');
        const pre = `<script src="__evora/sentinel.js"></script>${sc.sabotage ? '\n  <script src="__evora/sabotage.js"></script>' : ''}`;
        assets['/index.html'] = [HTML, index.replace('<head>', `<head>\n  ${pre}`)];
      } catch (err) {
        errors.push(`[ehp-bench] index.html du moteur illisible pour la sentinelle${sc.sabotage ? ' et le sabotage' : ''} : ${err.message}`);
      }
    }
    return assets[path] ? { type: assets[path][0], body: assets[path][1] } : null;
  };
  const engine = staticServer(opts.site, { 'Content-Security-Policy': csp }, engineExtra);
  const enginePort = await listen(engine, engineHost);
  const engineOrigin = `http://${engineHost}:${enginePort}`;
  const engineUrl = sc.witness ? `${engineOrigin}/__evora/witness/index.html${sc.query}` : `${engineOrigin}/index.html${sc.query}`;
  // E4 : une origine NON admise (C) pour les messages étrangers du scénario « pont-ehp »
  const foreignAssets = { '/__evora/foreign.html': [HTML, FOREIGN_HTML], '/__evora/foreign.js': [JS, FOREIGN_JS] };
  const foreign = sc.ehp ? staticServer(opts.site, { 'Content-Security-Policy': `default-src 'none'; script-src 'self'; img-src data:; frame-ancestors ${parentOrigin}` },
    (path) => (foreignAssets[path] ? { type: foreignAssets[path][0], body: foreignAssets[path][1] } : { type: 'text/plain', body: '404' })) : null;
  const foreignOrigin = foreign ? `http://${engineHost}:${await listen(foreign, engineHost)}` : null;
  parent.on('request', (req, res) => {
    if (req.url.startsWith('/favicon')) { res.writeHead(204).end(); return; }
    if (sc.ehp) {
      const path = new URL(req.url, 'http://x').pathname;
      const assets = { '/': [HTML, parentPage({ engineUrl, engineOrigin, foreignOrigin })], '/__evora/harness.js': [JS, HARNESS_JS], ...foreignAssets };
      const hit = assets[path];
      res.writeHead(hit ? 200 : 404, { 'Content-Type': hit ? hit[0] : 'text/plain', 'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; script-src 'self'; frame-src ${engineOrigin} ${foreignOrigin} 'self'; style-src 'unsafe-inline'; img-src data:` });
      res.end(hit ? hit[1] : '404');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; frame-src ${engineOrigin}; style-src 'unsafe-inline'; img-src data:` });
    res.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Evora : hôte de test</title><link rel="icon" href="data:,">
<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><iframe id="engine" src="${engineUrl.replaceAll('&', '&amp;')}" sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-modals"
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
  const downloadEvents = [];
  const targets = new Map(); // sessionId -> { type, url }
  let frameSession = null;
  const frames = []; // sessions des cadres hors processus (moteur, observateur, page étrangère)
  const label = (sid) => (targets.get(sid)?.type || 'page');
  const text = (args) => args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');

  cdp.on(async (msg) => {
    const { method, params, sessionId } = msg;
    if (method === 'Target.attachedToTarget') {
      const sid = params.sessionId;
      const info = params.targetInfo;
      targets.set(sid, { type: info.type, url: info.url });
      if (info.type === 'iframe') frames.push(sid);
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
    } else if (method === 'Browser.downloadWillBegin' || method === 'Page.downloadWillBegin') {
      // EVORA-REV-29 : tout téléchargement est relevé (le banc du pont exige 0)
      downloadEvents.push(params.suggestedFilename || params.url || '?');
    }
  });

  const result = { scenario: sc.name, engineUrl, parentOrigin, engineOrigin, ok: false };
  const tStart = Date.now();
  try {
    const version = await withTimeout(cdp.send('Browser.getVersion'), 20000, 'Browser.getVersion');
    result.browser = version.product;
    if (sc.ehp) {
      try {
        await withTimeout(cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }), 10000, 'Browser.setDownloadBehavior');
      } catch (err) {
        warnings.push(`Browser.setDownloadBehavior indisponible (la sentinelle reste) : ${err.message}`);
      }
    }
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: page } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    targets.set(page, { type: 'page', url: 'about:blank' });
    for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable']) await cdp.send(m, {}, page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, page);
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, page);
    const t0 = Date.now();
    result.startMs = t0 - tStart;
    await cdp.send('Page.navigate', { url: `${parentOrigin}/` }, page);
    let last = null;
    // Le cadre du moteur est celui dont le document est …/index.html (le banc EHP en ajoute d'autres).
    const findEngine = async () => {
      for (const sid of frames) {
        try {
          const r = await withTimeout(cdp.send('Runtime.evaluate', { expression: 'location.pathname', returnByValue: true }, sid), 5000, 'cadre');
          if (/\/index\.html$/.test(r.result?.value || '')) return sid;
        } catch { /* cadre pas encore prêt */ }
      }
      return null;
    };
    while (Date.now() - t0 < opts.timeout * 1000) {
      await sleep(250);
      if (!frameSession) frameSession = await findEngine();
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
      // (moteurs factices des témoins : ni capture ni WebGL, sans objet)
      if (!sc.witness) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, page);
        await writeFile(join(opts.out, `smoke-${sc.name}.png`), Buffer.from(shot.data, 'base64'));
        const webgl = await cdp.send('Runtime.evaluate', {
          expression: `(() => { const g = document.createElement('canvas').getContext('webgl2'); if (!g) return 'aucun'; const d = g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); })()`,
          returnByValue: true }, frameSession);
        result.webgl2 = webgl.result?.value;
      }
      if (sc.upstreamStorage) {
        // l'amont écrit sa bibliothèque à la racine d'OPFS (library/) ; aucun espace de noms venu de l'URL
        let st = null;
        for (let i = 0; i < 40; i += 1) {
          const r = await withTimeout(cdp.send('Runtime.evaluate', { expression: STORAGE_PROBE, awaitPromise: true, returnByValue: true }, frameSession), 15000, 'sonde de stockage');
          if (r.exceptionDetails) { errors.push(`sonde de stockage : ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`); break; }
          st = JSON.parse(r.result.value);
          if (st.opfs.includes('library/') || st.idb.includes('lightcraft')) break;
          await sleep(500);
        }
        result.storage = st;
        if (st) {
          const named = [...st.opfs, ...st.idb].filter((n) => /^(lightcraft-)?ns-/.test(n) || n.includes('evoraTest1'));
          if (named.length) errors.push(`E5 hors pont : espace de noms pris dans l'URL (${JSON.stringify(named)})`);
          if (!st.opfs.includes('library/') && !st.idb.includes('lightcraft')) errors.push(`E5 hors pont : bibliothèque amont absente du stockage (${JSON.stringify(st)})`);
        }
      }
      if (sc.ehp) {
        const evalIn = async (sid, expression, ms = 90000) => {
          const r = await withTimeout(cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid), ms, expression.slice(0, 40));
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
          return r.result.value;
        };
        const ctx = { errors, result, evalPage: (e) => evalIn(page, e), engineStats: async () => JSON.parse(await evalIn(frameSession, "globalThis.lightcraft.command('web.stats', '{}')", 20000)),
          // EVORA-REV-29 : commandes et événements dans le cadre du moteur ; téléchargements relevés
          engineEval: (e, ms) => evalIn(frameSession, e, ms),
          downloads: async () => ({ anchors: JSON.parse(await evalIn(frameSession, 'JSON.stringify(globalThis.__evoraDownloads || [])', 20000)), events: downloadEvents.length }) };
        try {
          if (sc.ehp === 'admit') await runEhp(ctx);
          else await runMute({ ...ctx, site: opts.site, readFileSync, join });
        } catch (err) {
          errors.push(`[ehp-bench] banc interrompu : ${err.message}`);
        }
      }
      if (sc.audit) {
        const params = JSON.stringify({ terms: [...SENSITIVE_TERMS, ...INFO_TERMS], probe: sc.probe });
        const r = await withTimeout(cdp.send('Runtime.evaluate', {
          expression: `globalThis.lightcraft.command('web.renderAudit', ${JSON.stringify(params)})`, awaitPromise: true, returnByValue: true,
        }, frameSession), 90000, 'web.renderAudit');
        if (r.exceptionDetails) errors.push(`web.renderAudit : ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
        else result.renderAudit = JSON.parse(r.result.value);
      }
    }
    result.targets = [...targets.values()].map((t) => t.type);
    result.afterReadyMs = Date.now() - t0 - result.wallMs;
  } catch (err) {
    errors.push(`pilotage : ${err.message}`);
  } finally {
    proc.kill('SIGKILL');
    engine.close();
    parent.close();
    if (foreign) foreign.close();
  }
  const firstFrame = appLog.map((l) => /first UI frame at (\d+) ms/.exec(l)).find(Boolean);
  result.appFirstFrameMs = firstFrame ? Number(firstFrame[1]) : null;
  result.totalMs = Date.now() - tStart;
  result.errors = errors;
  result.warnings = warnings;
  result.appLog = appLog.slice(0, 40);
  result.crossOrigin = !!result.last?.origin && result.last.origin === engineOrigin && engineOrigin !== parentOrigin;
  result.language = result.last?.stats?.language;
  result.theme = result.last?.stats?.theme;
  if (sc.theme && result.last?.ready) {
    for (const k of ['evora', 'dark', 'accent']) {
      if (result.theme?.[k] !== sc.theme[k]) errors.push(`thème : ${k} = ${JSON.stringify(result.theme?.[k])}, attendu ${JSON.stringify(sc.theme[k])} (E2)`);
    }
  }
  if (sc.lang && result.last?.ready && result.language !== sc.lang) errors.push(`langue de l'interface ${result.language}, attendue ${sc.lang} (E3)`);
  result.ok = !!result.last?.ready && errors.length === 0 && result.crossOrigin && result.targets?.includes('iframe');
  if (!result.ok) result.chromeStderr = stderr.split('\n').slice(-30);
  return result;
}

// Jugement du rendu (E10) et des termes sensibles (E9) à partir de web.renderAudit.
function judgeRender(audit, codeSymbols, termsBlocking) {
  const lines = [];
  const problems = [];
  const emojiFaces = (audit.proportional || []).filter((f) => /noto.?emoji/i.test(f));
  lines.push(`familles proportionnelles de l'interface : ${(audit.proportional || []).join(', ')}`);
  lines.push(`faces chargées : ${(audit.faces || []).join(', ')}`);
  lines.push(`messages affichés par langue : ${Object.entries(audit.messages || {}).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (emojiFaces.length) problems.push(`face d'émoji encore dans les familles de l'interface : ${emojiFaces.join(', ')}`);
  for (const r of audit.symbols || []) {
    const tag = isEmoji(r.c) ? 'ÉMOJI' : 'symbole';
    lines.push(`affiché ${r.cp} ${r.c} ×${r.n} (${tag}) : ${r.paint ? 'peint' : 'NON PEINT'} par ${r.faces.join(', ') || 'aucune face'}`);
    if (isEmoji(r.c)) problems.push(`émoji affiché ${r.cp} ${r.c} (×${r.n})`);
    if (!r.paint) problems.push(`symbole affiché sans glyphe ${r.cp} ${r.c}`);
  }
  for (const r of audit.probe || []) {
    const fromCode = codeSymbols.has(r.c);
    lines.push(`sonde ${r.cp} ${r.c} (${fromCode ? 'littéral du code' : 'émoji témoin'}) : ${r.paint ? 'peint' : 'non peint'} par ${r.faces.join(', ') || 'aucune face'}`);
    if (fromCode && !r.paint) problems.push(`symbole du code sans glyphe ${r.cp} ${r.c}`);
  }
  const sensitive = (audit.sensitive || []).filter((x) => SENSITIVE_TERMS.includes(x.term));
  const info = (audit.sensitive || []).filter((x) => !SENSITIVE_TERMS.includes(x.term));
  const count = (list) => Object.entries(list.reduce((m, x) => ({ ...m, [x.term]: (m[x.term] || 0) + 1 }), {})).map(([t, n]) => `${t} ${n}`).join(', ') || 'aucun';
  lines.push(`termes sensibles affichés (E9, ${termsBlocking ? 'bloquant' : 'relevé'}) : ${count(sensitive)}`);
  for (const x of sensitive.slice(0, 12)) lines.push(`  ${x.lang} « ${x.term} » : ${x.text.slice(0, 120)}`);
  lines.push(`pour information : ${count(info)}`);
  if (termsBlocking && sensitive.length) problems.push(`${sensitive.length} message(s) affiché(s) avec un terme sensible`);
  return { ok: problems.length === 0, lines, problems };
}

// Témoins du banc EHP : le même banc contre des moteurs factices ; le conforme doit être vert, chaque
// défaut rouge AVEC son ou ses étiquettes, toutes exigées (un rouge pour une autre raison ne prouve
// pas la garde visée).
async function witness(opts, chrome, cspHashes) {
  const runs = [];
  for (const [flaw, tag] of WITNESS_FLAWS.filter(([f]) => !opts.witnessOnly || f === opts.witnessOnly)) {
    const want = tag === null ? [] : [].concat(tag);
    const modes = flaw === 'aucun' ? ['admit', 'mute'] : [flaw === 'bavard' ? 'mute' : 'admit'];
    for (const mode of modes) {
      const sc = { name: `temoin-${flaw}-${mode}`, query: `?host=evora&flaw=${flaw}`, ehp: mode, witness: true };
      const r = await scenario({ ...opts, timeout: 60 }, chrome, sc, cspHashes);
      const tags = [...new Set(r.errors.map((e) => (/^\[[a-z0-9-]+\]/.exec(e) || ['?'])[0]))];
      const ok = want.length === 0 ? r.ok : !r.ok && want.every((t) => tags.includes(t));
      runs.push({ flaw, mode, expected: want.join(' ') || 'vert', ok, green: r.ok, tags, errors: r.errors.slice(0, 6) });
      if (process.env.EVORA_DEBUG) console.log(JSON.stringify({ ms: r.ehpMs, start: r.startMs, wall: r.wallMs, total: r.totalMs, after: r.afterReadyMs }));
      console.log(`témoin ${flaw} (${mode}) : attendu ${want.join(' ') || 'vert'} ; obtenu ${r.ok ? 'vert' : `rouge ${tags.join(' ')}`} -> ${ok ? 'OK' : 'ÉCHEC'} (${r.wallMs} ms jusqu'au moteur prêt)`);
      if (!ok) for (const e of r.errors.slice(0, 8)) console.log(`  ${e}`);
    }
  }
  // Le VRAI moteur, sabordé dans sa page (effacements sans effet) : rouge par chaque détecteur de purge.
  if (!opts.witnessOnly || opts.witnessOnly === REAL_WITNESS.name) {
    const sc = { name: `temoin-${REAL_WITNESS.name}`, query: `?host=evora&store=opfs&storageNs=${OTHER_NS}&lang=en&theme=dark`, ehp: 'admit', sabotage: true };
    const r = await scenario({ ...opts, timeout: 150 }, chrome, sc, cspHashes);
    const tags = [...new Set(r.errors.map((e) => (/^\[[a-z0-9-]+\]/.exec(e) || ['?'])[0]))];
    const ok = !r.ok && REAL_WITNESS.expected.every((t) => tags.includes(t));
    runs.push({ flaw: REAL_WITNESS.name, mode: 'admit', expected: REAL_WITNESS.expected.join(' '), ok, green: r.ok, tags, errors: r.errors.slice(0, 8) });
    console.log(`témoin ${REAL_WITNESS.name} (vrai moteur sabordé) : attendu ${REAL_WITNESS.expected.join(' ')} ; obtenu ${r.ok ? 'vert' : `rouge ${tags.join(' ')}`} -> ${ok ? 'OK' : 'ÉCHEC'} (${r.wallMs} ms jusqu'au moteur prêt)`);
    if (!ok) for (const e of r.errors.slice(0, 10)) console.log(`  ${e}`);
  }
  await writeFile(join(opts.out, 'ehp-witness.json'), JSON.stringify(runs, null, 2));
  const ok = runs.every((x) => x.ok);
  console.log(`\nTémoins du banc EHP : ${ok ? 'OK' : 'ÉCHEC'} (${runs.filter((x) => x.ok).length}/${runs.length})`);
  return ok ? 0 : 1;
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
  if (opts.ehpWitness) return witness(opts, chrome, cspHashes);
  const results = [];
  let codeSymbols = new Map();
  if (opts.renderAudit) {
    // Symboles des littéraux du code TELS QU'AFFICHÉS : ils passent par tr()/tr_format!, donc par le
    // catalogue de surcharge d'affichage (▸ s'affiche ›, ▾ s'affiche ⌄).
    const rs = auditRust(opts.repo);
    const ov = loadOverrides(opts.repo);
    codeSymbols = new Map();
    for (const [ch, n] of rs.symbols) {
      const shown = ov.replace.reduce((t, [from, to]) => t.split(from).join(to), ch);
      for (const c of shown) if (isSymbol(c) || isEmoji(c)) codeSymbols.set(c, (codeSymbols.get(c) || 0) + n);
    }
    const last = opts.scenarios[opts.scenarios.length - 1];
    last.audit = true;
    last.probe = [...codeSymbols.keys()].join('') + EMOJI_SAMPLES;
  }
  for (const sc of opts.scenarios) {
    const r = await scenario(opts, chrome, sc, cspHashes);
    results.push(r);
    const s = r.last || {};
    console.log(`\n== Scénario ${r.scenario} : ${r.ok ? 'OK' : 'ÉCHEC'} (${r.browser || 'navigateur ?'})`);
    console.log(`page parente ${r.parentOrigin} -> iframe ${r.engineUrl} (origine ${s.origin || '?'}, ${r.crossOrigin ? 'origine différente confirmée' : 'origine NON confirmée'})`);
    console.log(`cibles attachées : ${(r.targets || []).join(', ')} ; WebGL2 : ${r.webgl2 || '?'} ; langue de l'interface : ${r.language ?? '?'}${sc.lang ? ` (attendue ${sc.lang})` : ''} ; thème ${JSON.stringify(r.theme ?? null)}`);
    console.log(`démarrage à froid : prêt à ${s.tReady ? Math.round(s.tReady) : '?'} ms après la navigation de l'iframe (performance.now), ${r.wallMs} ms d'horloge depuis la navigation de la page parente ; première frame UI annoncée par l'app : ${r.appFirstFrameMs ?? '?'} ms`);
    console.log(`état final : canvas ${s.w}x${s.h}, chargement retiré ${s.loading === false}, API ${s.api}, web.stats ${s.stats ? JSON.stringify(s.stats) : 'absent'}${s.probeError ? `, erreur de sonde ${s.probeError}` : ''}${s.status ? `, statut « ${s.status} »` : ''}`);
    if (r.storage) console.log(`E5 hors pont, stockage de l'origine moteur : ${JSON.stringify(r.storage)}`);
    if (r.ehp) console.log(`E4 échanges vus de la coquille : ${r.ehp.log.map((m) => `${m.type}${m.re ? ` (re ${m.re.slice(-4)})` : ''}${m.payload ? ` ${JSON.stringify(m.payload).slice(0, 140)}` : ''}`).join(' ; ') || 'aucun'}`);
    if (r.ehpSteps) for (const [k, v] of Object.entries(r.ehpSteps)) console.log(`E4 étape ${k} : ${JSON.stringify(v).slice(0, 600)}`);
    if (r.ehpStats) console.log(`E4 état du moteur : ${JSON.stringify(r.ehpStats).slice(0, 600)}`);
    if (r.shippedHostConfig) console.log(`E4 evora-host.json de l'artefact : ${JSON.stringify(r.shippedHostConfig)}`);
    for (const e of r.errors) console.log(`ERREUR ${e}`);
    for (const w of r.warnings.slice(0, 20)) console.log(`avertissement ${w}`);
    for (const l of r.appLog.slice(0, 15)) console.log(`journal ${l}`);
    if (r.chromeStderr) for (const l of r.chromeStderr) console.log(`chrome ${l}`);
    if (sc.audit) {
      if (!r.renderAudit) {
        r.ok = false;
        console.log('ÉCHEC audit de rendu : web.renderAudit sans résultat');
      } else {
        const j = judgeRender(r.renderAudit, codeSymbols, opts.termsBlocking);
        r.render = j;
        console.log(`\n== Audit de rendu (E10) et des termes (E9) : ${j.ok ? 'OK' : 'ÉCHEC'}`);
        for (const l of j.lines) console.log(l);
        for (const p of j.problems) console.log(`PROBLÈME ${p}`);
        if (!j.ok) r.ok = false;
      }
    }
  }
  await writeFile(join(opts.out, 'smoke.json'), JSON.stringify(results, null, 2));
  // EVORA-REV-34 : commands.json de l'artefact (le catalogue reçu par « pont-ehp », jugé par le banc)
  if (opts.commandsOut) {
    const catalog = (results.find((r) => r.commandsCatalog) || {}).commandsCatalog;
    if (catalog) {
      await writeFile(opts.commandsOut, JSON.stringify(catalog, null, 2) + '\n');
      console.log(`\ncommands.json : ${catalog.count} commandes, empreinte ${catalog.hash}, langue ${catalog.lang} -> ${opts.commandsOut}`);
    } else {
      console.log('\ncommands.json : aucun catalogue reçu par « pont-ehp » (non écrit)');
    }
  }
  // EVORA-REV-38 : command-params.json de l'artefact (les schémas des paramètres déclarés, jugés par le banc)
  if (opts.commandParamsOut) {
    const declared = (results.find((r) => r.commandParams) || {}).commandParams;
    if (declared) {
      await writeFile(opts.commandParamsOut, JSON.stringify(declared, null, 2) + '\n');
      console.log(`command-params.json : ${Object.keys(declared).length} commandes à paramètres déclarés -> ${opts.commandParamsOut}`);
    } else {
      console.log('command-params.json : aucun schéma reçu par « pont-ehp » (non écrit)');
    }
  }
  const ok = results.every((r) => r.ok);
  console.log(`\nTest de fumée : ${ok ? 'OK' : 'ÉCHEC'}`);
  return ok ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 1; });
