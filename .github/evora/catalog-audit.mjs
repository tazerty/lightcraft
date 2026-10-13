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
// Usage :
//   node catalog-audit.mjs <racine-du-dépôt> [--rust-blocking] [--summary FICHIER]
//   node catalog-audit.mjs --selftest
// Code de sortie 1 si un émoji est trouvé dans un catalogue (ou dans le code avec --rust-blocking).
// Aucune dépendance : modules intégrés de Node seulement.
import { readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { tmpdir } from 'node:os';

const LOCALES = 'crates/ui-egui/locales';
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

function report(root, rustBlocking) {
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
  const failed = cat.emoji.length > 0 || (rustBlocking && rs.emoji.length > 0);
  lines.push(`Résultat : ${failed ? 'ÉCHEC' : 'OK'} (catalogues ${cat.emoji.length}, code ${rs.emoji.length}).`);
  lines.push('');
  return { failed, text: lines.join('\n'), cat, rs };
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
  const r = report(root, argv.includes('--rust-blocking'));
  console.log(r.text);
  if (i >= 0 && argv[i + 1]) appendFileSync(argv[i + 1], r.text + '\n');
  return r.failed ? 1 : 0;
}

if (process.argv[1] && basename(process.argv[1]) === 'catalog-audit.mjs') process.exitCode = main(process.argv.slice(2));
