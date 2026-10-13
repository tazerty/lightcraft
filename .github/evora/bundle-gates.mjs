#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Evora — portes du bundle web (marques, fichiers d'hébergement, précompression, empreintes CSP,
// taille). Écrit par Evora ; aucune dépendance (modules intégrés de Node, plus les outils zip et
// unzip du système pour lire la liste de l'archive).
//
// Usage :
//   node bundle-gates.mjs csp <dossier>                 écrit <dossier>/csp-hashes.txt (avant l'archive)
//   node bundle-gates.mjs check <dossier> --zip <zip>   vérifie l'archive extraite dans <dossier>
//        [--summary FICHIER] [--json FICHIER]
//   node bundle-gates.mjs selftest                      prouve chaque porte rouge sur un paquet piégé
//                                                       et verte sur un témoin propre
import { readFileSync, readdirSync, lstatSync, writeFileSync, appendFileSync, mkdtempSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { join, relative, basename, extname, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, brotliDecompressSync, gzipSync, brotliCompressSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

// Termes de marque interdits hors de LICENSES/ (recherche insensible à la casse, binaires compris).
export const BRAND_TERMS = ['artcraft', 'getartcraft', 'discord.gg', 'discord.com', 'discordapp'];
// Fichiers qu'un hébergeur interpréterait : jamais dans l'artefact (le provisionnement d'Evora pose ses en-têtes).
const HOSTING_NAMES = new Set(['.htaccess', '.htpasswd', '_headers', '_redirects', 'web.config', '.user.ini', 'nginx.conf']);
const HOSTING_EXT = new Set(['.conf', '.php', '.phtml', '.phar', '.cgi', '.pl', '.py', '.sh', '.asp', '.aspx', '.jsp']);
// Fichiers servis qui doivent avoir leurs copies précompressées fidèles (.gz et .br).
const COMPRESSIBLE = new Set(['.html', '.js', '.wasm', '.otf']);
const LICENSES_DIR = 'LICENSES';
const CSP_FILE = 'csp-hashes.txt';

function walk(root) {
  const out = [];
  const rec = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      const rel = relative(root, abs);
      if (st.isSymbolicLink()) out.push({ rel, abs, kind: 'symlink' });
      else if (st.isDirectory()) { out.push({ rel, abs, kind: 'dir' }); rec(abs); }
      else if (st.isFile()) out.push({ rel, abs, kind: 'file', size: st.size });
      else out.push({ rel, abs, kind: 'other' });
    }
  };
  rec(root);
  return out;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const inLicenses = (rel) => rel === LICENSES_DIR || rel.startsWith(LICENSES_DIR + '/');
const isCompressedCopy = (rel) => rel.endsWith('.gz') || rel.endsWith('.br');

function countAll(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

// --- Marques -------------------------------------------------------------------------------
export function gateBrands(dir) {
  const files = walk(dir).filter((e) => e.kind === 'file');
  const perTerm = Object.fromEntries(BRAND_TERMS.map((t) => [t, 0]));
  const perFile = [];
  let licenses = 0;
  let lightcraft = 0;
  for (const f of files) {
    const text = readFileSync(f.abs).toString('latin1');
    const lower = text.toLowerCase();
    if (inLicenses(f.rel)) { licenses += countAll(lower, 'artcraft'); continue; }
    if (isCompressedCopy(f.rel)) continue; // fidélité prouvée par la porte de précompression
    lightcraft += countAll(text, 'LightCraft');
    let fileTotal = 0;
    for (const t of BRAND_TERMS) {
      // « getartcraft » contient « artcraft » : chaque terme est compté pour lui-même.
      const n = countAll(lower, t);
      perTerm[t] += n;
      fileTotal += n;
    }
    if (fileTotal > 0) perFile.push(`${f.rel} : ${fileTotal}`);
  }
  const total = perTerm.artcraft + perTerm['discord.gg'] + perTerm['discord.com'] + perTerm.discordapp;
  return {
    name: 'Marques (ArtCraft, getartcraft, Discord) hors LICENSES/',
    ok: total === 0,
    metrics: { ...perTerm, licensesArtcraft: licenses, lightcraftInfo: lightcraft },
    details: [
      `Occurrences (insensible à la casse) : ${BRAND_TERMS.map((t) => `${t} ${perTerm[t]}`).join(', ')}.`,
      `Pour information : « artcraft » dans LICENSES/ (mention permise) ${licenses} ; « LightCraft » dans le bundle ${lightcraft}.`,
      ...perFile.map((l) => `Fichier en défaut : ${l}`),
    ],
  };
}

// --- Fichiers d'hébergement et structure ----------------------------------------------------
function hostingProblem(rel, kind) {
  const name = basename(rel);
  if (kind === 'symlink') return 'lien symbolique';
  if (kind === 'other') return 'fichier spécial';
  if (rel.split('/').includes('..')) return 'chemin contenant ..';
  if (HOSTING_NAMES.has(name.toLowerCase())) return "fichier d'hébergement";
  if (HOSTING_EXT.has(extname(name).toLowerCase())) return 'extension interprétable par un serveur';
  if (name.startsWith('.')) return 'fichier caché';
  if (kind === 'dir' && rel !== LICENSES_DIR) return 'dossier inattendu (seul LICENSES/ est admis)';
  return null;
}

export function gateHosting(dir, zip) {
  const problems = [];
  for (const e of walk(dir)) {
    const p = hostingProblem(e.rel, e.kind);
    if (p) problems.push(`${e.rel} : ${p}`);
  }
  let zipEntries = 0;
  if (zip) {
    const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter(Boolean);
    zipEntries = names.length;
    const top = new Set(names.map((n) => n.split('/')[0]));
    if (top.size !== 1) problems.push(`archive : ${top.size} dossiers racine (${[...top].join(', ')})`);
    for (const n of names) {
      if (n.startsWith('/') || n.split('/').includes('..')) problems.push(`archive : chemin dangereux ${n}`);
      const rel = n.split('/').slice(1).join('/').replace(/\/$/, '');
      if (!rel) continue;
      const p = hostingProblem(rel, n.endsWith('/') ? 'dir' : 'file');
      if (p) problems.push(`archive : ${n} : ${p}`);
    }
  }
  return {
    name: "Fichiers d'hébergement (.htaccess, _headers, *.conf…), fichiers cachés, liens",
    ok: problems.length === 0,
    metrics: { problems: problems.length, zipEntries },
    details: problems.length ? problems : [`Aucun (dossier extrait et liste de l'archive, ${zipEntries} entrées).`],
  };
}

// --- Précompression ------------------------------------------------------------------------
export function gateCompression(dir) {
  const files = walk(dir).filter((e) => e.kind === 'file' && !inLicenses(e.rel));
  const names = new Set(files.map((f) => f.rel));
  const problems = [];
  const rows = [];
  for (const f of files) {
    if (isCompressedCopy(f.rel)) {
      const orig = f.rel.slice(0, -3);
      if (!names.has(orig)) problems.push(`${f.rel} : copie sans original`);
      continue;
    }
    if (!COMPRESSIBLE.has(extname(f.rel))) continue;
    const raw = readFileSync(f.abs);
    const row = { file: f.rel, raw: raw.length, gz: null, br: null };
    for (const [ext, inflate] of [['gz', gunzipSync], ['br', brotliDecompressSync]]) {
      const copy = `${f.rel}.${ext}`;
      if (!names.has(copy)) { problems.push(`${copy} absent`); continue; }
      const packed = readFileSync(join(dir, copy));
      row[ext] = packed.length;
      let out;
      try { out = inflate(packed); } catch (err) { problems.push(`${copy} illisible : ${err.message}`); continue; }
      if (sha256(out) !== sha256(raw)) problems.push(`${copy} ne redonne pas ${f.rel} à l'identique`);
    }
    rows.push(row);
  }
  return {
    name: 'Copies précompressées .gz et .br présentes et fidèles',
    ok: problems.length === 0 && rows.length > 0,
    metrics: { files: rows },
    details: [
      ...rows.map((r) => `${r.file} : ${r.raw} o ; gzip ${r.gz ?? 'absent'} ; brotli ${r.br ?? 'absent'}`),
      ...(rows.length === 0 ? ['aucun fichier à précompresser trouvé'] : []),
      ...problems,
    ],
  };
}

// --- Empreintes CSP ------------------------------------------------------------------------
export function cspHashes(dir) {
  const htmls = walk(dir).filter((e) => e.kind === 'file' && !inLicenses(e.rel) && e.rel.endsWith('.html'));
  const hashes = [];
  const problems = [];
  for (const h of htmls) {
    const html = readFileSync(h.abs, 'utf8');
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const attrs = m[1];
      const src = /\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
      if (src) {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src[1])) problems.push(`${h.rel} : script externe ${src[1]}`);
        continue;
      }
      hashes.push({ file: h.rel, hash: `'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'` });
    }
    for (const m of html.matchAll(/<[a-z][^>]*\s(on[a-z]+)\s*=/gi)) problems.push(`${h.rel} : gestionnaire inline ${m[1]} (exigerait 'unsafe-hashes')`);
    if (/(?:href|src|action)\s*=\s*["']?\s*javascript:/i.test(html)) problems.push(`${h.rel} : URL javascript:`);
  }
  return { hashes, problems, htmlFiles: htmls.length };
}

function cspFileText(hashes) {
  return [
    "# Empreintes CSP (script-src) des scripts inline du bundle, calculées par .github/evora/bundle-gates.mjs.",
    "# Directive à poser sur l'origine moteur : script-src 'self' 'wasm-unsafe-eval' <empreintes ci-dessous>",
    ...hashes.map((h) => `${h.file}\t${h.hash}`),
    '',
  ].join('\n');
}

export function writeCsp(dir) {
  const r = cspHashes(dir);
  writeFileSync(join(dir, CSP_FILE), cspFileText(r.hashes));
  return r;
}

export function gateCsp(dir) {
  const r = cspHashes(dir);
  const problems = [...r.problems];
  const path = join(dir, CSP_FILE);
  if (!existsSync(path)) problems.push(`${CSP_FILE} absent de l'archive`);
  else if (readFileSync(path, 'utf8') !== cspFileText(r.hashes)) problems.push(`${CSP_FILE} ne correspond pas aux scripts inline de l'archive`);
  if (r.hashes.length === 0) problems.push('aucun script inline trouvé (index.html attendu)');
  return {
    name: 'Empreintes sha256 des scripts inline (CSP)',
    ok: problems.length === 0,
    metrics: { hashes: r.hashes },
    details: [...r.hashes.map((h) => `${h.file} ${h.hash}`), ...problems],
  };
}

// --- Taille (mesure, sans budget : aucun plafond n'est arbitré) ------------------------------
export function measureSize(dir, zip) {
  const files = walk(dir).filter((e) => e.kind === 'file');
  const total = files.reduce((n, f) => n + f.size, 0);
  const pick = (rel) => files.find((f) => f.rel === rel)?.size ?? null;
  // le module principal : le plus gros .wasm hors LICENSES/ (lightcraft_web_bg.wasm dans le bundle réel)
  const main = files.filter((f) => f.rel.endsWith('.wasm') && !inLicenses(f.rel)).sort((a, b) => b.size - a.size)[0];
  const metrics = {
    wasmFile: main?.rel ?? null, wasm: main?.size ?? null,
    wasmGz: main ? pick(main.rel + '.gz') : null, wasmBr: main ? pick(main.rel + '.br') : null,
    js: pick('lightcraft_web.js'), font: pick('lightcraft_zh_hans.otf'), files: files.length, extracted: total,
    zip: zip ? lstatSync(zip).size : null,
  };
  return {
    name: 'Taille (mesure, aucun budget arbitré)',
    ok: metrics.wasm !== null,
    metrics,
    details: [
      `${metrics.wasmFile} brut ${metrics.wasm} o ; gzip ${metrics.wasmGz} o ; brotli ${metrics.wasmBr} o`,
      `glue JS ${metrics.js} o ; police chinoise ${metrics.font} o`,
      `${metrics.files} fichiers, ${total} o extraits ; archive ${metrics.zip} o`,
    ],
  };
}

// --- Hôtes externes cités par le bundle (E7, relevé : la CSP connect-src 'self' les bloque) ----
export function externalHosts(dir) {
  const files = walk(dir).filter((e) => e.kind === 'file' && !inLicenses(e.rel) && !isCompressedCopy(e.rel) && /\.(wasm|js|html)$/.test(e.rel));
  const hosts = new Map();
  for (const f of files) {
    const text = readFileSync(f.abs).toString('latin1');
    for (const m of text.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi)) {
      const h = m[1].toLowerCase();
      hosts.set(h, (hosts.get(h) || 0) + 1);
    }
  }
  const list = [...hosts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    name: 'Hôtes externes cités par le bundle (E7, relevé)',
    ok: true,
    metrics: { hosts: Object.fromEntries(list) },
    details: [list.length ? list.map(([h, n]) => `${h} ×${n}`).join(', ') : 'aucun'],
  };
}

export function checkAll(dir, zip) {
  return [gateBrands(dir), gateHosting(dir, zip), gateCompression(dir), gateCsp(dir), measureSize(dir, zip), externalHosts(dir)];
}

function render(results, title) {
  const lines = [`### ${title}`, '', '| Porte | Résultat |', '|---|---|'];
  for (const r of results) lines.push(`| ${r.name} | ${r.ok ? 'OK' : '**ÉCHEC**'} |`);
  lines.push('');
  for (const r of results) {
    lines.push(`**${r.name}** : ${r.ok ? 'OK' : 'ÉCHEC'}`);
    lines.push('');
    for (const d of r.details) lines.push(`- ${d}`);
    lines.push('');
  }
  return lines.join('\n');
}

// --- Auto-test : chaque porte rougit sur un paquet piégé, et le témoin reste vert -------------
function makePackage(base, name, { trapped }) {
  const top = join(base, name);
  const dir = join(top, 'pkg');
  mkdirSync(join(dir, LICENSES_DIR), { recursive: true });
  const index = '<!doctype html><title>x</title><script type="module">import("./app.js");</script>'
    + (trapped ? '<button onclick="go()">x</button>' : '') + '\n';
  const app = trapped ? 'console.log("Join the ArtCraft Discord https://discord.gg/x")\n' : 'console.log("ok")\n';
  const wasm = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  const files = { 'index.html': index, 'app.js': app, 'm.wasm': wasm };
  for (const [f, data] of Object.entries(files)) {
    writeFileSync(join(dir, f), data);
    writeFileSync(join(dir, f + '.gz'), gzipSync(Buffer.from(data)));
    if (!(trapped && f === 'm.wasm')) writeFileSync(join(dir, f + '.br'), brotliCompressSync(Buffer.from(data)));
  }
  writeFileSync(join(dir, LICENSES_DIR, 'NOTICE-EVORA.txt'), 'based on LightCraft by the ArtCraft team\n');
  if (trapped) {
    writeFileSync(join(dir, 'app.js.gz'), gzipSync(Buffer.from('console.log("autre")\n')));
    for (const f of ['.htaccess', '_headers', 'site.conf']) writeFileSync(join(dir, f), 'x\n');
    symlinkSync('index.html', join(dir, 'lien.html'));
  }
  writeCsp(dir);
  if (trapped) writeFileSync(join(dir, CSP_FILE), cspFileText([{ file: 'index.html', hash: "'sha256-AAAA'" }]));
  const zip = join(top, 'pkg.zip');
  execFileSync('zip', ['-qr', '-y', zip, 'pkg'], { cwd: top });
  return { dir, zip };
}

function selftest() {
  const base = mkdtempSync(join(tmpdir(), 'evora-bundle-selftest-'));
  const trap = makePackage(base, 'piege', { trapped: true });
  const clean = makePackage(base, 'temoin', { trapped: false });
  const t = Object.fromEntries(checkAll(trap.dir, trap.zip).map((r, i) => [i, r]));
  const c = checkAll(clean.dir, clean.zip);
  const checks = [
    ['marques : rouge sur ArtCraft et discord.gg', !t[0].ok && t[0].metrics.artcraft === 1 && t[0].metrics['discord.gg'] === 1],
    ['marques : la mention de LICENSES/ ne compte pas', t[0].metrics.licensesArtcraft === 1],
    ["hébergement : rouge sur .htaccess, _headers, *.conf et le lien symbolique", !t[1].ok && t[1].details.filter((d) => !d.startsWith('archive')).length === 4],
    ["hébergement : rouge aussi d'après la liste de l'archive", t[1].details.some((d) => d.startsWith('archive') && d.includes('.htaccess'))],
    ['précompression : rouge sur un .gz infidèle et un .br absent', !t[2].ok && t[2].details.some((d) => d.includes('app.js.gz ne redonne')) && t[2].details.some((d) => d.includes('m.wasm.br absent'))],
    ['CSP : rouge sur un gestionnaire inline et un fichier d\'empreintes faux', !t[3].ok && t[3].details.some((d) => d.includes('onclick')) && t[3].details.some((d) => d.includes('ne correspond pas'))],
    ['témoin : toutes les portes vertes', c.every((r) => r.ok)],
    ['témoin : une empreinte CSP calculée', c[3].metrics.hashes.length === 1],
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'OK   ' : 'ÉCHEC'} ${name}`);
    ok &&= pass;
  }
  if (!ok) console.log(render([...Object.values(t), ...c], 'Détail de l\'auto-test'));
  console.log(ok ? 'Auto-test bundle-gates : OK' : 'Auto-test bundle-gates : ÉCHEC');
  return ok;
}

function main(argv) {
  const [cmd, dir] = argv;
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (cmd === 'selftest') return selftest() ? 0 : 1;
  if (cmd === 'csp' && dir) {
    const r = writeCsp(dir);
    console.log(readFileSync(join(dir, CSP_FILE), 'utf8'));
    for (const p of r.problems) console.log(`::error::${p}`);
    return r.problems.length || r.hashes.length === 0 ? 1 : 0;
  }
  if (cmd === 'check' && dir) {
    const results = checkAll(dir, opt('--zip'));
    const text = render(results, `Portes du bundle ${basename(dir)}`);
    console.log(text);
    if (opt('--summary')) appendFileSync(opt('--summary'), text + '\n');
    if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify(results, null, 2));
    for (const r of results) if (!r.ok) console.log(`::error::porte en échec : ${r.name}`);
    return results.every((r) => r.ok) ? 0 : 1;
  }
  console.error('usage : node bundle-gates.mjs csp <dossier> | check <dossier> --zip <zip> [--summary F] [--json F] | selftest');
  return 2;
}

if (process.argv[1] && basename(process.argv[1]) === 'bundle-gates.mjs') process.exitCode = main(process.argv.slice(2));
