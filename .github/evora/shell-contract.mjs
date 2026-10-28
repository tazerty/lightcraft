// SPDX-License-Identifier: MIT
// Evora — contrat de la coquille d'Evora pour le catalogue des commandes (EVORA-REV-38, correction 1
// du lot REV-FK-B2), utilisé par ehp-bench.mjs.
//
// Le catalogue que le moteur émet (evora:commands) est relu par la coquille d'Evora contre un schéma
// FERMÉ (HOST-PROTOCOL §9.1 : {lang, count, hash, params?, commands: [{id, label, path?, enabled,
// destructive}]}, additionalProperties: false partout) ; un message refusé y est compté comme invalide,
// et la coquille coupe la séance au-delà de son plafond. Les schémas des paramètres déclarés ne
// voyagent PAS dans le catalogue : la coquille les lit dans engines.json d'Evora (commands:
// {id: {params}}), dans un sous-ensemble connu de JSON Schema, et contrôle les paramètres d'une
// commande AVANT de l'envoyer. Ce module réécrit ces règles telles que le protocole les énonce, pour
// que le banc rougisse sur tout ce que la coquille refuserait :
// - shellCatalogProblems : le schéma fermé d'evora:commands ;
// - catalogHash : l'empreinte du protocole, FNV-1a 64 bits des identifiants et de leur drapeau
//   (chaque identifiant, l'octet 0, « 1 » ou « 0 », un saut de ligne, dans l'ordre du catalogue) ;
// - shellSchemaShapeOk : la forme admise d'un schéma de paramètres d'engines.json ;
// - shellAdmits : ce que la coquille enverrait d'evora:command (params vide, ou conforme au schéma
//   déclaré) ;
// - removalMarked : une commande dont l'identifiant ou le libellé dit qu'elle retire quelque chose
//   (règle d'Evora du 2026-10-27 : une telle commande est destructive, sauf exception justifiée).

const LANG_RE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/;
const COMMAND_RE = /^[a-z][A-Za-z0-9_.-]*$/;
const HASH_RE = /^[0-9a-f]{16}$/;
// Défaut de la coquille (réglage creative_ehp_max_catalog_commands) : au plus tant de commandes.
export const SHELL_MAX_COMMANDS = 2000;
const CATALOG_KEYS = ['lang', 'count', 'hash', 'params', 'commands'];
const CATALOG_REQUIRED = ['lang', 'count', 'hash', 'commands'];
const ENTRY_KEYS = ['id', 'label', 'enabled', 'destructive', 'path'];
const ENTRY_REQUIRED = ['id', 'label', 'enabled', 'destructive'];
// Mots-clés de JSON Schema que la coquille sait lire dans un schéma de paramètres d'engines.json.
const SHELL_KEYWORDS = ['type', 'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'properties', 'required',
  'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', '$comment'];

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const plain = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const points = (s) => Array.from(s).length;
const label = (x) => typeof x === 'string' && points(x) >= 1 && points(x) <= 200;
const show = (o) => JSON.stringify(o);

function entryProblem(c) {
  if (!plain(c)) return 'entrée qui n\'est pas un objet';
  const extra = Object.keys(c).filter((k) => !ENTRY_KEYS.includes(k));
  if (extra.length) return `entrée aux champs refusés par la coquille ${show(extra)}`;
  const missing = ENTRY_REQUIRED.filter((k) => !hasOwn(c, k));
  if (missing.length) return `entrée sans ${missing.join(', ')}`;
  if (typeof c.id !== 'string' || points(c.id) > 100 || !COMMAND_RE.test(c.id)) return 'identifiant hors motif';
  if (!label(c.label)) return 'libellé vide ou trop long';
  if (typeof c.enabled !== 'boolean' || typeof c.destructive !== 'boolean') return 'drapeau non booléen';
  if (hasOwn(c, 'path') && !(Array.isArray(c.path) && c.path.length <= 8 && c.path.every(label))) return 'chemin de menus hors schéma';
  return null;
}

// Ce que la coquille reprocherait à un evora:commands (vide : elle l'accepte).
export function shellCatalogProblems(p) {
  if (!plain(p)) return ['charge qui n\'est pas un objet'];
  const out = [];
  const extra = Object.keys(p).filter((k) => !CATALOG_KEYS.includes(k));
  if (extra.length) out.push(`champs refusés par la coquille ${show(extra)}`);
  const missing = CATALOG_REQUIRED.filter((k) => !hasOwn(p, k));
  if (missing.length) out.push(`champs requis absents ${show(missing)}`);
  if (hasOwn(p, 'lang') && !(typeof p.lang === 'string' && points(p.lang) <= 16 && LANG_RE.test(p.lang))) out.push(`lang ${show(p.lang)}`);
  if (hasOwn(p, 'count') && !(Number.isSafeInteger(p.count) && p.count >= 0)) out.push(`count ${show(p.count)}`);
  if (hasOwn(p, 'hash') && !(typeof p.hash === 'string' && HASH_RE.test(p.hash))) out.push(`hash ${show(p.hash)}`);
  if (hasOwn(p, 'params') && !plain(p.params)) out.push(`params ${show(p.params)}`);
  if (hasOwn(p, 'commands')) {
    if (!Array.isArray(p.commands)) out.push('commands n\'est pas une liste');
    else if (p.commands.length > SHELL_MAX_COMMANDS) out.push(`${p.commands.length} commandes, plus que les ${SHELL_MAX_COMMANDS} de la coquille`);
    else {
      const bad = [];
      for (const c of p.commands) {
        const why = entryProblem(c);
        if (why) bad.push(`${why} : ${show(c).slice(0, 160)}`);
      }
      if (bad.length) out.push(`${bad.length} entrée(s) refusée(s), dont ${bad.slice(0, 3).join(' ; ')}`);
    }
  }
  return out;
}

// L'empreinte du protocole (16 chiffres hexadécimaux minuscules).
export function catalogHash(commands) {
  const enc = new TextEncoder();
  const mask = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  const eat = (bytes) => {
    for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & mask;
  };
  for (const c of commands) {
    eat(enc.encode(String(c.id)));
    eat([0, c.destructive === true ? 0x31 : 0x30]);
    eat([0x0a]);
  }
  return h.toString(16).padStart(16, '0');
}

// Un schéma de paramètres qu'engines.json peut porter (sinon la coquille refuse toute la configuration).
export function shellSchemaShapeOk(s) {
  if (!plain(s) || Object.keys(s).some((k) => !SHELL_KEYWORDS.includes(k))) return false;
  if (s.pattern !== undefined) {
    try { new RegExp(String(s.pattern), 'u'); } catch { return false; }
  }
  if (s.enum !== undefined && !Array.isArray(s.enum)) return false;
  if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every((k) => typeof k === 'string'))) return false;
  if (s.properties !== undefined && !(plain(s.properties) && Object.values(s.properties).every(shellSchemaShapeOk))) return false;
  if (s.items !== undefined && !shellSchemaShapeOk(s.items)) return false;
  return s.additionalProperties === undefined || typeof s.additionalProperties === 'boolean' || shellSchemaShapeOk(s.additionalProperties);
}

const typed = (v, t) => [].concat(t).some((x) => (x === 'object' ? plain(v)
  : x === 'array' ? Array.isArray(v)
    : x === 'integer' ? Number.isSafeInteger(v)
      : x === 'number' ? typeof v === 'number' && Number.isFinite(v)
        : x === 'null' ? v === null : typeof v === x));

function conforms(v, s) {
  if (hasOwn(s, 'const') && v !== s.const) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (s.type && !typed(v, s.type)) return false;
  if (typeof v === 'string') {
    const n = points(v);
    if ((s.minLength !== undefined && n < s.minLength) || (s.maxLength !== undefined && n > s.maxLength)) return false;
    if (s.pattern && !new RegExp(String(s.pattern), 'u').test(v)) return false;
  }
  if (typeof v === 'number' && ((s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum))) return false;
  if (Array.isArray(v)) {
    if ((s.minItems !== undefined && v.length < s.minItems) || (s.maxItems !== undefined && v.length > s.maxItems)) return false;
    if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) return false;
  }
  if (plain(v)) {
    if ((s.required || []).some((k) => !hasOwn(v, k))) return false;
    if (s.additionalProperties === false && Object.keys(v).some((k) => !s.properties || !hasOwn(s.properties, k))) return false;
  }
  return true;
}

// v respecte-t-il le schéma s, comme la coquille le juge ?
export function shellFits(v, s) {
  if (!conforms(v, s)) return false;
  if (Array.isArray(v) && s.items && !v.every((x) => shellFits(x, s.items))) return false;
  if (plain(v)) {
    for (const k of Object.keys(v)) {
      const sub = s.properties && hasOwn(s.properties, k) ? s.properties[k] : (plain(s.additionalProperties) ? s.additionalProperties : null);
      if (sub && !shellFits(v[k], sub)) return false;
    }
  }
  return true;
}

// La coquille enverrait-elle evora:command {command, params} ? params vide, ou conforme au schéma déclaré
// de la commande dans engines.json (declared : {id: {params}}) ; sans schéma déclaré, tout paramètre est refusé.
export function shellAdmits(declared, command, params) {
  if (!plain(params)) return false;
  if (Object.keys(params).length === 0) return true;
  const spec = plain(declared) && hasOwn(declared, command) ? declared[command] : null;
  return !!(spec && plain(spec.params) && shellFits(params, spec.params));
}

// Forme canonique (clés triées) : deux schémas égaux quel que soit l'ordre de leurs clés.
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (plain(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// Marqueurs de retrait (règle d'Evora du 2026-10-27, AVENANT §5), anglais et français : un mot de
// l'identifiant (découpé aux points et aux majuscules) ou du libellé qui commence par l'un d'eux.
export const REMOVAL_MARKERS = ['delete', 'remove', 'cut', 'clear', 'flatten', 'reset', 'discard', 'erase', 'purge', 'wipe', 'trash', 'strip',
  'unflag', 'supprim', 'retir', 'effac', 'réinitialis', 'reinitialis', 'coup', 'aplat', 'vider', 'jeter', 'écras', 'ecras', 'enlev', 'ôter', 'oter'];
const idWords = (id) => String(id).split('.').flatMap((part) => part.split(/(?=[A-Z])/)).map((w) => w.toLowerCase()).filter(Boolean);
const labelWords = (text) => String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
export const removalMarked = (c) => [...idWords(c.id), ...labelWords(c.label)].some((w) => REMOVAL_MARKERS.some((m) => w.startsWith(m)));
