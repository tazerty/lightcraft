#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Evora — patch E7 (neutralisations, D-16) : ce que le graphe RÉELLEMENT compilé pour l'artefact
// web ne doit jamais contenir. Lit la sortie de
//   cargo tree -p lightcraft-web --target wasm32-unknown-unknown -e normal,features --prefix none --locked
// (résolution des features du seul paquet web, comme le build) et refuse :
//   - les crates HEIC/HEVC (brevets), SAM 3 (poids sous licence non OSI) et de débruitage IA
//     (modèles tiers ; RawNIND sous GPL-3.0) ;
//   - les features qui les activeraient (heif, sam, denoise, rawnind-model).
// Témoin : le graphe doit contenir lightcraft-engine et lightcraft-denoise-core (sinon la sortie
// de cargo tree est vide ou a changé de forme, et la garde ne prouverait rien).
//
// Usage : node feature-guards.mjs <sortie-de-cargo-tree> | --selftest
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export const FORBIDDEN_CRATES = [
  ['lightcraft-heif', 'HEIC/HEVC (brevets, D-16)'],
  ['heic-rs', 'décodeur HEVC (brevets, D-16)'],
  ['lightcraft-segment', 'SAM 3 (poids sous licence non OSI), désactivé en V1'],
  ['candle-core', "moteur d'inférence de SAM 3, désactivé en V1"],
  ['lightcraft-denoise', 'débruitage IA (modèles tiers, RawNIND GPL-3.0), exclu en V1'],
];
export const FORBIDDEN_FEATURES = [
  ['lightcraft-engine', 'sam'], ['lightcraft-engine', 'denoise'], ['lightcraft-engine', 'rawnind-model'],
  ['lightcraft-denoise-core', 'rawnind-model'], ['lightcraft-codecs', 'heif'], ['lightcraft-web', 'heif'],
];
const WITNESSES = ['lightcraft-engine', 'lightcraft-denoise-core'];

export function guard(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const crates = new Set();
  const features = new Set();
  for (const l of lines) {
    let m = /^([A-Za-z0-9_-]+) v\d/.exec(l);
    if (m) crates.add(m[1]);
    m = /^([A-Za-z0-9_-]+) feature "([^"]+)"/.exec(l);
    if (m) features.add(`${m[1]}/${m[2]}`);
  }
  const problems = [];
  for (const [c, why] of FORBIDDEN_CRATES) if (crates.has(c)) problems.push(`crate ${c} dans le graphe web : ${why}`);
  for (const [c, f] of FORBIDDEN_FEATURES) if (features.has(`${c}/${f}`)) problems.push(`feature ${c}/${f} activée dans le graphe web`);
  for (const w of WITNESSES) if (!crates.has(w)) problems.push(`témoin absent : ${w} (sortie de cargo tree vide ou changée)`);
  return { crates: crates.size, features: features.size, problems, denoiseCore: [...features].filter((f) => f.startsWith('lightcraft-denoise-core/')) };
}

function selftest() {
  const clean = 'lightcraft-web v0.7.1 (/x)\nlightcraft-engine v0.7.1 (/x)\nlightcraft-engine feature "default"\nlightcraft-denoise-core v0.7.1 (/x)\nserde v1.0.0\n';
  const trap = clean + 'lightcraft-heif v0.7.1 (/x)\nlightcraft-engine feature "denoise"\nlightcraft-denoise-core feature "rawnind-model"\n';
  const empty = '';
  const checks = [
    ['témoin : graphe propre accepté', guard(clean).problems.length === 0],
    ['piège : crate HEIF, feature denoise et rawnind-model relevées', guard(trap).problems.length === 3],
    ['sortie vide : la garde rougit (témoins absents)', guard(empty).problems.length === 2],
  ];
  let ok = true;
  for (const [n, p] of checks) { console.log(`${p ? 'OK   ' : 'ÉCHEC'} ${n}`); ok &&= p; }
  console.log(ok ? 'Auto-test feature-guards : OK' : 'Auto-test feature-guards : ÉCHEC');
  return ok;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest() ? 0 : 1;
  if (!argv[0]) { console.error('usage : node feature-guards.mjs <sortie-de-cargo-tree> | --selftest'); return 2; }
  const g = guard(readFileSync(argv[0], 'utf8'));
  console.log(`Garde E7 (graphe web) : ${g.crates} crates, ${g.features} features activées ; features de lightcraft-denoise-core : ${g.denoiseCore.join(', ') || 'aucune'}.`);
  console.log(`Refusés : ${FORBIDDEN_CRATES.map(([c]) => c).join(', ')} ; features ${FORBIDDEN_FEATURES.map(([c, f]) => `${c}/${f}`).join(', ')}.`);
  for (const p of g.problems) console.log(`::error::${p}`);
  console.log(g.problems.length ? 'Résultat : ÉCHEC' : 'Résultat : OK');
  return g.problems.length ? 1 : 0;
}

if (process.argv[1] && basename(process.argv[1]) === 'feature-guards.mjs') process.exitCode = main(process.argv.slice(2));
