// ブラウザ拡張を、ストア（Chrome ウェブストア / Microsoft Edge アドオン）に出す zip にする。
//   node tools/pack-extension.mjs [--keep-key] [--out <zip のパス>]
//
// - 中身は extension フォルダの、配布に要るものだけ（隠しファイル・*.md・*.map・テスト用のものは入れない）。
// - 既定では、manifest.json の "key" を外す。"key" は、開発中に拡張 ID を固定するためのもので、Chrome ウェブストアは、最初のアップロードでは
//   "key" の入った manifest を受け付けず（ストアが ID を割り当てる）、Edge アドオンも同様に、ID はストアが割り当てる。
//   --keep-key を付けると残す（ストアで割り当てられた公開鍵を、あとから入れる場合など）。
// - 出力は dist/tkrform-extension-<版>.zip（dist/ は .gitignore）。同じ入力から、毎回同じ zip ができる（日時を固定し、順序を決めている）。
// - 版（manifest.json の version）が Cargo.toml の版と違えば、止める。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'extension');
const args = process.argv.slice(2);
const keepKey = args.includes('--keep-key');
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const cargo = fs.readFileSync(path.join(ROOT, 'Cargo.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m);
if (!cargo || cargo[1] !== manifest.version) {
  console.error(`manifest.json の version（${manifest.version}）が、Cargo.toml の版（${cargo ? cargo[1] : '不明'}）と違います。`);
  process.exit(1);
}

// ---- 入れるファイルを集める
const SKIP = (name) => name.startsWith('.') || /\.(md|map|bak|orig|tmp)$/i.test(name) || name === 'Thumbs.db';
function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SKIP(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r));
    else out.push(r);
  }
  return out;
}
const files = walk(SRC);

// ---- manifest.json の整合（参照しているファイルがあること）
const refs = new Set();
for (const cs of manifest.content_scripts || []) for (const f of cs.js || []) refs.add(f);
if (manifest.background && manifest.background.service_worker) refs.add(manifest.background.service_worker);
if (manifest.action && manifest.action.default_popup) refs.add(manifest.action.default_popup);
if (manifest.options_page) refs.add(manifest.options_page);
for (const v of Object.values(manifest.icons || {})) refs.add(v);
for (const r of manifest.web_accessible_resources || []) for (const f of r.resources || []) refs.add(f);
const missing = [...refs].filter((f) => !files.includes(f));
if (missing.length) {
  console.error('manifest.json が参照しているファイルがありません: ' + missing.join(', '));
  process.exit(1);
}

// ---- zip（最小の書き出し。ファイル名は / 区切り、日時は固定）
const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01 00:00
const locals = [], centrals = [];
let offset = 0;
for (const rel of files) {
  let data = fs.readFileSync(path.join(SRC, rel));
  if (rel === 'manifest.json' && !keepKey) {
    const m = JSON.parse(data.toString('utf8'));
    delete m.key;
    data = Buffer.from(JSON.stringify(m, null, 2) + '\n', 'utf8');
  }
  const name = Buffer.from(rel, 'utf8');
  const crc = zlib.crc32(data) >>> 0;
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
  const local = Buffer.concat([lh, name, body]);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
  ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
  ch.writeUInt32LE(offset, 42);
  centrals.push(Buffer.concat([ch, name]));
  locals.push(local);
  offset += local.length;
}
const cd = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...locals, cd, end]);

const out = outArg ? path.resolve(outArg) : path.join(ROOT, 'dist', `tkrform-extension-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, zip);
console.log(`${out}`);
console.log(`ファイル ${files.length} 件、${(zip.length / 1024).toFixed(0)} KB、key: ${keepKey ? '残した' : '外した'}、version: ${manifest.version}`);
