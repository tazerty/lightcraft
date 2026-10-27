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
// EVORA-REV-29 : deuxième photo (ouverte par la coquille), troisième (par le sélecteur d'Evora).
export const PHOTO2 = 'seconde-photo.jpg';
export const PHOTO3 = 'troisieme-photo.jpg';
// Ce que le scénario exerce : le moteur doit déclarer exactement cela, ni plus ni moins.
export const EXERCISED = ['doc.open', 'doc.save', 'doc.saved-ack', 'doc.dirty', 'doc.multi', 'doc.request-save', 'export.drive', 'pick.drive',
  'command', 'storage.memory', 'storage.purge', 'live.lang', 'live.theme', 'ui.focus-out'];
// La liste blanche compilée du moteur (Revela, CdC §5.3) ; toute autre commande est refusée (capability).
export const COMMANDS = ['revela.apply', 'develop.get', 'develop.controls'];

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
  // EVORA-REV-29 : pont d'enregistrement, commandes, exports, sélecteur, sortie au clavier
  ['sauve-sans-accuse', '[ehp-sack]'],
  ['enveloppe-fausse', '[ehp-envelope-save]'],
  ['commande-ouverte', '[ehp-command]'],
  ['application-ignoree', '[ehp-apply]'],
  ['modifie-sans-docref', '[ehp-dirty]'],
  ['export-permute', '[ehp-export-docref]'],
  ['telechargement', '[ehp-download]'],
  ['selecteur-absent', '[ehp-pick]'],
  ['sans-focus-out', '[ehp-focus-out]'],
  ['demo-au-demarrage', '[ehp-boot-neutral]'],
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

// EVORA-REV-29 : chargé avant tout autre script de la page du moteur (vrai ou factice) dans le banc :
// relève tout téléchargement par lien (<a download>.click()), le repli download() de l'amont. Le banc
// exige 0 ; Chrome est en plus réglé pour annoncer tout téléchargement (Browser.downloadWillBegin).
export const SENTINEL_JS = `'use strict';
(() => {
  const seen = [];
  Object.defineProperty(globalThis, '__evoraDownloads', { value: seen });
  // HTMLElement.prototype.click : la méthode qu'appelle <a>.click(), y compris par les liaisons web-sys
  const E = globalThis.HTMLElement;
  if (!E) return;
  const click = E.prototype.click;
  E.prototype.click = function () {
    if (this instanceof HTMLAnchorElement && this.hasAttribute('download')) seen.push(String(this.getAttribute('download') || '?'));
    return click.call(this);
  };
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
    // EVORA-REV-29 : octets d'evora:save (enveloppe revela-save) et d'evora:export (début du fichier)
    const bytes = plain && plainOf(d.payload) ? d.payload.bytes : undefined;
    if (bytes !== undefined) {
      entry.binary = bytes instanceof ArrayBuffer;
      if (entry.binary && d.type === 'evora:save') {
        try { entry.envelope = JSON.parse(new TextDecoder().decode(bytes)); } catch (err) { entry.envelope = { error: String(err) }; }
      }
      if (entry.binary && d.type === 'evora:export') entry.magic = Array.from(new Uint8Array(bytes.slice(0, 3)), (b) => b.toString(16).padStart(2, '0')).join('');
    }
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
  // EVORA-REV-29 : échanges paramétrés que smoke.mjs déroule (ehp-bench.mjs, runDocs).
  const photo = async (fg, bg) => {
    const c = new OffscreenCanvas(96, 64);
    const g = c.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, 96, 64); g.fillStyle = fg; g.fillRect(24, 16, 48, 32);
    return (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer();
  };
  const plainEntry = (m) => (m ? { type: m.type, id: m.id, re: m.re, payload: m.payload, envelope: m.envelope, magic: m.magic, binary: m.binary, t: m.t } : null);
  const api = {
    // une requête de la coquille et la première réponse du moteur dont le type est attendu
    req: async (type, payload, replies, ms) => {
      const id = ulid();
      const at = log.length;
      toEngine({ v: 1, type, id, payload });
      const reply = await waitFor((m) => m.fromEngine && m.re === id && replies.includes(m.type), ms || 15000);
      return { id, at, reply: plainEntry(reply) };
    },
    // une réponse de la coquille (evora:saved, evora:ack) à un message du moteur
    answer: async (type, re, payload) => { toEngine({ v: 1, type, id: ulid(), re, payload }); return { ok: true }; },
    // ouvre une photo neuve (octets transférés) sous un docRef neuf
    open: async (name, fg, bg) => {
      const bytes = await photo(fg, bg);
      const id = ulid();
      const docRef = ulid();
      const at = log.length;
      toEngine({ v: 1, type: 'evora:open', id, payload: { docRef, name, bytes } }, [bytes]);
      const ack = await ackOf(id, 60000);
      return { id, docRef, at, ack: ack && ack.payload, transferred: bytes.byteLength === 0 };
    },
    // attend un message du moteur depuis l'indice at (type, et charge partielle égale)
    wait: async (at, type, like, ms) => {
      const fits = (m) => m.fromEngine && m.type === type && Object.entries(like || {}).every(([k, v]) => (m.payload || {})[k] === v);
      const old = log.slice(at).find(fits);
      return plainEntry(old || await waitFor(fits, ms || 8000));
    },
    // les messages du moteur depuis l'indice at
    since: async (at) => log.slice(at).filter((m) => m.fromEngine).map(plainEntry),
    mark: async () => log.length,
    // la coquille répond « open » à un evora:pick : une photo neuve, puis l'accusé de clôture
    servePick: async (pickId, name) => {
      const opened = await api.open(name, '#111827', '#F59E0B');
      toEngine({ v: 1, type: 'evora:ack', id: ulid(), re: pickId, payload: { ok: true } });
      return opened;
    },
  };
  const wrap = (f) => async (...a) => JSON.stringify(await f(...a));
  window.__ehp = { log, ids, run: async (step) => JSON.stringify(await steps[step]()),
    req: wrap(api.req), answer: wrap(api.answer), open: wrap(api.open), wait: wrap(api.wait), since: wrap(api.since), mark: wrap(api.mark),
    servePick: wrap(api.servePick), ulid };
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
<body><canvas id="lightcraft_canvas" width="320" height="200"></canvas><script src="/__evora/sentinel.js"></script><script src="witness.js"></script></body></html>`;

// Un pont EHP écrit en JavaScript, conforme sauf le défaut demandé par ?flaw= (un seul à la fois).
// EVORA-REV-29 : documents de la coquille (un docRef par photo), enveloppe revela-save, accusé
// d'enregistrement, liste blanche de commandes, exports vers Drive, sélecteur d'Evora, F6 et Ctrl+S.
export const WITNESS_JS = `'use strict';
(() => {
  const flaw = new URLSearchParams(location.search).get('flaw') || 'aucun';
  const C = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const ulid = () => Array.from(crypto.getRandomValues(new Uint8Array(26)), (b) => C[b & 31]).join('');
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const st = { language: 'en', dark: true, evora: true, photos: flaw === 'demo-au-demarrage' ? 24 : 0, ns: '', inited: false, readyId: null,
    seen: new Set(), caps: [], docs: [], active: null, nextPhoto: 100 };
  const docOf = (ref) => st.docs.find((d) => d.docRef === ref) || null;
  const activeDoc = () => docOf(st.active);
  let send = () => null;
  const tellDirty = (d) => {
    const dirty = d.exposure !== d.baseline;
    if (d.told === dirty) return;
    d.told = dirty;
    send('evora:dirty', flaw === 'modifie-sans-docref' ? { dirty } : { dirty, docRef: d.docRef });
  };
  const xmpOf = (d) => '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><lc:settings>'
    + JSON.stringify({ light: { exposure: d.exposure } }) + '</lc:settings></x:xmpmeta><?xpacket end="w"?>';
  const saveDoc = (d, re) => {
    const env = { format: 'revela-save', version: 1, settings: { light: { exposure: d.exposure }, process: 2 }, process: 2, engine: '0.14.0',
      meta: { rating: 0, label: null, flag: 'none' }, xmp: xmpOf(d) };
    if (flaw === 'enveloppe-fausse') delete env.xmp;
    const bytes = new TextEncoder().encode(JSON.stringify(env)).buffer;
    const id = send('evora:save', { docRef: d.docRef, name: d.name + '.revela.json', saveAs: false, bytes }, re, [bytes]);
    d.inflight.push({ id, exposure: d.exposure });
    if (flaw === 'sauve-sans-accuse') { d.baseline = d.exposure; tellDirty(d); }
  };
  const exportFile = (d, other) => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]).buffer;
    const name = d.name.replace(/\\.[^.]*$/, '') + '.jpg';
    if (flaw === 'telechargement') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      a.download = name;
      a.click();
      return;
    }
    const docRef = flaw === 'export-permute' && other ? other.docRef : d.docRef;
    send('evora:export', { docRef, name, mime: 'image/jpeg', bytes }, null, [bytes]);
  };
  globalThis.lightcraft = { command: async (id, text) => {
    const p = JSON.parse(text || '{}');
    if (id === 'web.stats') {
      const a = activeDoc();
      return JSON.stringify({ language: st.language, theme: { evora: st.evora, dark: st.dark, accent: '#4f46e5' }, storage: 'memory',
        photos: st.photos, active: a ? a.name : null, activeThumb: !!a, activeFailure: null, renderQueue: 0, rendersInFlight: 0,
        host: { docs: st.docs.map((d) => ({ docRef: d.docRef, photo: d.photo, name: d.name, dirty: d.exposure !== d.baseline, inFlight: d.inflight.length })),
          active: st.active, autoWrite: false, neutral: { bench: false, backup: false, restore: false } } });
    }
    if (id === 'develop.set') {
      const d = activeDoc();
      if (!d) throw new Error('no photo');
      d.exposure = p.value;
      setTimeout(() => tellDirty(d), 50);
      return JSON.stringify({ ok: true });
    }
    if (id === 'app.export') {
      const list = (p.ids || []).map((n) => st.docs.find((d) => d.photo === n)).filter(Boolean);
      list.forEach((d, i) => exportFile(d, list[(i + 1) % list.length]));
      return JSON.stringify({ files: list.map((d) => d.name) });
    }
    if (id === 'file.addPhotos') {
      if (flaw !== 'selecteur-absent') {
        send('evora:pick', { purpose: 'open', accept: ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp', '.dng'], multiple: true });
      }
      return 'null';
    }
    throw new Error('commande inconnue');
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
  const command = (p) => {
    if (!${JSON.stringify(COMMANDS)}.includes(p.command) && flaw !== 'commande-ouverte') return { ok: false, code: 'capability' };
    if (flaw === 'commande-ouverte' && !${JSON.stringify(COMMANDS)}.includes(p.command)) return { ok: true, result: null };
    const q = p.params || {};
    if (p.command === 'develop.controls') return { ok: true, result: [{ id: 'light.exposure', value: (activeDoc() || {}).exposure || 0 }] };
    const d = docOf(q.docRef);
    if (typeof q.docRef !== 'string') return { ok: false, code: 'invalid_content' };
    if (!d) return { ok: false, code: 'not_found' };
    if (p.command === 'develop.get') return { ok: true, result: { light: { exposure: d.exposure }, process: 2 } };
    const hasS = 'settings' in q;
    const hasX = 'xmp' in q;
    if (hasS === hasX) return { ok: false, code: 'invalid_content' };
    let exposure = d.exposure;
    if (hasS) exposure = ((q.settings || {}).light || {}).exposure ?? exposure;
    else {
      const m = /<lc:settings>(.*?)<\\/lc:settings>/.exec(String(q.xmp));
      if (!m) return { ok: false, code: 'invalid_content' };
      exposure = ((JSON.parse(m[1]) || {}).light || {}).exposure ?? exposure;
    }
    if (flaw !== 'application-ignoree') d.exposure = exposure;
    if (q.baseline !== false) d.baseline = d.exposure;
    tellDirty(d);
    return { ok: true, result: { applied: true, dirty: d.exposure !== d.baseline } };
  };
  (async () => {
    if (window.parent === window) return;
    const cfg = await (await fetch('evora-host.json', { cache: 'no-store' })).json();
    const admitted = Array.isArray(cfg.parentOrigins) ? cfg.parentOrigins : [];
    const origin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '';
    if (!admitted.includes(origin) && flaw !== 'bavard') return;
    send = (type, payload, re, transfer) => {
      const m = { v: 1, type, id: ulid(), payload };
      if (re) m.re = re;
      if (flaw === 'champ-en-trop') m.ts = Date.now();
      parent.postMessage(m, origin, transfer || []);
      return m.id;
    };
    const ack = (re, extra) => send('evora:ack', Object.assign({ ok: true }, extra || {}), re);
    addEventListener('keydown', (e) => {
      if (e.key === 'F6' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && st.caps.includes('ui.focus-out')) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (flaw !== 'sans-focus-out') send('evora:focus-out', {});
      } else if (e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey) && st.caps.includes('doc.save')) {
        e.preventDefault(); e.stopImmediatePropagation();
        const d = activeDoc();
        if (d && d.exposure !== d.baseline) saveDoc(d, null);
      }
    }, true);
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
        st.caps = p.capabilities || [];
        if (flaw !== 'sans-purge-init') await purge({ keep: st.ns });
        if (flaw === 'ecriture-au-demarrage') localStorage.setItem('egui_memory_ron', '{}');
        st.language = p.engineLang || 'en';
        st.dark = p.theme === 'dark';
        ack(d.id);
      } else if (d.type === 'evora:open' && st.inited) {
        if (flaw !== 'ouverture-feinte') {
          st.photos += 1;
          st.docs.push({ docRef: p.docRef, name: p.name, photo: (st.nextPhoto += 1), exposure: 0, baseline: 0, told: null, inflight: [] });
          st.active = p.docRef;
        }
        if (flaw === 'ecriture-en-seance') await put('library/catalog.snap');
        if (offName[flaw]) await offName[flaw]();
        ack(d.id);
        const doc = docOf(p.docRef);
        if (doc) { tellDirty(doc); send('evora:active', { docRef: doc.docRef }); }
      } else if (d.type === 'evora:lang' && st.inited) {
        if (flaw !== 'langue-ignoree') st.language = p.engineLang || 'en';
        ack(d.id);
      } else if (d.type === 'evora:theme' && st.inited) {
        st.dark = p.theme === 'dark';
        ack(d.id);
      } else if (d.type === 'evora:request-save' && st.inited) {
        const targets = p.docRef ? [docOf(p.docRef)] : st.docs.slice();
        if (p.docRef && !targets[0]) { ack(d.id, { ok: false, code: 'not_found' }); return; }
        let re = d.id;
        for (const t of targets) if (t.exposure !== t.baseline) { saveDoc(t, re); re = null; }
        if (re) ack(d.id, { code: 'clean' });
      } else if (d.type === 'evora:saved' && st.inited) {
        const doc = st.docs.find((x) => x.inflight.some((f) => f.id === d.re));
        if (!doc) return;
        const f = doc.inflight.splice(doc.inflight.findIndex((x) => x.id === d.re), 1)[0];
        if (p.ok && flaw !== 'sauve-sans-accuse') { doc.baseline = f.exposure; tellDirty(doc); }
      } else if (d.type === 'evora:command' && st.inited) {
        const r = command(p);
        send('evora:ack', r.ok ? { ok: true, result: r.result } : { ok: false, code: r.code }, d.id);
      } else if (d.type === 'evora:activate' && st.inited) {
        const doc = docOf(p.docRef);
        if (!doc) { ack(d.id, { ok: false, code: 'not_found' }); return; }
        const was = st.active;
        st.active = doc.docRef;
        ack(d.id);
        if (was !== doc.docRef) send('evora:active', { docRef: doc.docRef });
      } else if (d.type === 'evora:purge' && st.inited) {
        const scope = p.scope === 'all' && flaw !== 'purge-all-partielle' ? { all: true } : { current: st.ns };
        if (flaw === 'accuse-avant-purge') { ack(d.id); await sleep(1500); await purge(scope); return; }
        await purge(scope);
        ack(d.id);
        if (flaw === 'ecriture-apres-purge') setTimeout(() => put('lightcraft-ns-' + st.ns + '/library/catalog.snap'), 300);
      }
    });
    const caps = ${JSON.stringify(EXERCISED)};
    if (flaw === 'capacite-en-trop') caps.push('media.need');
    const payload = { app: 'revela', version: '0.14.0', ehp: '1.0', capabilities: caps };
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
export async function runEhp(ctx) {
  const { evalPage, engineStats, errors, result } = ctx;
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

  // EVORA-REV-29 : démarrage neutre sous le pont (ni photos de démonstration, ni ?bench, ni
  // sauvegarde ou restauration de photothèque, écriture automatique du XMP coupée)
  const h1 = s1.host || {};
  const neutral = h1.neutral || {};
  if (s1.photos !== 0 || neutral.bench !== false || neutral.backup !== false || neutral.restore !== false || h1.autoWrite !== false
    || !Array.isArray(h1.docs) || h1.docs.length !== 0) {
    errors.push(`[ehp-boot-neutral] démarrage sous le pont non neutre (attendu 0 photo, ni banc, ni sauvegarde, ni restauration, XMP manuel) : ${show({ photos: s1.photos, host: s1.host })}`);
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
  const ids0 = JSON.parse(await evalPage('JSON.stringify(window.__ehp.ids)') || '{}');
  await runDocs({ ...ctx, docA: ids0.docRef, openId: ids0.open });

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
  // EVORA-REV-29 : schémas des messages du pont d'enregistrement (HOST-PROTOCOL §4.4, §7.10)
  const known = ['evora:ready', 'evora:failed', 'evora:ack', 'evora:dirty', 'evora:save', 'evora:export', 'evora:pick', 'evora:focus-out',
    'evora:active', 'evora:closed'];
  for (const m of log.filter((x) => x.fromEngine)) {
    const p = m.payload || {};
    const keys = Object.keys(p);
    if (!known.includes(m.type)) errors.push(`[ehp-envelope] type de message inattendu : ${show(m.type)}`);
    if (m.type === 'evora:dirty' && (typeof p.dirty !== 'boolean' || !ULID.test(p.docRef || '') || keys.some((k) => !['dirty', 'docRef'].includes(k)))) {
      errors.push(`[ehp-dirty] evora:dirty hors schéma ou sans docRef (doc.multi) : ${show(p)}`);
    }
    if (m.type === 'evora:save' && (!ULID.test(p.docRef || '') || typeof p.name !== 'string' || p.saveAs !== false || !m.binary
      || keys.some((k) => !['docRef', 'name', 'saveAs', 'bytes'].includes(k)))) {
      errors.push(`[ehp-envelope-save] evora:save hors schéma : ${show({ payload: p, binary: m.binary })}`);
    }
    if (m.type === 'evora:export' && ((p.docRef !== undefined && !ULID.test(p.docRef)) || typeof p.name !== 'string' || typeof p.mime !== 'string' || !m.binary
      || keys.some((k) => !['docRef', 'name', 'mime', 'bytes'].includes(k)))) {
      errors.push(`[ehp-export-docref] evora:export hors schéma : ${show({ payload: p, binary: m.binary })}`);
    }
    if (['evora:active', 'evora:closed'].includes(m.type) && (!ULID.test(p.docRef || '') || keys.length !== 1)) {
      errors.push(`[ehp-multi] ${m.type} hors schéma : ${show(p)}`);
    }
    if (m.type === 'evora:focus-out' && keys.length) errors.push(`[ehp-focus-out] evora:focus-out porte une charge : ${show(p)}`);
  }
}

// --- EVORA-REV-29 : documents de la coquille, enregistrement, commandes, exports, sélecteur, clavier --------------

// L'enveloppe revela-save v1 (CdC de Revela §5.2), jugée sans interpréter le XMP.
const judgeEnvelope = (env, exposure, version, errors, what) => {
  const keys = ['format', 'version', 'settings', 'process', 'engine', 'meta', 'xmp'];
  const e = env || {};
  const problems = [];
  if (e.format !== 'revela-save' || e.version !== 1) problems.push('format ou version');
  if (!e.settings || typeof e.settings !== 'object' || Array.isArray(e.settings)) problems.push('settings');
  else if (exposure !== undefined && Math.abs(((e.settings.light || {}).exposure ?? NaN) - exposure) > 1e-6) problems.push(`settings.light.exposure ${show((e.settings.light || {}).exposure)} au lieu de ${exposure}`);
  if (e.process === undefined || e.process === null) problems.push('process');
  if (e.engine !== version) problems.push(`engine ${show(e.engine)} au lieu de ${version}`);
  if (!e.meta || typeof e.meta !== 'object' || !('rating' in e.meta) || !('label' in e.meta) || !('flag' in e.meta)) problems.push('meta {rating, label, flag}');
  if (typeof e.xmp !== 'string' || !/^\s*(<\?xpacket|<x:xmpmeta)/.test(e.xmp)) problems.push('xmp');
  if (Object.keys(e).some((k) => !keys.includes(k))) problems.push('champ en trop');
  if (problems.length) errors.push(`[ehp-envelope-save] enveloppe de ${what} non conforme (${problems.join(', ')}) : ${show(env).slice(0, 300)}`);
};

export async function runDocs({ evalPage, engineStats, engineEval, downloads, errors, result, docA, openId }) {
  const call = async (fn, ...args) => JSON.parse(await evalPage(`window.__ehp.${fn}(...${JSON.stringify(args)})`) || 'null');
  const engine = async (id, params) => {
    try {
      return { ok: true, value: JSON.parse(await engineEval(`globalThis.lightcraft.command(${JSON.stringify(id)}, ${JSON.stringify(JSON.stringify(params || {}))})`, 60000)) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  };
  const docs = async () => ((await engineStats()).host || {}).docs || [];
  const docOf = async (ref) => (await docs()).find((d) => d.docRef === ref) || null;
  const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const trace = (result.ehpDocs ||= []);
  const note = (k, v) => trace.push({ [k]: v });
  const version = (((await call('since', 0)) || []).find((m) => m.type === 'evora:ready') || { payload: {} }).payload.version;
  const cmd = async (command, params) => (await call('req', 'evora:command', { command, params }, ['evora:ack'], 20000)).reply;
  const dirtyMsgs = (list, ref, value) => list.filter((m) => m.type === 'evora:dirty' && m.payload.docRef === ref && (value === undefined || m.payload.dirty === value));

  // 1. La photo ouverte est un document propre, et le document devant
  const fromOpen = await call('since', 0);
  const openAck = fromOpen.findIndex((m) => m.type === 'evora:ack' && m.re === openId);
  const afterOpen = openAck >= 0 ? fromOpen.slice(openAck) : [];
  await pause(1500);
  const settled = [...afterOpen, ...(await call('since', 0)).slice(fromOpen.length)];
  if (!dirtyMsgs(settled, docA, false).length || dirtyMsgs(settled, docA, true).length) {
    errors.push(`[ehp-dirty] après l'ouverture, evora:dirty {dirty: false, docRef} attendu, sans modification : ${show(settled.filter((m) => m.type === 'evora:dirty').map((m) => m.payload))}`);
  }
  if (!settled.some((m) => m.type === 'evora:active' && m.payload.docRef === docA)) errors.push(`[ehp-multi] pas d'evora:active pour le document ouvert ${docA}`);
  const dA = await docOf(docA);
  if (!dA || dA.dirty !== false) errors.push(`[ehp-dirty] web.stats ne montre pas le document ${docA} propre : ${show(await docs())}`);
  const photoA = dA ? dA.photo : null;

  // 2. revela.apply {settings} : appliqué, comme base (aucune modification annoncée)
  let at = await call('mark');
  const apply = await cmd('revela.apply', { docRef: docA, settings: { light: { exposure: 0.75 } } });
  note('applySettings', apply && apply.payload);
  if (!apply || apply.payload.ok !== true || !apply.payload.result || apply.payload.result.applied !== true || apply.payload.result.dirty !== false) {
    errors.push(`[ehp-apply] revela.apply {settings} non appliqué ou annoncé modifié : ${show(apply && apply.payload)}`);
  }
  const getA = await cmd('develop.get', { docRef: docA });
  if (!getA || getA.payload.ok !== true || Math.abs((((getA.payload.result || {}).light || {}).exposure ?? NaN) - 0.75) > 1e-6) {
    errors.push(`[ehp-apply] develop.get après revela.apply : exposition 0.75 attendue : ${show(getA && getA.payload).slice(0, 200)}`);
  }
  await pause(600);
  if (dirtyMsgs(await call('since', at), docA, true).length) errors.push('[ehp-apply] revela.apply {baseline par défaut} a marqué la photo modifiée');

  // 3. Machine d'enregistrement (S-ACK) : modifié, enregistrement refusé, changé pendant l'envoi, puis enregistré
  at = await call('mark');
  const set1 = await engine('develop.set', { control: 'light.exposure', value: 1.25 });
  const d1 = await call('wait', at, 'evora:dirty', { docRef: docA, dirty: true }, 8000);
  if (!set1.ok || !d1) errors.push(`[ehp-dirty] une modification n'a pas donné evora:dirty {dirty: true, docRef} : ${show(set1)}`);
  const r1 = await call('req', 'evora:request-save', { reason: 'user', docRef: docA }, ['evora:save', 'evora:ack'], 15000);
  const s1 = r1.reply && r1.reply.type === 'evora:save' ? r1.reply : null;
  if (!s1) errors.push(`[ehp-sack] evora:request-save d'une photo modifiée sans evora:save : ${show(r1.reply)}`);
  else {
    if (s1.payload.docRef !== docA || s1.payload.name !== `${PHOTO}.revela.json`) errors.push(`[ehp-envelope-save] evora:save : docRef ou nom inattendus : ${show(s1.payload)}`);
    judgeEnvelope(s1.envelope, 1.25, version, errors, 'S1');
    await call('answer', 'evora:saved', s1.id, { ok: false, error: 'server' });
    await pause(900);
    const dS1 = await docOf(docA);
    if (dirtyMsgs(await call('since', d1 ? at : r1.at), docA, false).length || !dS1 || dS1.dirty !== true) {
      errors.push(`[ehp-sack] après evora:save puis evora:saved {ok: false}, la photo doit rester modifiée : ${show(dS1)}`);
    }
  }
  at = await call('mark');
  const r2 = await call('req', 'evora:request-save', { reason: 'autosave', docRef: docA }, ['evora:save', 'evora:ack'], 15000);
  const s2 = r2.reply && r2.reply.type === 'evora:save' ? r2.reply : null;
  if (!s2) errors.push(`[ehp-sack] après un enregistrement refusé, la photo doit rester à enregistrer : ${show(r2.reply)}`);
  await engine('develop.set', { control: 'light.exposure', value: 1.5 });
  if (s2) {
    await pause(500);
    await call('answer', 'evora:saved', s2.id, { ok: true, version: 2 });
    await pause(900);
    const dS2 = await docOf(docA);
    if (dirtyMsgs(await call('since', at), docA, false).length || !dS2 || dS2.dirty !== true) {
      errors.push(`[ehp-sack] modifiée après l'envoi de son evora:save, la photo doit rester modifiée malgré evora:saved {ok: true} : ${show(dS2)}`);
    }
  }
  at = await call('mark');
  const r3 = await call('req', 'evora:request-save', { reason: 'user', docRef: docA }, ['evora:save', 'evora:ack'], 15000);
  const s3 = r3.reply && r3.reply.type === 'evora:save' ? r3.reply : null;
  if (!s3) errors.push(`[ehp-sack] troisième evora:request-save sans evora:save : ${show(r3.reply)}`);
  else {
    judgeEnvelope(s3.envelope, 1.5, version, errors, 'S3');
    await call('answer', 'evora:saved', s3.id, { ok: true, version: 3 });
    const clean = await call('wait', at, 'evora:dirty', { docRef: docA, dirty: false }, 8000);
    const dS3 = await docOf(docA);
    if (!clean || !dS3 || dS3.dirty !== false) errors.push(`[ehp-sack] evora:saved {ok: true} d'une photo inchangée : evora:dirty {dirty: false} attendu : ${show(dS3)}`);
  }
  const r4 = await call('req', 'evora:request-save', { reason: 'close', docRef: docA }, ['evora:save', 'evora:ack'], 15000);
  if (!r4.reply || r4.reply.type !== 'evora:ack' || r4.reply.payload.ok !== true || r4.reply.payload.code !== 'clean') {
    errors.push(`[ehp-sack] evora:request-save d'une photo enregistrée : evora:ack {ok: true, code: "clean"} attendu : ${show(r4.reply)}`);
  }

  // 4. Deuxième photo : son propre docRef, réglages rendus par le sidecar XMP de l'enveloppe S3
  const openB = await call('open', PHOTO2, '#F9FAFB', '#0EA5E9');
  if (!openB.ack || openB.ack.ok !== true || !openB.transferred) errors.push(`[ehp-multi] deuxième photo non ouverte : ${show(openB)}`);
  const docB = openB.docRef;
  const activeB = await call('wait', openB.at, 'evora:active', { docRef: docB }, 8000);
  if (!activeB) errors.push('[ehp-multi] pas d\'evora:active pour la deuxième photo');
  const all1 = await docs();
  const dB = all1.find((d) => d.docRef === docB);
  if (all1.length !== 2 || !dB || dB.photo === photoA) errors.push(`[ehp-multi] deux photos, deux docRef et deux photos du moteur attendus : ${show(all1)}`);
  const xmp = s3 && s3.envelope ? s3.envelope.xmp : null;
  const applyX = await cmd('revela.apply', { docRef: docB, xmp: xmp || '' });
  note('applyXmp', applyX && applyX.payload);
  const getB = await cmd('develop.get', { docRef: docB });
  if (!applyX || applyX.payload.ok !== true || !getB || Math.abs((((getB.payload.result || {}).light || {}).exposure ?? NaN) - 1.5) > 1e-6) {
    errors.push(`[ehp-apply] revela.apply {xmp} : les réglages de l'enveloppe S3 (exposition 1.5) ne sont pas rendus : ${show({ apply: applyX && applyX.payload, get: getB && getB.payload }).slice(0, 300)}`);
  }
  const getA2 = await cmd('develop.get', { docRef: docA });
  if (!getA2 || Math.abs((((getA2.payload.result || {}).light || {}).exposure ?? NaN) - 1.5) > 1e-6) errors.push('[ehp-multi] la première photo a perdu ses réglages');

  // 5. Modifié par photo ; « tout enregistrer » (sans docRef) n'envoie que la photo modifiée
  at = await call('mark');
  await engine('develop.set', { control: 'light.exposure', value: -0.5 });
  const dBt = await call('wait', at, 'evora:dirty', { docRef: docB, dirty: true }, 8000);
  await pause(600);
  if (!dBt || dirtyMsgs(await call('since', at), docA).length) errors.push('[ehp-dirty] la modification de la deuxième photo doit être annoncée pour elle seule');
  const r5 = await call('req', 'evora:request-save', { reason: 'autosave' }, ['evora:save', 'evora:ack'], 15000);
  await pause(1500);
  const saves5 = (await call('since', r5.at)).filter((m) => m.type === 'evora:save');
  if (!r5.reply || r5.reply.type !== 'evora:save' || r5.reply.payload.docRef !== docB || saves5.length !== 1) {
    errors.push(`[ehp-multi] evora:request-save sans docRef : un seul evora:save attendu, celui de la photo modifiée (re posé) : ${show(saves5.map((m) => ({ docRef: m.payload.docRef, re: m.re })))}`);
  }
  if (r5.reply && r5.reply.type === 'evora:save') {
    judgeEnvelope(r5.reply.envelope, -0.5, version, errors, 'S5');
    await call('answer', 'evora:saved', r5.reply.id, { ok: true, version: 2 });
    if (!(await call('wait', r5.at, 'evora:dirty', { docRef: docB, dirty: false }, 8000))) errors.push('[ehp-sack] la deuxième photo enregistrée doit redevenir propre');
  }

  // 6. evora:activate : la photo vient devant ; inconnue : not_found
  const act = await call('req', 'evora:activate', { docRef: docA }, ['evora:ack'], 15000);
  const activeA = await call('wait', act.at, 'evora:active', { docRef: docA }, 8000);
  const sAct = await engineStats();
  if (!act.reply || act.reply.payload.ok !== true || !activeA || sAct.active !== PHOTO) {
    errors.push(`[ehp-multi] evora:activate : accusé, evora:active et photo devant attendus : ${show({ ack: act.reply && act.reply.payload, active: sAct.active })}`);
  }
  const ghost = await call('req', 'evora:activate', { docRef: await evalPage('window.__ehp.ulid()') }, ['evora:ack'], 15000);
  if (!ghost.reply || ghost.reply.payload.ok !== false || ghost.reply.payload.code !== 'not_found') errors.push(`[ehp-multi] evora:activate d'un docRef inconnu : not_found attendu : ${show(ghost.reply)}`);

  // 7. Liste blanche des commandes : refus à réception, paramètres jugés
  const photosBefore = (await engineStats()).photos;
  for (const [command, params] of [['library.import', { paths: ['/etc/passwd'] }], ['photo.delete', {}], ['web.purgeStorage', {}], ['file.backupLibrary', {}]]) {
    const r = await cmd(command, params);
    if (!r || r.payload.ok !== false || r.payload.code !== 'capability') errors.push(`[ehp-command] commande hors liste ${command} : evora:ack {ok: false, code: "capability"} attendu : ${show(r && r.payload)}`);
  }
  if ((await engineStats()).photos !== photosBefore) errors.push('[ehp-command] une commande hors liste a changé la photothèque');
  const both = await cmd('revela.apply', { docRef: docA, settings: {}, xmp: 'x' });
  if (!both || both.payload.ok !== false || both.payload.code !== 'invalid_content') errors.push(`[ehp-command] revela.apply avec settings ET xmp : invalid_content attendu : ${show(both && both.payload)}`);
  const lost = await cmd('develop.get', { docRef: await evalPage('window.__ehp.ulid()') });
  if (!lost || lost.payload.ok !== false || lost.payload.code !== 'not_found') errors.push(`[ehp-command] develop.get d'un docRef inconnu : not_found attendu : ${show(lost && lost.payload)}`);
  const controls = await cmd('develop.controls', { section: 'light' });
  if (!controls || controls.payload.ok !== true || !Array.isArray(controls.payload.result)) errors.push(`[ehp-command] develop.controls {section} : liste attendue : ${show(controls && controls.payload).slice(0, 200)}`);

  // 8. Export de deux photos : deux evora:export, chacun du docRef de sa photo ; aucun téléchargement
  at = await call('mark');
  const dl0 = await downloads();
  const ex = await engine('app.export', { ids: [photoA, dB ? dB.photo : null].filter((x) => x !== null), dir: 'evora' });
  const exports = [];
  for (let i = 0; i < 40 && exports.length < 2; i += 1) {
    await pause(500);
    exports.splice(0, exports.length, ...(await call('since', at)).filter((m) => m.type === 'evora:export'));
  }
  for (const m of exports) await call('answer', 'evora:ack', m.id, { ok: true });
  note('exports', exports.map((m) => ({ docRef: m.payload.docRef, name: m.payload.name, mime: m.payload.mime, magic: m.magic })));
  const want = { [docA]: 'evora-smoke', [docB]: 'seconde-photo' };
  const exportOk = exports.length === 2 && exports.every((m) => want[m.payload.docRef] && m.payload.name.toLowerCase().startsWith(want[m.payload.docRef]))
    && new Set(exports.map((m) => m.payload.docRef)).size === 2;
  if (!ex.ok || !exportOk) errors.push(`[ehp-export-docref] export de deux photos : un evora:export par photo, du docRef de sa photo : ${show({ export: ex, got: exports.map((m) => [m.payload.docRef, m.payload.name]) })}`);
  if (exports.some((m) => m.payload.mime !== 'image/jpeg' || m.magic !== 'ffd8ff')) errors.push(`[ehp-export-docref] fichier exporté inattendu (JPEG attendu) : ${show(exports.map((m) => [m.payload.mime, m.magic]))}`);
  const dl1 = await downloads();
  if (dl1.anchors.length !== dl0.anchors.length || dl1.events !== dl0.events) errors.push(`[ehp-download] l'export a lancé un téléchargement (jamais sous le pont) : ${show(dl1)}`);

  // 9. Sélecteur d'Evora : evora:pick {purpose: "open"}, la coquille répond par une photo neuve
  at = await call('mark');
  await engine('file.addPhotos', {});
  const pick = await call('wait', at, 'evora:pick', {}, 8000);
  const accept = pick && Array.isArray(pick.payload.accept) ? pick.payload.accept : [];
  if (!pick || pick.payload.purpose !== 'open' || pick.payload.multiple !== true || !accept.includes('.jpg') || !accept.includes('.dng') || accept.length > 32
    || accept.some((a) => !/^\.[a-z0-9]+$/.test(a)) || Object.keys(pick.payload).some((k) => !['purpose', 'accept', 'multiple'].includes(k))) {
    errors.push(`[ehp-pick] Fichier › Ajouter des photos : evora:pick {purpose: "open", accept, multiple: true} attendu : ${show(pick && pick.payload)}`);
  }
  let docC = null;
  if (pick) {
    const served = await call('servePick', pick.id, PHOTO3);
    docC = served.docRef;
    const cDoc = await docOf(docC);
    const sC = await engineStats();
    if (!served.ack || served.ack.ok !== true || !cDoc || sC.active !== PHOTO3) errors.push(`[ehp-pick] la photo choisie dans Evora n'est pas ouverte devant : ${show({ ack: served.ack, active: sC.active })}`);
  }

  // 10. Clavier : F6 rend la main à la coquille (evora:focus-out), Ctrl+S enregistre la photo devant
  at = await call('mark');
  const key = (init) => engineEval(`(() => { const c = document.getElementById('lightcraft_canvas') || document.body; const e = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(init)})); c.dispatchEvent(e); c.dispatchEvent(new KeyboardEvent('keyup', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(init)}))); return String(e.defaultPrevented); })()`, 20000);
  const f6 = await key({ key: 'F6', code: 'F6' });
  const out = await call('wait', at, 'evora:focus-out', {}, 5000);
  if (!out || f6 !== 'true') errors.push(`[ehp-focus-out] F6 dans le moteur : evora:focus-out attendu et la touche retenue (defaultPrevented ${f6})`);
  if (docC) {
    at = await call('mark');
    await engine('develop.set', { control: 'light.exposure', value: 0.3 });
    await call('wait', at, 'evora:dirty', { docRef: docC, dirty: true }, 8000);
    const ctrlS = await key({ key: 's', code: 'KeyS', ctrlKey: true });
    const keySave = await call('wait', at, 'evora:save', { docRef: docC }, 8000);
    if (!keySave || keySave.re !== null || ctrlS !== 'true') errors.push(`[ehp-save-key] Ctrl+S : evora:save (sans re) de la photo devant attendu : ${show(keySave && { re: keySave.re, payload: keySave.payload })}`);
    else {
      judgeEnvelope(keySave.envelope, 0.3, version, errors, 'Ctrl+S');
      await call('answer', 'evora:saved', keySave.id, { ok: true, version: 2 });
      await call('wait', at, 'evora:dirty', { docRef: docC, dirty: false }, 8000);
    }
  }
  const dl2 = await downloads();
  result.downloads = dl2;
  if (dl2.anchors.length || dl2.events) errors.push(`[ehp-download] téléchargement pendant la séance (jamais sous le pont) : ${show(dl2)}`);
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
