// アプリと拡張で、UI 部品の決まり（CSS）と部品の JS が、同じ内容かを検査する（`node tools/check-uikit.mjs`）。
// 区間は、CSS が「/* ---- 部品の決まり」〜「部品の決まりここまで ---- */」、JS が「// ---- UI の部品」〜「// ---- UI の部品ここまで」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const cut = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b); if (i < 0 || j < 0) return null; return s.slice(i, j + b.length); };

let bad = 0;
const check = (label, a, b) => {
  if (a === null || b === null) { console.log(`NG  ${label}: 区間の印が見つかりません`); bad++; return; }
  if (a !== b) { console.log(`NG  ${label}: アプリと拡張で内容が違います`); bad++; } else console.log(`OK  ${label}（${a.split('\n').length} 行）`);
};
const css = (f) => cut(read(f), '/* ---- 部品の決まり（', '部品の決まりここまで ---- */');
const js = (f) => cut(read(f), '// ---- UI の部品:', '// ---- UI の部品ここまで');
check('CSS', css('crates/tkrform-app/ui/common.css'), css('extension/ext.css'));
check('JS', js('crates/tkrform-app/ui/common.js'), js('extension/ext.js'));
process.exit(bad ? 1 : 0);
