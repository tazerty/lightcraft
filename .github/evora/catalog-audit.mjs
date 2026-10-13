#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Evora — audit des catalogues affichés de l'interface (patch E10, puis E9).
//
// Lit les catalogues de messages (crates/ui-egui/locales/*.json : clés = texte source anglais,
// valeurs = traductions) et les chaînes littérales du code d'interface, et compte les émojis.
//
// Classement (directive « zéro émoji d'interface ») : est un émoji
//   - tout caractère de propriété Unicode Emoji_Presentation (affiché en émoji par défaut : ✅ ⭐ 😀) ;
//   - tout autre caractère de propriété Emoji, sauf le texte typographique : chiffres, #, *, © ® ™,
//     et les blocs Flèches (U+2190–21FF), Signes techniques (U+2300–23FF), Formes géométriques
//     (U+25A0–25FF), Flèches supplémentaires B (U+2900–297F), Symboles et flèches divers
//     (U+2B00–2BFF) — ⚠ ✔ ✖ ♥ ‼ ℹ sont donc des émojis, ↖ ▶ ⌨ ⬅ n'en sont pas ;
//   - les sélecteurs de présentation (U+FE0F), le ZWJ (U+200D) et le keycap (U+20E3).
// Les autres symboles (★ ✓ ✕ → ⌘ ⇧ ≤…) sont inventoriés sans être interdits : leur rendu par une
// police de texte est vérifié au rendu (test de fumée, commande web.renderAudit).
//
// Patch E9 (D-16) : les termes sensibles sont comptés dans les catalogues TELS QU'AFFICHÉS, c'est-à-dire
// après le catalogue de surcharge d'affichage crates/ui-egui/overrides/display-overrides.json
// (surcharges de message entier par source anglaise et par langue, puis remplacements), anglais compris.
//
// Usage :
//   node catalog-audit.mjs <racine-du-dépôt> [--rust-blocking] [--terms-blocking] [--summary FICHIER]
//   node catalog-audit.mjs --selftest
// Code de sortie 1 si un émoji est trouvé dans un catalogue (ou dans le code avec --rust-blocking), ou
// si un terme sensible reste affiché dans un catalogue (avec --terms-blocking).
// Aucune dépendance : modules intégrés de Node seulement.
import { readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { tmpdir } from 'node:os';

const LOCALES = 'crates/ui-egui/locales';
const OVERRIDES = 'crates/ui-egui/overrides/display-overrides.json';
// Termes sensibles (D-16, E9) : jamais affichés après surcharge ; et termes relevés pour information.
export const SENSITIVE_TERMS = ['Lumetri', 'Lightroom', 'Acrobat', 'Premiere', 'Adobe', 'Cycore'];
export const INFO_TERMS = ['Apple Photos'];
const RUST_DIRS = ['crates/ui-egui/src', 'apps/lightcraft-web/src'];
const TEXT_DEFAULT = new Set(['#', '*', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '\u00A9', '\u00AE', '\u2122']);
const PRESENTATION = new Set(['\uFE0F', '\u200D', '\u20E3']);
const EMOJI_RE = /\p{Emoji}/u;
const EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u;
const SYMBOL_RE = /\p{S}/u;
const TYPOGRAPHIC_BLOCKS = [[0x2190, 0x21ff], [0x2300, 0x23ff], [0x25a0, 0x25ff], [0x2900, 0x297f], [0x2b00, 0x2bff]];

export function isEmoji(ch) {
  if (PRESENTATION.has(ch)) return true;
  if (TEXT_DEFAULT.has(ch)) return false;
  if (EMOJI_PRESENTATION_RE.test(ch)) return true;
  if (!EMOJI_RE.test(ch)) return false;
  const c = ch.codePointAt(0);
  return !TYPOGRAPHIC_BLOCKS.some(([lo, hi]) => c >= lo && c <= hi);
}

export function isSymbol(ch) {
  return ch.codePointAt(0) >= 0x2000 && SYMBOL_RE.test(ch) && !isEmoji(ch);
}

const cp = (ch) => 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');

function scanText(text, onEmoji, onSymbol) {
  for (const ch of text) {
    if (isEmoji(ch)) onEmoji(ch);
    else if (isSymbol(ch)) onSymbol(ch);
  }
}

export function auditCatalogs(root) {
  const dir = join(root, LOCALES);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const emoji = [];
  const symbols = new Map();
  const seenKeys = new Set();
  let messages = 0;
  for (const f of files) {
    const catalog = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    for (const [key, value] of Object.entries(catalog)) {
      messages += 1;
      const where = (part) => `${f} ${part} ${JSON.stringify(key).slice(0, 80)}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        scanText(key, (ch) => emoji.push({ ch, where: where('(source anglaise)') }), (ch) => symbols.set(ch, (symbols.get(ch) || 0) + 1));
      }
      scanText(String(value), (ch) => emoji.push({ ch, where: where('(traduction)') }), (ch) => symbols.set(ch, (symbols.get(ch) || 0) + 1));
    }
  }
  return { files: files.length, messages, sourceMessages: seenKeys.size, emoji, symbols };
}

function walkRust(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name !== 'tests') walkRust(p, out);
    } else if (name.endsWith('.rs') && !name.startsWith('tests') && name !== 'headless.rs') {
      out.push(p);
    }
  }
  return out;
}

// Chaînes littérales du code de production (hors commentaires et hors modules #[cfg(test)]).
export function auditRust(root, dirs = RUST_DIRS) {
  const emoji = [];
  const symbols = new Map();
  let files = 0;
  for (const d of dirs) {
    let list = [];
    try { list = walkRust(join(root, d), []); } catch { continue; }
    for (const p of list) {
      files += 1;
      const lines = readFileSync(p, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.includes('#[cfg(test)]')) break;
        const code = line.trimStart();
        if (code.startsWith('//')) continue;
        for (const m of line.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)'/g)) {
          scanText(m[0], (ch) => emoji.push({ ch, where: `${relative(root, p)}:${i + 1} ${code.slice(0, 100)}` }),
            (ch) => symbols.set(ch, (symbols.get(ch) || 0) + 1));
        }
      }
    }
  }
  return { files, emoji, symbols };
}

// Le catalogue de surcharge d'affichage, tel que i18n.rs et build.rs l'appliquent.
export function loadOverrides(root) {
  let parsed = {};
  try { parsed = JSON.parse(readFileSync(join(root, OVERRIDES), 'utf8')); } catch { parsed = {}; }
  const replace = (parsed.replace || []).filter((r) => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'string');
  const messages = parsed.messages && typeof parsed.messages === 'object' ? parsed.messages : {};
  const shown = (source, code, text) => {
    const whole = messages[source]?.[code];
    if (typeof whole === 'string') return whole;
    return replace.reduce((t, [from, to]) => t.split(from).join(to), text);
  };
  return { replace, messages, shown, present: replace.length > 0 || Object.keys(messages).length > 0 };
}

const countTerms = (text, terms, into) => {
  for (const t of terms) {
    const n = text.split(t).length - 1;
    if (n) into[t] = (into[t] || 0) + n;
  }
};

// Termes sensibles dans les catalogues affichés (avant et après surcharge), et dans les littéraux du code.
export function auditTerms(root) {
  const ov = loadOverrides(root);
  const dir = join(root, LOCALES);
  const terms = [...SENSITIVE_TERMS, ...INFO_TERMS];
  const raw = {};
  const shown = {};
  const left = [];
  const seenKeys = new Set();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const code = f.replace(/-formats\.json$|\.json$/, '');
    const catalog = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    for (const [key, value] of Object.entries(catalog)) {
      const pairs = [[String(value), code]];
      if (!seenKeys.has(key)) { seenKeys.add(key); pairs.push([key, 'en']); }
      for (const [text, lang] of pairs) {
        countTerms(text, terms, raw);
        const display = ov.shown(key, lang, text);
        const before = { ...shown };
        countTerms(display, terms, shown);
        if (SENSITIVE_TERMS.some((t) => (shown[t] || 0) > (before[t] || 0)) && left.length < 40) left.push(`${f} [${lang}] ${display.slice(0, 110)}`);
      }
    }
  }
  const code = {};
  const codeShown = {};
  for (const d of RUST_DIRS) {
    let list = [];
    try { list = walkRust(join(root, d), []); } catch { continue; }
    for (const p of list) {
      const lines = readFileSync(p, 'utf8').split('\n');
      for (const line of lines) {
        if (line.includes('#[cfg(test)]')) break;
        if (line.trimStart().startsWith('//')) continue;
        for (const m of line.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
          countTerms(m[0], terms, code);
          countTerms(ov.replace.reduce((t, [from, to]) => t.split(from).join(to), m[0]), terms, codeShown);
        }
      }
    }
  }
  const blocking = SENSITIVE_TERMS.reduce((n, t) => n + (shown[t] || 0), 0);
  return { overrides: ov, raw, shown, left, code, codeShown, blocking };
}

function report(root, rustBlocking, termsBlocking = false) {
  const cat = auditCatalogs(root);
  const rs = auditRust(root);
  const lines = [];
  lines.push('### Porte E10 : émojis des catalogues affichés');
  lines.push('');
  lines.push(`Catalogues : ${cat.files} fichiers, ${cat.messages} messages (${cat.sourceMessages} textes source distincts).`);
  lines.push(`Code d'interface (${RUST_DIRS.join(', ')}) : ${rs.files} fichiers .rs de production.`);
  lines.push('');
  lines.push('| Portée | Émojis | Bloquant |');
  lines.push('|---|---|---|');
  lines.push(`| Catalogues (clés et traductions) | ${cat.emoji.length} | oui |`);
  lines.push(`| Littéraux du code d'interface | ${rs.emoji.length} | ${rustBlocking ? 'oui' : 'non (relevé)'} |`);
  lines.push('');
  for (const [title, list] of [['Catalogues', cat.emoji], ["Code d'interface", rs.emoji]]) {
    if (list.length === 0) continue;
    lines.push(`Émojis trouvés (${title}) :`);
    lines.push('');
    for (const e of list.slice(0, 60)) lines.push(`- ${cp(e.ch)} ${e.ch} — ${e.where.replaceAll('|', '\\|')}`);
    if (list.length > 60) lines.push(`- … ${list.length - 60} de plus`);
    lines.push('');
  }
  const inv = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([ch, n]) => `${ch} ${cp(ch)} ×${n}`).join(', ') || 'aucun';
  lines.push(`Symboles non émojis inventoriés (rendu vérifié à part) — catalogues : ${inv(cat.symbols)}.`);
  lines.push('');
  lines.push(`Symboles non émojis — code d'interface : ${inv(rs.symbols)}.`);
  lines.push('');
  const tm = auditTerms(root);
  lines.push('### Porte E9 : termes sensibles des catalogues affichés');
  lines.push('');
  lines.push(`Catalogue de surcharge : ${tm.overrides.present ? `${tm.overrides.replace.length} remplacement(s), ${Object.keys(tm.overrides.messages).length} message(s) entier(s)` : 'absent'} (${OVERRIDES}).`);
  lines.push('');
  lines.push('| Terme | Catalogues, texte d\'origine | Catalogues, texte affiché | Littéraux du code, origine → après remplacement |');
  lines.push('|---|---|---|---|');
  for (const t of [...SENSITIVE_TERMS, ...INFO_TERMS]) {
    lines.push(`| ${t}${INFO_TERMS.includes(t) ? ' (information)' : ''} | ${tm.raw[t] || 0} | ${tm.shown[t] || 0} | ${tm.code[t] || 0} → ${tm.codeShown[t] || 0} |`);
  }
  lines.push('');
  for (const l of tm.left) lines.push(`- reste affiché : ${l.replaceAll('|', '\\|')}`);
  if (tm.left.length) lines.push('');
  lines.push(`Les littéraux du code ne sont pas tous affichés (identifiants, tables) : relevé, non bloquant ; les messages qui passent par tr() sont mesurés dans le module en marche (web.renderAudit).`);
  lines.push('');
  const failed = cat.emoji.length > 0 || (rustBlocking && rs.emoji.length > 0) || (termsBlocking && tm.blocking > 0);
  lines.push(`Résultat : ${failed ? 'ÉCHEC' : 'OK'} (émojis : catalogues ${cat.emoji.length}, code ${rs.emoji.length} ; termes sensibles affichés : ${tm.blocking}${termsBlocking ? ', bloquant' : ', relevé'}).`);
  lines.push('');
  return { failed, text: lines.join('\n'), cat, rs, tm };
}

function selftest() {
  const base = mkdtempSync(join(tmpdir(), 'evora-catalog-selftest-'));
  const mk = (name, catalog, rust) => {
    const root = join(base, name);
    mkdirSync(join(root, LOCALES), { recursive: true });
    mkdirSync(join(root, 'crates/ui-egui/src'), { recursive: true });
    writeFileSync(join(root, LOCALES, 'xx.json'), JSON.stringify(catalog, null, 2));
    writeFileSync(join(root, 'crates/ui-egui/src/a.rs'), rust);
    return root;
  };
  const trapped = mk('piege', { 'Done ✅': 'Fait', 'Rate ★': 'Noter ★', 'Play': 'Lire ▶️' },
    'fn f() {\n  let a = "⚠ warn";\n  // "\u{1F600}" dans un commentaire\n}\n#[cfg(test)]\nmod tests { const X: &str = "✅"; }\n');
  const clean = mk('temoin', { 'Rate ★': 'Noter ★ → ⌘', 'Undo (⌘Z)': '⇧⌥ ≤ ≥ ✓ ✕' },
    'fn f() {\n  let a = "Edit ▸ Undo → © 2026 ↖ ▶ ⌨";\n}\n');
  const checks = [];
  // E9 : un catalogue avec deux termes, sans puis avec surcharge
  const terms = mk('termes', { 'Import Lightroom Catalog': 'Importer le catalogue Lightroom', 'Adobe RGB': 'Adobe RGB' }, 'fn f() {}\n');
  const tNo = report(terms, false, true);
  checks.push(['termes sans surcharge : 4 affichés, la porte rougit', tNo.tm.blocking === 4 && tNo.failed === true]);
  mkdirSync(join(terms, 'crates/ui-egui/overrides'), { recursive: true });
  writeFileSync(join(terms, OVERRIDES), JSON.stringify({ replace: [['Lightroom', 'LRCAT'], ['Adobe RGB', 'opRGB']], messages: { 'Adobe RGB': { fr: 'opRGB (fr)' } } }));
  const tYes = report(terms, false, true);
  checks.push(['termes avec surcharge : 0 affiché, la porte reste verte', tYes.tm.blocking === 0 && tYes.failed === false]);
  checks.push(['message entier surchargé par langue', loadOverrides(terms).shown('Adobe RGB', 'fr', 'Adobe RGB') === 'opRGB (fr)']);
  const t = report(trapped, true);
  checks.push(['catalogue piégé : 2 émojis (✅ et le sélecteur U+FE0F de ▶️ ; ▶ seul est typographique)', t.cat.emoji.length === 2]);
  checks.push(['catalogue piégé : ★ inventorié, non interdit', t.cat.symbols.has('★')]);
  checks.push(['code piégé : 1 émoji (⚠), commentaire et module de test ignorés', t.rs.emoji.length === 1]);
  checks.push(['dépôt piégé : la porte rougit', t.failed === true]);
  const c = report(clean, true);
  checks.push(['témoin : 0 émoji dans les catalogues', c.cat.emoji.length === 0]);
  checks.push(['témoin : 0 émoji dans le code', c.rs.emoji.length === 0]);
  checks.push(['témoin : la porte reste verte', c.failed === false]);
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'OK   ' : 'ÉCHEC'} ${name}`);
    ok &&= pass;
  }
  console.log(ok ? 'Auto-test catalog-audit : OK' : 'Auto-test catalog-audit : ÉCHEC');
  return ok;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest() ? 0 : 1;
  const root = argv.find((a) => !a.startsWith('--'));
  if (!root) {
    console.error('usage : node catalog-audit.mjs <racine> [--rust-blocking] [--summary FICHIER] | --selftest');
    return 2;
  }
  const i = argv.indexOf('--summary');
  const r = report(root, argv.includes('--rust-blocking'), argv.includes('--terms-blocking'));
  console.log(r.text);
  if (i >= 0 && argv[i + 1]) appendFileSync(argv[i + 1], r.text + '\n');
  return r.failed ? 1 : 0;
}

if (process.argv[1] && basename(process.argv[1]) === 'catalog-audit.mjs') process.exitCode = main(process.argv.slice(2));
