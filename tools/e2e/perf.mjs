// §19 の性能確認（アプリ全体）: 1 万件の保管庫で、ロック解除 1.5 秒以内（PBKDF2 込み）と match 応答 50ms 以内。
//   TKRFORM_EXE=target\release\TKRForm.exe node tools/e2e/perf.mjs
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, PipeClient, startApp, killTree, waitTarget, waitFor, tmpDir, sleep } from './lib.mjs';

const PORT = 9337;
const dataDir = tmpDir('tk-perf-');
const app = startApp({ dataDir, cdpPort: PORT });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };
const MP = 'perf-test-correct-horse-battery-5555';

try {
  const t = await waitTarget(PORT, (x) => x.url.includes('setup.html'));
  const ui = await Cdp.connect(t.webSocketDebuggerUrl);
  await waitFor(() => ui.eval(`typeof rpc === 'function'`), 10000);
  // 既定の反復回数（600,000）で作る
  await ui.eval(`rpc('setup', { mp: ${JSON.stringify(MP)}, hint: '', iterations: 600000 })`);

  // 1 万件のダミー CSV
  const rows = ['name,url,username,password,note'];
  for (let i = 0; i < 10000; i++) rows.push(`Site ${i},https://site${i}.example${i % 97}.com/login,user${i},pw-${i}-x,`);
  const csv = path.join(dataDir, '..', 'dummy10k.csv');
  fs.writeFileSync(csv, rows.join('\n'));
  const t0 = Date.now();
  const r = await ui.eval(`rpc('importRun', { path: ${JSON.stringify(csv)}, kind: 'csv', skipDuplicates: false })`);
  console.log(`取り込み ${r.added} 件: ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  ok(r.added === 10000, '1 万件を取り込めた');

  const p = await PipeClient.connect();
  await p.ok('lock');
  await sleep(300);
  const t1 = Date.now();
  await p.ok('unlock', { password: MP });
  const unlock = Date.now() - t1;
  ok(unlock < 1500, `ロック解除 1.5 秒以内（${unlock}ms、PBKDF2 600,000 回込み）`);

  const times = [];
  for (let i = 0; i < 20; i++) {
    const s = performance.now();
    await p.ok('match', { url: `https://site${1000 + i}.example${(1000 + i) % 97}.com/login` });
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  const median = times[10];
  ok(median < 50 && times[19] < 50, `match 応答 50ms 以内（中央値 ${median.toFixed(1)}ms / 最大 ${times[19].toFixed(1)}ms）`);
  const sr = performance.now();
  const found = await p.ok('search', { q: 'site 9999', types: [1], limit: 20 });
  console.log(`search: ${(performance.now() - sr).toFixed(1)}ms, ${found.length} 件`);
  // 検索語なしの一覧（ポップアップ・ホームの「よく使う」・保存ダイアログの既存名の取得）は、全件を並べ替えて返す
  const med = (xs) => xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  for (const limit of [50, 10000]) {
    const ts = [];
    for (let i = 0; i < 7; i++) {
      const t = performance.now();
      const got = await p.ok('search', { q: '', types: [1], limit });
      ts.push(performance.now() - t);
      if (i === 0) console.log(`search（検索語なし, limit ${limit}）: ${got.length} 件`);
    }
    console.log(`search（検索語なし, limit ${limit}）: 中央値 ${med(ts).toFixed(1)}ms / 最大 ${Math.max(...ts).toFixed(1)}ms`);
  }
  p.close(); ui.close();
} catch (e) {
  failed++;
  console.log('ERROR', e.stack || e);
} finally {
  killTree(app.child);
  console.log(failed ? `${failed} 件失敗` : 'すべて成功');
  process.exit(failed ? 1 : 0);
}
