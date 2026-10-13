#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Evora — gardes des avis de sécurité ignorés dans deny.toml : une exception n'est admise que si
// le chemin vulnérable est absent du code, et cette garde le revérifie à chaque exécution (si le
// code amont se met à l'emprunter, la porte cargo-deny rougit au lieu de rester verte par erreur).
//
// RUSTSEC-2026-0194 et RUSTSEC-2026-0195 (quick-xml 0.38.4) : seuls sont vulnérables
// `BytesStart::attributes()` avec le contrôle des doublons (le défaut), `try_get_attribute` et
// `NsReader`. Exigé : dans tout fichier Rust qui emploie quick_xml, chaque `.attributes()` est suivi
// de `.with_checks(false)`, et ni `NsReader`, ni `try_get_attribute`, ni `read_resolved_event`.
//
// Usage : node advisory-guards.mjs <racine-du-dépôt> | --selftest
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { tmpdir } from 'node:os';

const ROOTS = ['crates', 'apps', 'xtask'];
const FORBIDDEN = ['NsReader', 'try_get_attribute', 'read_resolved_event'];

function rustFiles(dir, out = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names.sort()) {
    if (name === 'target' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) rustFiles(p, out);
    else if (name.endsWith('.rs')) out.push(p);
  }
  return out;
}

export function guardQuickXml(root) {
  const problems = [];
  let files = 0;
  let calls = 0;
  for (const r of ROOTS) {
    for (const p of rustFiles(join(root, r))) {
      const text = readFileSync(p, 'utf8');
      if (!text.includes('quick_xml')) continue;
      files += 1;
      const rel = relative(root, p);
      for (const word of FORBIDDEN) if (text.includes(word)) problems.push(`${rel} : emploie ${word}`);
      for (const m of text.matchAll(/\.attributes\(\)/g)) {
        calls += 1;
        const after = text.slice(m.index + m[0].length).replace(/^\s+/, '');
        if (!after.startsWith('.with_checks(false)')) {
          const line = text.slice(0, m.index).split('\n').length;
          problems.push(`${rel}:${line} : .attributes() sans .with_checks(false)`);
        }
      }
    }
  }
  return { files, calls, problems };
}

function selftest() {
  const base = mkdtempSync(join(tmpdir(), 'evora-advisory-selftest-'));
  const mk = (name, code) => {
    const root = join(base, name);
    mkdirSync(join(root, 'crates/x/src'), { recursive: true });
    writeFileSync(join(root, 'crates/x/src/lib.rs'), code);
    return root;
  };
  const trap = guardQuickXml(mk('piege', 'use quick_xml::events::Event;\nfn f(e: &E) { for a in e.attributes().flatten() {} let r = quick_xml::NsReader::from_str(""); }\n'));
  const clean = guardQuickXml(mk('temoin', 'use quick_xml::events::Event;\nfn f(e: &E) { let a = e\n  .attributes()\n  .with_checks(false); }\n'));
  const checks = [
    ['piège : .attributes() sans with_checks(false) et NsReader relevés', trap.problems.length === 2],
    ['témoin : appel en plusieurs lignes accepté', clean.problems.length === 0 && clean.calls === 1],
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'OK   ' : 'ÉCHEC'} ${name}`); ok &&= pass; }
  console.log(ok ? 'Auto-test advisory-guards : OK' : 'Auto-test advisory-guards : ÉCHEC');
  return ok;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest() ? 0 : 1;
  const root = argv[0];
  if (!root) { console.error('usage : node advisory-guards.mjs <racine> | --selftest'); return 2; }
  const g = guardQuickXml(root);
  console.log(`Garde quick-xml (RUSTSEC-2026-0194/0195) : ${g.files} fichiers, ${g.calls} appels .attributes(), ${g.problems.length} problème(s).`);
  for (const p of g.problems) console.log(`::error::${p}`);
  return g.problems.length === 0 && g.files > 0 ? 0 : 1;
}

if (process.argv[1] && basename(process.argv[1]) === 'advisory-guards.mjs') process.exitCode = main(process.argv.slice(2));
