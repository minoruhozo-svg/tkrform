// ウィンドウを開くまでの時間の計測（白い画面が出ている時間の内訳）。
//   node tools/e2e/perf-open.mjs
import { Cdp, startApp, killTree, waitTarget, waitFor, tmpDir, sleep } from './lib.mjs';

process.env.TKRFORM_PIPE_SUFFIX = 'e2eperfopen';
const PORT = 9364;
const dataDir = tmpDir('tk-perfopen-');
const app = startApp({ dataDir, cdpPort: PORT, env: { TKRFORM_PIPE_SUFFIX: 'e2eperfopen' } });
const MP = 'perf-open-correct-horse-battery-6262';
const log = (m) => console.log(m);
try {
  const t = await waitTarget(PORT, (x) => x.url.includes('setup.html'));
  const ui = await Cdp.connect(t.webSocketDebuggerUrl);
  await waitFor(() => ui.eval(`typeof rpc === 'function'`), 10000);
  await ui.eval(`rpc('setup', { mp: ${JSON.stringify(MP)}, hint: '', iterations: 100000 })`);
  const time = async (name, expr) => { const t0 = Date.now(); await ui.eval(expr); log(`${name}: ${Date.now() - t0} ms`); };
  for (const [name, cmd] of [['getPrefs', 'getPrefs'], ['listEntries', 'listEntries'], ['helloStatus', 'helloStatus'], ['backupStatus', 'backupStatus'], ['listBackups', 'listBackups'], ['syncStatus', 'syncStatus']]) {
    await time(`rpc ${name}`, `rpc('${cmd}')`);
  }
  await time('rpc helloStatus（2 回目）', `rpc('helloStatus')`);
  // すべてのウィンドウを閉じて WebView2 を止めてから開く（トレイ常駐で、ウィンドウがないときの状態。ここが「白い画面」の長さに近い）
  if (process.env.PERF_COLD === '1') {
    ui.eval(`invoke('close_self')`).catch(() => {}); // 最後のウィンドウ（セットアップ）を閉じる（応答は返らない）
    ui.close();
    await sleep(Number(process.env.PERF_COLD_WAIT_MS || 6000));
    const t0 = Date.now();
    const pipe = await (await import('./lib.mjs')).PipeClient.connect();
    await pipe.call('unlock', { password: MP });
    await pipe.call('openEditor');
    const tg = await waitTarget(PORT, (x) => x.url.includes('editor.html'), 60000);
    const c = await Cdp.connect(tg.webSocketDebuggerUrl);
    await waitFor(() => c.eval(`document.readyState === 'complete'`), 60000, 'editor', 50);
    log(`冷えた状態でエディタを開く: ${Date.now() - t0} ms`);
    killTree(app.child);
    process.exit(0);
  }
  for (const w of ['editor', 'settings']) {
    const t0 = Date.now();
    await ui.eval(`rpc('openWindow', { name: '${w}' })`);
    const tgt = await waitTarget(PORT, (x) => x.url.includes(w + '.html'), 60000);
    const t1 = Date.now();
    const c = await Cdp.connect(tgt.webSocketDebuggerUrl);
    await waitFor(() => c.eval(`document.readyState === 'complete'`), 60000, `${w} の読み込み`, 50);
    const t2 = Date.now();
    await waitFor(() => c.eval(`document.querySelectorAll('#list .rowitem, #tabs button, .pane').length > 0 || document.body.children.length > 3`), 60000, `${w} の描画`, 50);
    const t3 = Date.now();
    const nav = await c.eval(`JSON.stringify(performance.getEntriesByType('navigation')[0] || {})`);
    const n = JSON.parse(nav);
    log(`${w}: 開く→ターゲット出現 ${t1 - t0} ms / 読み込み完了まで +${t2 - t1} ms / 描画まで +${t3 - t2} ms（合計 ${t3 - t0} ms） domContentLoaded=${Math.round(n.domContentLoadedEventEnd || 0)} load=${Math.round(n.loadEventEnd || 0)}`);
    c.close();
  }
} catch (e) {
  console.log('ERROR', e.stack || e);
} finally {
  killTree(app.child);
  process.exit(0);
}
