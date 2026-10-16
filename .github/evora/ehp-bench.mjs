// SPDX-License-Identifier: MIT
// Evora — banc du pont EHP v1 (patch E4, avec le correctif E5), utilisé par smoke.mjs.
//
// Scénario « pont-ehp » : une coquille minimale (page parente, origine B) embarque le moteur
// (origine A, ?host=evora) et l'admet par evora-host.json, servi par le banc à côté d'index.html
// comme l'écrirait le provisionnement d'Evora. Trois autres cadres l'entourent :
// - un observateur servi par l'origine du moteur (A) : il amorce le stockage navigateur (restes de
//   LightCraft hors espace de noms, un autre espace de noms, l'espace du compte, et ce qu'y
//   laisseraient les autres moteurs d'Evora) et le liste EN ENTIER à la demande (OPFS, IndexedDB,
//   localStorage, sessionStorage, Cache Storage), sans jamais rien créer. Le juge ne filtre pas par
//   les noms que le moteur se connaît : tout ce qui n'appartient pas aux autres moteurs est au
//   moteur, quel que soit son nom (une écriture ou un reste sous un nom nouveau rougit) ;
// - une page d'une origine NON admise (C) et une page de la même origine que la coquille mais qui
//   n'est pas elle (B, autre fenêtre) : elles envoient au moteur des messages EHP valides, qui
//   doivent rester sans effet et sans réponse (contrôles d'origine ET de source).
// La coquille journalise tout ce qu'elle reçoit ; smoke.mjs déroule les étapes (amorçage, init,
// ouverture d'une photo reçue en octets, langue, thème, messages étrangers, purge de l'espace courant,
// nouvel amorçage puis purge totale) et juge, depuis
// la page parente et depuis le moteur (web.stats), ce qu'exige HOST-PROTOCOL.md (§3, §4, §5, §7.7).
//
// Scénario « pont-muet » : le moteur avec l'evora-host.json de l'artefact (vide) ne dit rien.
//
// Témoins (--ehp-witness) : le MÊME banc contre un moteur factice (JavaScript, servi par le banc),
// conforme ou affligé d'un défaut à la fois : le conforme doit être vert, chaque défaut rouge avec
// son étiquette. Et contre le VRAI moteur sabordé (removeEntry, deleteDatabase et removeItem sans
// effet dans sa page) : il doit rougir par les détecteurs de purge. C'est la preuve, à chaque
// exécution, que le banc sait rougir.

export const NS = 'ab'.repeat(32);
export const OTHER_NS = 'cd'.repeat(32);
export const PHOTO = 'evora-smoke.jpg';
// Ce que le scénario exerce : le moteur doit déclarer exactement cela, ni plus ni moins.
export const EXERCISED = ['doc.open', 'live.lang', 'live.theme', 'storage.memory', 'storage.purge'];

// Défauts des moteurs factices et étiquette d'erreur attendue (null : témoin conforme, doit être vert).
export const WITNESS_FLAWS = [
  ['aucun', null],
  ['v2', '[ehp-v2]'],
  ['etranger', '[ehp-foreign]'],
  ['double-ready', '[ehp-ready]'],
  ['champ-en-trop', '[ehp-envelope]'],
  ['capacite-en-trop', '[ehp-caps]'],
  ['sans-purge-init', '[ehp-purge-init]'],
  ['purge-excessive', '[ehp-overpurge]'],
  ['accuse-avant-purge', '[ehp-purge-ack]'],
  ['purge-all-partielle', '[ehp-purge-all]'],
  ['ecriture-apres-purge', '[ehp-late-write]'],
  ['ecriture-en-seance', '[ehp-session-write]'],
  // écritures sous un nom que storage_names.rs ignore, une par type de stockage : le juge les voit
  ['hors-nom-opfs', ['[ehp-session-write]', '[ehp-purge-ack]']],
  ['hors-nom-idb', ['[ehp-session-write]', '[ehp-purge-ack]']],
  ['hors-nom-ls', ['[ehp-session-write]', '[ehp-purge-ack]']],
  ['hors-nom-ss', ['[ehp-session-write]', '[ehp-purge-ack]']],
  ['hors-nom-cache', ['[ehp-session-write]', '[ehp-purge-ack]']],
  ['ecriture-au-demarrage', ['[ehp-init-write]', '[ehp-purge-ack]']],
  ['ouverture-feinte', '[ehp-open]'],
  ['langue-ignoree', '[ehp-live]'],
  ['bavard', '[ehp-mute]'],
];

// Témoin sur le VRAI moteur : effacements sans effet dans sa page (sabotage.js), purges qui ne
// purgent rien. Il doit rougir par CHACUNE de ces étiquettes.
export const REAL_WITNESS = { name: 'reel-purge-sans-effet', expected: ['[ehp-purge-init]', '[ehp-purge-ack]', '[ehp-purge-all]'] };

// Injecté avant tout autre script dans l'index.html du vrai moteur pour ce seul témoin.
export const SABOTAGE_JS = `'use strict';
(() => {
  const H = globalThis.FileSystemDirectoryHandle;
  if (H) H.prototype.removeEntry = function () { return Promise.resolve(); };
  const F = globalThis.IDBFactory;
  const del = F && F.prototype.deleteDatabase;
  if (del) F.prototype.deleteDatabase = function () { return del.call(this, 'evora-temoin-inexistant'); };
  const S = globalThis.Storage;
  if (S) S.prototype.removeItem = function () {};
})();
`;

// Types de stockage de l'origine du moteur que l'observateur liste et que le banc juge.
const KINDS = ['opfs', 'idb', 'ls', 'ss', 'cache'];
// Ce que l'amorçage dépose pour les AUTRES moteurs de l'origine : doit survivre à toute purge. Tout le
// reste du stockage de l'origine est au moteur, quel que soit son nom.
const FOREIGN = { opfs: ['effectcraft-cache/', `ns-${NS}/`, 'photocraft-temoin.txt'], idb: ['photocraft.presets'], ls: ['pdfcraft'], ss: [], cache: [] };
// Les restes de LightCraft que l'amorçage dépose (noms d'apps/lightcraft-web/src/storage_names.rs).
const SEEDED_LC = {
  opfs: ['active-library', 'library-20261013-101500/', 'library/', `lightcraft-ns-${NS}/`, `lightcraft-ns-${OTHER_NS}/`, 'originals/', 'thumbs/'],
  idb: ['lightcraft', `lightcraft-ns-${NS}`, `lightcraft-ns-${OTHER_NS}`],
  ls: ['lightcraft.temoin'],
  ss: [],
  cache: [],
};
const KEPT_AFTER_INIT = { opfs: [`lightcraft-ns-${NS}/`], idb: [`lightcraft-ns-${NS}`], ls: [], ss: [], cache: [] };

// --- Pages et scripts servis par le banc ------------------------------------------------------

export const OBSERVER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>observateur</title><link rel="icon" href="data:,"></head>
<body><script src="/__evora/observer.js"></script></body></html>`;

// Observateur (origine du moteur) : amorce OPFS, IndexedDB et localStorage, et liste en entier ces trois-là
// plus sessionStorage et Cache Storage ; répond sur le port de la demande, jamais par la fenêtre (le
// journal de la coquille ne voit que le moteur). Une liste impossible à dresser est une erreur.
export const OBSERVER_JS = `'use strict';
const put = async (path, text) => {
  const parts = path.split('/');
  let d = await navigator.storage.getDirectory();
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
  await w.write(text);
  await w.close();
};
const db = (name) => new Promise((ok, ko) => {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => r.result.createObjectStore('files');
  r.onerror = () => ko(r.error);
  r.onsuccess = () => {
    const d = r.result;
    const tx = d.transaction('files', 'readwrite');
    tx.objectStore('files').put(new Uint8Array([1, 2, 3]), 'library/catalog.snap');
    tx.oncomplete = () => { d.close(); ok(); };
    tx.onerror = () => { d.close(); ko(tx.error); };
  };
});
const list = async (ns) => {
  const root = await navigator.storage.getDirectory();
  const opfs = [];
  for await (const [n, h] of root.entries()) opfs.push(n + (h.kind === 'directory' ? '/' : ''));
  let inNs = null;
  try {
    const d = await root.getDirectoryHandle('lightcraft-ns-' + ns);
    inNs = [];
    for await (const [n] of d.entries()) inNs.push(n);
  } catch (e) { inNs = null; }
  const idb = (await indexedDB.databases()).map((d) => d.name);
  const ls = Object.keys(localStorage);
  const ss = Object.keys(sessionStorage);
  if (typeof caches === 'undefined') throw new Error('Cache Storage indisponible : liste incomplète');
  const cache = await caches.keys();
  return { opfs: opfs.sort(), inNs, idb: idb.sort(), ls: ls.sort(), ss: ss.sort(), cache: cache.sort() };
};
addEventListener('message', async (e) => {
  if (e.source !== parent || !e.ports[0]) return;
  const { cmd, ns, other } = e.data || {};
  if (cmd === 'ping') { e.ports[0].postMessage({ pong: true }); return; }
  try {
    if (cmd === 'seed') {
      for (const p of ['library/catalog.snap', 'library-20261013-101500/catalog.snap', 'originals/0123456789abcdef', 'thumbs/index.json',
        'active-library', 'lightcraft-ns-' + other + '/library/catalog.snap', 'lightcraft-ns-' + ns + '/library/catalog.snap',
        'effectcraft-cache/v1/frame.bin', 'ns-' + ns + '/recovery/snapshot.fcproj', 'photocraft-temoin.txt']) await put(p, 'evora');
      for (const n of ['lightcraft', 'lightcraft-ns-' + other, 'lightcraft-ns-' + ns, 'photocraft.presets']) await db(n);
      localStorage.setItem('lightcraft.temoin', '1');
      localStorage.setItem('pdfcraft', '{}');
    }
    e.ports[0].postMessage(await list(ns));
  } catch (err) {
    e.ports[0].postMessage({ error: String(err) });
  }
});
`;

export const FOREIGN_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>autre fenêtre</title><link rel="icon" href="data:,"></head>
<body><script src="/__evora/foreign.js"></script></body></html>`;

// Page étrangère (origine C non admise, ou même origine que la coquille mais autre fenêtre) :
// relaie au moteur le message que la coquille lui confie, comme le ferait un intrus.
export const FOREIGN_JS = `'use strict';
addEventListener('message', (e) => {
  if (e.source !== parent || !e.ports[0]) return;
  if ((e.data || {}).cmd === 'ping') { e.ports[0].postMessage({ pong: true }); return; }
  const { index, engine, message } = e.data || {};
  let sent = false;
  try { parent.frames[index].postMessage(message, engine); sent = true; } catch (err) { sent = String(err); }
  e.ports[0].postMessage({ sent });
});
`;

// Coquille minimale (page parente, origine B) : contrôle source et origine, journalise, et déroule
// les étapes que smoke.mjs lui demande (window.__ehp.run).
export const HARNESS_JS = `'use strict';
(() => {
  const cfg = JSON.parse(document.currentScript.dataset.config);
  const C = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const ulid = () => Array.from(crypto.getRandomValues(new Uint8Array(26)), (b) => C[b & 31]).join('');
  const $ = (id) => document.getElementById(id);
  const engine = $('engine');
  const observer = $('observer');
  const log = [];
  const ids = { foreign: [] };
  const waiters = [];
  const plainOf = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
  const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v, (k, x) => (x instanceof ArrayBuffer ? { byteLength: x.byteLength } : x)));
  addEventListener('message', (e) => {
    const d = e.data;
    const plain = plainOf(d);
    const entry = {
      t: Math.round(performance.now()), origin: e.origin, fromEngine: e.source === engine.contentWindow && e.origin === cfg.engine,
      plain, keys: plain ? Object.keys(d) : [], v: plain ? d.v : null, type: plain ? d.type : null, id: plain ? d.id : null,
      re: plain && 're' in d ? d.re : null, payloadPlain: plain && plainOf(d.payload), payload: plain ? clone(d.payload) : null,
    };
    log.push(entry);
    for (const w of waiters.slice()) if (w.pred(entry)) { waiters.splice(waiters.indexOf(w), 1); w.ok(entry); }
  });
  const waitFor = (pred, ms) => new Promise((ok) => {
    const w = { pred, ok };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); ok(null); } }, ms);
  });
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const ask = (win, origin, msg, ms = 20000) => new Promise((ok) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => ok({ error: msg.cmd + ' : pas de réponse en ' + ms + ' ms' }), ms);
    ch.port1.onmessage = (e) => { clearTimeout(t); ok(e.data); };
    win.postMessage(msg, origin, [ch.port2]);
  });
  // une page auxiliaire n'écoute qu'une fois chargée : on la sonde jusqu'à sa réponse
  const awake = async (win, origin) => {
    for (let i = 0; i < 80; i += 1) {
      const r = await ask(win, origin, { cmd: 'ping' }, 250);
      if (r && r.pong) return true;
    }
    return false;
  };
  const observe = () => ask(observer.contentWindow, cfg.engine, { cmd: 'list', ns: cfg.ns });
  const toEngine = (m, transfer) => engine.contentWindow.postMessage(m, cfg.engine, transfer || []);
  const ready = () => log.find((m) => m.fromEngine && m.type === 'evora:ready') || null;
  const ackOf = (id, ms) => waitFor((m) => m.fromEngine && m.type === 'evora:ack' && m.re === id, ms);
  const index = () => Array.prototype.indexOf.call(window.frames, engine.contentWindow);
  const strangers = [[$('foreign'), cfg.foreign], [$('sibling'), location.origin]];
  const fromStrangers = async (make) => {
    for (const [frame, origin] of strangers) {
      const message = make();
      ids.foreign.push(message.id);
      const r = await ask(frame.contentWindow, origin, { cmd: 'send', index: index(), engine: cfg.engine, message });
      if (!r || r.sent !== true) (ids.strangerErrors = ids.strangerErrors || []).push(r);
    }
  };
  const caps = () => ((ready() || {}).payload || {}).capabilities || [];
  const initPayload = (ns, lang, theme) => ({ lang, engineLang: lang, theme, accent: '#4F46E5', readOnly: false, storageNs: ns,
    capabilities: caps(), prefs: {}, limits: { maxDocumentBytes: 8388608, maxExportBytes: 8388608 } });
  const steps = {
    seed: async () => {
      for (const [frame, origin] of [[observer, cfg.engine], ...strangers]) {
        if (!(await awake(frame.contentWindow, origin))) return { error: frame.id + ' : page auxiliaire muette' };
      }
      return ask(observer.contentWindow, cfg.engine, { cmd: 'seed', ns: cfg.ns, other: cfg.other });
    },
    init: async () => {
      const r = ready();
      if (!r) return { error: 'aucun evora:ready' };
      ids.bogus = ulid();
      toEngine({ v: 2, type: 'evora:init', id: ids.bogus, re: r.id, payload: initPayload(cfg.ns, 'ja', 'light') });
      await fromStrangers(() => ({ v: 1, type: 'evora:init', id: ulid(), re: r.id, payload: initPayload(cfg.other, 'ja', 'light') }));
      await sleep(400);
      ids.init = ulid();
      toEngine({ v: 1, type: 'evora:init', id: ids.init, re: r.id, payload: initPayload(cfg.ns, 'fr', 'dark') });
      const ack = await ackOf(ids.init, 30000);
      return { ack: ack && ack.payload, storage: await observe() };
    },
    open: async () => {
      const c = new OffscreenCanvas(96, 64);
      const g = c.getContext('2d');
      g.fillStyle = '#4F46E5'; g.fillRect(0, 0, 96, 64); g.fillStyle = '#F9FAFB'; g.fillRect(24, 16, 48, 32);
      const bytes = await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer();
      const n = bytes.byteLength;
      ids.open = ulid();
      ids.docRef = ulid();
      toEngine({ v: 1, type: 'evora:open', id: ids.open, payload: { docRef: ids.docRef, name: cfg.photo, bytes } }, [bytes]);
      const ack = await ackOf(ids.open, 60000);
      return { ack: ack && ack.payload, bytes: n, transferred: bytes.byteLength === 0 };
    },
    lang: async () => {
      ids.lang = ulid();
      toEngine({ v: 1, type: 'evora:lang', id: ids.lang, payload: { lang: 'de', engineLang: 'de' } });
      const ack = await ackOf(ids.lang, 30000);
      return { ack: ack && ack.payload };
    },
    theme: async () => {
      ids.theme = ulid();
      toEngine({ v: 1, type: 'evora:theme', id: ids.theme, payload: { theme: 'light', accent: '#4F46E5' } });
      const ack = await ackOf(ids.theme, 30000);
      return { ack: ack && ack.payload };
    },
    strangers: async () => {
      await fromStrangers(() => ({ v: 1, type: 'evora:purge', id: ulid(), payload: { scope: 'all' } }));
      await fromStrangers(() => ({ v: 1, type: 'evora:lang', id: ulid(), payload: { lang: 'ja', engineLang: 'ja' } }));
      await sleep(800);
      return { storage: await observe() };
    },
    purge: async () => {
      ids.purge = ulid();
      toEngine({ v: 1, type: 'evora:purge', id: ids.purge, payload: { scope: 'current' } });
      const ack = await ackOf(ids.purge, 30000);
      // au moment même de l'accusé : il ne doit venir qu'après l'effacement
      const atAck = await observe();
      await sleep(1500);
      return { ack: ack && ack.payload, atAck, later: await observe() };
    },
    // evora:purge {scope: "all"} : le banc ressème d'abord le stockage (restes, deux espaces, autres moteurs)
    purgeAll: async () => {
      const seeded = await ask(observer.contentWindow, cfg.engine, { cmd: 'seed', ns: cfg.ns, other: cfg.other });
      ids.purgeAll = ulid();
      toEngine({ v: 1, type: 'evora:purge', id: ids.purgeAll, payload: { scope: 'all' } });
      const ack = await ackOf(ids.purgeAll, 30000);
      const atAck = await observe();
      await sleep(1500);
      return { seeded, ack: ack && ack.payload, atAck, later: await observe() };
    },
  };
  window.__ehp = { log, ids, run: async (step) => JSON.stringify(await steps[step]()) };
})();
`;

export function parentPage({ engineUrl, engineOrigin, foreignOrigin }) {
  const config = JSON.stringify({ engine: engineOrigin, foreign: foreignOrigin, ns: NS, other: OTHER_NS, photo: PHOTO });
  const attr = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Evora : coquille de test EHP</title><link rel="icon" href="data:,">
<style>html,body{margin:0;height:100%;background:#fff}#engine{border:0;width:100%;height:100%;display:block}.aux{position:absolute;width:1px;height:1px;border:0;left:-10px;top:-10px}</style></head>
<body><iframe class="aux" id="observer" src="${attr(`${engineOrigin}/__evora/observer.html`)}" title="observateur"></iframe>
<iframe id="engine" name="engine" src="${attr(engineUrl)}" sandbox="allow-scripts allow-same-origin" allow="fullscreen; clipboard-read; clipboard-write" title="moteur"></iframe>
<iframe class="aux" id="foreign" src="${attr(`${foreignOrigin}/__evora/foreign.html`)}" title="origine non admise"></iframe>
<iframe class="aux" id="sibling" src="/__evora/foreign.html" title="autre fenêtre"></iframe>
<script src="/__evora/harness.js" data-config="${attr(config)}"></script></body></html>`;
}

// --- Moteur factice des témoins ---------------------------------------------------------------

export const WITNESS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>moteur factice</title><link rel="icon" href="data:,">
<style>html,body{margin:0;height:100%}canvas{width:100%;height:100%;display:block}</style></head>
<body><canvas id="lightcraft_canvas" width="320" height="200"></canvas><script src="witness.js"></script></body></html>`;

// Un pont EHP écrit en JavaScript, conforme sauf le défaut demandé par ?flaw= (un seul à la fois).
export const WITNESS_JS = `'use strict';
(() => {
  const flaw = new URLSearchParams(location.search).get('flaw') || 'aucun';
  const C = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const ulid = () => Array.from(crypto.getRandomValues(new Uint8Array(26)), (b) => C[b & 31]).join('');
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const st = { language: 'en', dark: true, evora: true, photos: 3, active: null, ns: '', inited: false, readyId: null, seen: new Set() };
  globalThis.lightcraft = { command: async (id) => {
    if (id !== 'web.stats') throw new Error('commande inconnue');
    return JSON.stringify({ language: st.language, theme: { evora: st.evora, dark: st.dark, accent: '#4f46e5' }, storage: 'memory',
      photos: st.photos, active: st.active, activeThumb: st.active !== null, activeFailure: null, renderQueue: 0, rendersInFlight: 0 });
  } };
  const lcRoot = (n) => /^(library|originals|thumbs|active-library)$/.test(n) || /^library-[A-Za-z0-9-]{1,64}$/.test(n);
  const covers = (scope, n, idb) => {
    if (flaw === 'purge-excessive') return true;
    if (idb ? n === 'lightcraft' : lcRoot(n)) return true;
    if (!n.startsWith('lightcraft-ns-')) return false;
    const id = n.slice(14);
    return scope.all || (scope.keep ? id !== scope.keep : id === scope.current);
  };
  const put = async (path) => {
    const parts = path.split('/');
    let d = await navigator.storage.getDirectory();
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    await w.write('x');
    await w.close();
  };
  // écriture sous un nom que le moteur ne se connaît pas (et que sa purge ne couvre donc pas)
  const offName = {
    'hors-nom-opfs': () => put('recovery/snapshot.lcproj'),
    'hors-nom-idb': () => new Promise((ok, ko) => { const r = indexedDB.open('lightcraft-cache', 1); r.onsuccess = () => { r.result.close(); ok(); }; r.onerror = () => ko(r.error); }),
    'hors-nom-ls': () => localStorage.setItem('egui_memory_ron', '{}'),
    'hors-nom-ss': () => sessionStorage.setItem('egui_memory_ron', '{}'),
    'hors-nom-cache': async () => (await caches.open('lightcraft-tiles')).put(location.href, new Response('x')),
  };
  const purge = async (scope) => {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const [n] of root.entries()) names.push(n);
    for (const n of names) if (covers(scope, n, false)) await root.removeEntry(n, { recursive: true });
    for (const { name } of await indexedDB.databases()) {
      if (covers(scope, name, true)) await new Promise((ok, ko) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = ok; r.onerror = () => ko(r.error); r.onblocked = () => ko(new Error('blocked')); });
    }
    for (const k of Object.keys(localStorage)) if (flaw === 'purge-excessive' || k.startsWith('lightcraft')) localStorage.removeItem(k);
  };
  (async () => {
    if (window.parent === window) return;
    const cfg = await (await fetch('evora-host.json', { cache: 'no-store' })).json();
    const admitted = Array.isArray(cfg.parentOrigins) ? cfg.parentOrigins : [];
    const origin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '';
    if (!admitted.includes(origin) && flaw !== 'bavard') return;
    const send = (type, payload, re) => {
      const m = { v: 1, type, id: ulid(), payload };
      if (re) m.re = re;
      if (flaw === 'champ-en-trop') m.ts = Date.now();
      parent.postMessage(m, origin);
      return m.id;
    };
    const ack = (re) => send('evora:ack', { ok: true }, re);
    addEventListener('message', async (e) => {
      if (flaw !== 'etranger' && (e.source !== parent || e.origin !== origin)) return;
      const d = e.data;
      if (d === null || typeof d !== 'object' || (d.v !== 1 && flaw !== 'v2')) return;
      if (st.seen.has(d.id)) return;
      st.seen.add(d.id);
      const p = d.payload || {};
      if (d.type === 'evora:init') {
        if (st.inited || d.re !== st.readyId) return;
        st.inited = true;
        st.ns = p.storageNs;
        if (flaw !== 'sans-purge-init') await purge({ keep: st.ns });
        if (flaw === 'ecriture-au-demarrage') localStorage.setItem('egui_memory_ron', '{}');
        st.language = p.engineLang || 'en';
        st.dark = p.theme === 'dark';
        ack(d.id);
      } else if (d.type === 'evora:open' && st.inited) {
        if (flaw !== 'ouverture-feinte') { st.photos += 1; st.active = p.name; }
        if (flaw === 'ecriture-en-seance') await put('library/catalog.snap');
        if (offName[flaw]) await offName[flaw]();
        ack(d.id);
      } else if (d.type === 'evora:lang' && st.inited) {
        if (flaw !== 'langue-ignoree') st.language = p.engineLang || 'en';
        ack(d.id);
      } else if (d.type === 'evora:theme' && st.inited) {
        st.dark = p.theme === 'dark';
        ack(d.id);
      } else if (d.type === 'evora:purge' && st.inited) {
        const scope = p.scope === 'all' && flaw !== 'purge-all-partielle' ? { all: true } : { current: st.ns };
        if (flaw === 'accuse-avant-purge') { ack(d.id); await sleep(1500); await purge(scope); return; }
        await purge(scope);
        ack(d.id);
        if (flaw === 'ecriture-apres-purge') setTimeout(() => put('lightcraft-ns-' + st.ns + '/library/catalog.snap'), 300);
      }
    });
    const caps = ['doc.open', 'storage.memory', 'storage.purge', 'live.lang', 'live.theme'];
    if (flaw === 'capacite-en-trop') caps.push('doc.save');
    const payload = { app: 'revela', version: '0.7.1', ehp: '1.0', capabilities: caps };
    st.readyId = send('evora:ready', payload);
    if (flaw === 'double-ready') send('evora:ready', payload);
  })();
})();
`;

// --- Jugement -----------------------------------------------------------------------------------

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const show = (o) => JSON.stringify(o);
// Une liste de l'observateur ne prouve quelque chose que lisible et complète (les cinq types).
const readable = (s) => !!s && !s.error && KINDS.every((k) => Array.isArray(s[k]));
// Entrées « <type> <nom> » d'une liste (ou d'un ensemble de noms attendus), éventuellement filtrées.
const entries = (s, keep = () => true) => KINDS.flatMap((k) => ((s && Array.isArray(s[k])) ? s[k] : []).filter((n) => keep(k, n)).map((n) => `${k} ${n}`));
const minus = (a, b) => a.filter((e) => !b.includes(e));
// Le stockage du moteur : TOUT ce qui n'est pas aux autres moteurs, quel que soit le nom.
const own = (s) => entries(s, (k, n) => !FOREIGN[k].includes(n));
const missing = (s, want) => minus(entries(want), entries(s));
// Ce que contient l'espace du compte, en entrées comparables.
const inNsOf = (s) => (s.inNs || []).map((n) => `espace ${n}`);

// Une purge accusée : stockage du moteur (tout nom hors autres moteurs) vide AU MOMENT de l'accusé,
// autres moteurs intacts, rien d'apparu ensuite. Une liste illisible rougit (prémisse dans l'assertion).
const judgePurge = (r, tag, what, errors) => {
  if (!readable(r && r.atAck)) {
    errors.push(`[ehp-seed] liste du stockage à l'accusé de ${what} illisible (le banc ne prouverait rien) : ${show(r && r.atAck)}`);
    return;
  }
  const left = own(r.atAck);
  if (left.length) errors.push(`${tag} stockage du moteur non vide à l'accusé de ${what} (jugé quel que soit le nom) : ${left.join(', ')}`);
  const gone = missing(r.atAck, FOREIGN);
  if (gone.length) errors.push(`[ehp-overpurge] ${what} a touché le stockage d'un autre moteur : ${gone.join(', ')}`);
  if (!readable(r.later)) {
    errors.push(`[ehp-seed] liste du stockage après ${what} illisible : ${show(r.later)}`);
    return;
  }
  const late = minus(entries(r.later), entries(r.atAck));
  if (late.length) errors.push(`[ehp-late-write] le moteur a écrit après ${what} : ${late.join(', ')}`);
};

// Les étapes du scénario « pont-ehp », vues de la coquille (log) et du moteur (web.stats).
export async function runEhp({ evalPage, engineStats, errors, result }) {
  const step = async (name) => {
    const t0 = Date.now();
    const raw = await evalPage(`window.__ehp.run(${JSON.stringify(name)})`);
    const r = JSON.parse(raw || 'null') || { error: 'étape sans résultat' };
    (result.ehpSteps ||= {})[name] = r;
    (result.ehpMs ||= {})[name] = Date.now() - t0;
    return r;
  };
  const okAck = (r, name) => {
    if (!r || !r.ack || r.ack.ok !== true) errors.push(`[ehp-ack] accusé de evora:${name} absent ou négatif : ${show(r && r.ack)}`);
  };
  // l'evora:ready a dû arriver pendant le démarrage
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const n = Number(await evalPage(`String((window.__ehp && window.__ehp.log.filter((m) => m.fromEngine && m.type === 'evora:ready').length) || 0)`));
    if (n > 0) break;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  const seed = await step('seed');
  const seededWant = [...entries(SEEDED_LC), ...entries(FOREIGN)];
  const seeded = readable(seed) ? minus(seededWant, entries(seed)) : ['tout'];
  if (seeded.length) errors.push(`[ehp-seed] amorçage du stockage raté (le banc ne prouverait rien) : ${seed && seed.error ? seed.error : seeded.join(', ')}`);

  const init = await step('init');
  okAck(init, 'init');
  const s1 = await engineStats();
  result.ehpStats = { init: s1 };
  if (s1.language !== 'fr' || !s1.theme || s1.theme.dark !== true || s1.theme.evora !== true || s1.theme.accent !== '#4f46e5' || s1.storage !== 'memory') {
    errors.push(`[ehp-init] evora:init non appliqué (attendu fr, sombre, Evora #4f46e5, mémoire) : ${show({ language: s1.language, theme: s1.theme, storage: s1.storage })}`);
  }
  const afterInit = readable(init && init.storage) ? init.storage : null;
  if (!afterInit) errors.push(`[ehp-seed] liste du stockage après init illisible : ${show(init && init.storage)}`);
  else {
    // il ne reste du moteur que l'espace du compte (non vidé) ; un nom jamais amorcé est une écriture
    const kept = entries(KEPT_AFTER_INIT);
    const extra = minus(own(afterInit), kept);
    const remnants = extra.filter((e) => entries(SEEDED_LC).includes(e));
    const written = minus(extra, remnants);
    const lost = minus(kept, own(afterInit));
    if (remnants.length || lost.length || !(afterInit.inNs || []).length) {
      errors.push(`[ehp-purge-init] purge de démarrage : il doit ne rester que l'espace du compte (${kept.join(', ')}, non vidé) ; restes ${show(remnants)}, manquants ${show(lost)}, contenu de l'espace ${show(afterInit.inNs)}`);
    }
    if (written.length) errors.push(`[ehp-init-write] le moteur a écrit dans le stockage au démarrage (jugé quel que soit le nom) : ${written.join(', ')}`);
    const gone = missing(afterInit, FOREIGN);
    if (gone.length) errors.push(`[ehp-overpurge] la purge a touché le stockage d'un autre moteur : ${gone.join(', ')}`);
  }

  const before = s1.photos;
  const open = await step('open');
  okAck(open, 'open');
  if (open && open.transferred !== true) errors.push(`[ehp-open] les octets n'ont pas été transférés (${show(open)})`);
  let s2 = await engineStats();
  // la photo ouverte doit être rendue (vignette), sans échec, une fois le rendu au repos
  const settle = Date.now() + 30000;
  while (Date.now() < settle && !(s2.activeThumb && s2.renderQueue === 0 && s2.rendersInFlight === 0)) {
    await new Promise((ok) => setTimeout(ok, 300));
    s2 = await engineStats();
  }
  result.ehpStats.open = s2;
  if (s2.photos !== before + 1 || s2.active !== PHOTO || s2.activeThumb !== true || s2.activeFailure) {
    errors.push(`[ehp-open] photo non ouverte ou non rendue (photos ${before} -> ${s2.photos}, active ${show(s2.active)}, vignette ${s2.activeThumb}, échec ${show(s2.activeFailure)})`);
  }

  const lang = await step('lang');
  okAck(lang, 'lang');
  const s3 = await engineStats();
  if (s3.language !== 'de') errors.push(`[ehp-live] evora:lang non appliqué (langue ${s3.language}, attendue de)`);
  const theme = await step('theme');
  okAck(theme, 'theme');
  const s4 = await engineStats();
  if (!s4.theme || s4.theme.dark !== false || s4.theme.evora !== true) errors.push(`[ehp-live] evora:theme non appliqué (${show(s4.theme)}, attendu clair Evora)`);

  const strangers = await step('strangers');
  const s5 = await engineStats();
  if (s5.language !== 'de') errors.push(`[ehp-foreign] un evora:lang étranger a été appliqué (langue ${s5.language})`);
  const ids = JSON.parse(await evalPage('JSON.stringify(window.__ehp.ids)') || '{}');
  if ((ids.strangerErrors || []).length) errors.push(`[ehp-seed] les pages étrangères n'ont pas pu écrire au moteur : ${show(ids.strangerErrors)}`);
  // pendant la séance (ouverture, langue, thème, messages étrangers), en mode mémoire : rien ne
  // change dans le stockage de l'origine, quel que soit le nom
  if (afterInit) {
    if (!readable(strangers && strangers.storage)) errors.push(`[ehp-seed] liste du stockage après la séance illisible : ${show(strangers && strangers.storage)}`);
    else {
      const a = [...entries(afterInit), ...inNsOf(afterInit)];
      const b = [...entries(strangers.storage), ...inNsOf(strangers.storage)];
      const removed = minus(a, b);
      const added = minus(b, a);
      if (removed.length) errors.push(`[ehp-foreign] du stockage a disparu pendant la séance (purge étrangère suivie d'effet) : ${removed.join(', ')}`);
      if (added.length) errors.push(`[ehp-session-write] le moteur a écrit dans le stockage pendant la séance (jugé quel que soit le nom) : ${added.join(', ')}`);
    }
  }

  const purge = await step('purge');
  okAck(purge, 'purge');
  judgePurge(purge, '[ehp-purge-ack]', 'evora:purge {scope: "current"}', errors);

  const all = await step('purgeAll');
  const reseeded = readable(all && all.seeded) ? minus(seededWant, entries(all.seeded)) : ['tout'];
  if (reseeded.length) errors.push(`[ehp-seed] second amorçage du stockage raté : ${all && all.seeded && all.seeded.error ? all.seeded.error : reseeded.join(', ')}`);
  okAck(all, 'purge (all)');
  judgePurge(all, '[ehp-purge-all]', 'evora:purge {scope: "all"}', errors);

  // Le journal complet de la coquille : enveloppes, réponses interdites, evora:ready.
  const log = JSON.parse(await evalPage('JSON.stringify(window.__ehp.log)') || '[]');
  result.ehp = { log: log.map((m) => ({ type: m.type, re: m.re, payload: m.payload })), ids };
  judgeLog(log, ids, errors);
}

export function judgeLog(log, ids, errors) {
  for (const m of log) {
    const keysOk = m.keys.every((k) => ['v', 'type', 'id', 're', 'payload'].includes(k)) && ['v', 'type', 'id', 'payload'].every((k) => m.keys.includes(k));
    if (!m.fromEngine || !m.plain || m.v !== 1 || !keysOk || !ULID.test(m.id || '') || (m.re !== null && !ULID.test(m.re)) || !m.payloadPlain) {
      errors.push(`[ehp-envelope] message hors norme ou d'une autre source : ${show({ origin: m.origin, fromEngine: m.fromEngine, keys: m.keys, v: m.v, type: m.type })}`);
    }
  }
  const ready = log.filter((m) => m.type === 'evora:ready');
  if (ready.length !== 1) errors.push(`[ehp-ready] evora:ready reçu ${ready.length} fois (attendu : 1)`);
  else {
    const p = ready[0].payload || {};
    if (p.app !== 'revela' || p.ehp !== '1.0' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(p.version || '') || Object.keys(p).some((k) => !['app', 'version', 'ehp', 'capabilities'].includes(k))) {
      errors.push(`[ehp-ready] evora:ready inattendu : ${show(p)}`);
    }
    if (!Array.isArray(p.capabilities) || !sameSet(p.capabilities, EXERCISED)) {
      errors.push(`[ehp-caps] capacités déclarées ${show(p.capabilities)} ; le banc n'exerce que ${show(EXERCISED)}`);
    }
  }
  if (ids.bogus && log.some((m) => m.re === ids.bogus)) errors.push('[ehp-v2] le moteur a répondu à un message de version 2');
  const foreign = log.filter((m) => (ids.foreign || []).includes(m.re));
  if (foreign.length) errors.push(`[ehp-foreign] le moteur a répondu à un message d'une origine non admise ou d'une autre fenêtre : ${foreign.map((m) => m.type).join(', ')}`);
  for (const m of log.filter((x) => x.type === 'evora:ack')) {
    const p = m.payload || {};
    if (typeof p.ok !== 'boolean' || Object.keys(p).some((k) => !['ok', 'code', 'result'].includes(k)) || (p.ok === false && typeof p.code !== 'string')) {
      errors.push(`[ehp-envelope] evora:ack hors schéma : ${show(p)}`);
    }
  }
}

// Scénario « pont-muet » : evora-host.json de l'artefact (vide) ; aucun message, jamais.
export async function runMute({ evalPage, errors, result, site, readFileSync, join }) {
  let shipped = null;
  try { shipped = JSON.parse(readFileSync(join(site, 'evora-host.json'), 'utf8')); } catch (e) { shipped = { error: String(e) }; }
  result.shippedHostConfig = shipped;
  if (!shipped || !Array.isArray(shipped.parentOrigins) || shipped.parentOrigins.length !== 0 || Object.keys(shipped).length !== 1) {
    errors.push(`[ehp-mute] evora-host.json de l'artefact absent ou non vide : ${show(shipped)}`);
  }
  await new Promise((ok) => setTimeout(ok, 3000));
  const log = JSON.parse(await evalPage('JSON.stringify((window.__ehp && window.__ehp.log) || [])') || '[]');
  result.ehp = { log: log.map((m) => ({ type: m.type, origin: m.origin })) };
  if (log.length) errors.push(`[ehp-mute] le moteur a parlé sans origine parente admise : ${log.map((m) => m.type).join(', ')}`);
}
