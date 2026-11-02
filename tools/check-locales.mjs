// locales/ja.json と en.json に、コードが参照するキーが揃っているか確認する。
//   node tools/check-locales.mjs          … 不足キーを表示（不足があれば終了コード 1）
//   node tools/check-locales.mjs --list   … 参照されているキーを一覧する
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (n) => JSON.parse(fs.readFileSync(path.join(root, 'locales', n), 'utf8'));
const ja = load('ja.json');
const en = load('en.json');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['target', 'node_modules', 'gen', '.git', '_locales', 'data'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html|rs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const prefixes = new Set([...Object.keys(ja).map((k) => k.split('_')[0]), 'Ext']);
const used = new Map();
const add = (k, f) => { if (k.endsWith('_')) return; if (!used.has(k)) used.set(k, new Set()); used.get(k).add(path.relative(root, f)); };
const KEY = '[A-Z][A-Za-z0-9]*_[A-Za-z0-9_]+';
for (const f of [...walk(path.join(root, 'crates')), ...walk(path.join(root, 'extension'))]) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(new RegExp(`\\bt\\(\\s*['"](${KEY})['"]`, 'g'))) add(m[1], f);
  for (const m of s.matchAll(new RegExp(`\\b(?:tf|l|t)\\(\\s*(?:&?lang,\\s*)?"(${KEY})"`, 'g'))) add(m[1], f);
  for (const m of s.matchAll(new RegExp(`data-i18n(?:-ph|-title|-aria)?="(${KEY})"`, 'g'))) add(m[1], f);
  for (const m of s.matchAll(new RegExp(`\\b(?:text|title|label|placeholder):\\s*t\\(\\s*['"](${KEY})['"]`, 'g'))) add(m[1], f);
  for (const m of s.matchAll(new RegExp(`\\[\\s*'[^']*',\\s*'(${KEY})'\\s*\\]`, 'g'))) add(m[1], f); // [value, 'Key'] 形式の表
  for (const m of s.matchAll(new RegExp(`'(Pref_opt_[A-Za-z0-9_]+|Match_[A-Za-z]+|Role_[A-Za-z]+|Export_[A-Za-z]+|Import_Col_[A-Za-z]+)'`, 'g'))) add(m[1], f);
  for (const m of s.matchAll(/['"`]([A-Z][A-Za-z0-9]*_[A-Za-z0-9_]+)['"`]/g)) { if (prefixes.has(m[1].split('_')[0]) && !/_$/.test(m[1])) add(m[1], f); }
}

if (process.argv.includes('--list')) {
  for (const k of [...used.keys()].sort()) console.log(k);
  process.exit(0);
}

let bad = 0;
for (const [name, table] of [['ja', ja], ['en', en]]) {
  const missing = [...used.keys()].filter((k) => !(k in table)).sort();
  if (missing.length) {
    bad += missing.length;
    console.log(`--- ${name}.json に不足 (${missing.length})`);
    for (const k of missing) console.log(`  ${k}   ← ${[...used.get(k)].join(', ')}`);
  }
}
const onlyJa = Object.keys(ja).filter((k) => !(k in en));
if (onlyJa.length) { console.log(`--- en.json にない ja のキー (${onlyJa.length}): ${onlyJa.slice(0, 20).join(', ')}`); bad += onlyJa.length; }
console.log(bad ? `不足あり` : `OK: ${used.size} 個のキーを確認（ja ${Object.keys(ja).length} / en ${Object.keys(en).length}）`);
process.exit(bad ? 1 : 0);
