// Windows アプリへの記入（§10.4）の E2E: WinForms のログイン画面に UI Automation で取り込み・記入する。
//   node tools/e2e/winapp.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, startApp, killTree, waitTarget, waitFor, tmpDir, sleep, ROOT } from './lib.mjs';

if (process.env.TKRFORM_E2E_INTERACTIVE !== '1') {
  console.log('SKIP  winapp: 前面のウィンドウへ実際にキー入力を送るため、TKRFORM_E2E_INTERACTIVE=1 のときだけ実行します（作業中は実行しないでください）');
  process.exit(0);
}
const PORT = 9343;
const dataDir = tmpDir('tk-winapp-');
const out = path.join(dataDir, '..', 'winapp-result.txt');
const app = startApp({ dataDir, cdpPort: PORT, env: { TKRFORM_PIPE_SUFFIX: 'e2e-winapp' } });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };
const MP = 'winapp-test-correct-horse-battery-3131';
let form = null;
const startForm = (title) => spawn('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'e2e', 'winapp-form.ps1'), '-Title', title, '-Out', out], { stdio: 'ignore' });

try {
  const t = await waitTarget(PORT, (x) => x.url.includes('setup.html'));
  const ui = await Cdp.connect(t.webSocketDebuggerUrl);
  await waitFor(() => ui.eval(`typeof rpc === 'function'`), 10000);
  const rpc = (cmd, args = {}) => ui.eval(`rpc(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }))`);
  const must = async (cmd, args) => { const x = await rpc(cmd, args); if (!x.ok) throw new Error(`${cmd}: ${x.e.message}`); return x.r; };
  await must('setup', { mp: MP, hint: '', iterations: 100000 });

  form = startForm('TkrTest Login');
  await sleep(2500);

  // 既定では powershell.exe は「連結しないアプリ」: 取り込みも記入も拒否される
  const denied = await rpc('captureApp', { windowTitle: 'TkrTest Login' });
  ok(!denied.ok && denied.e.code === 'POLICY_DENIED', `既定の除外リスト（powershell.exe）のアプリは取り込めない（${denied.e && denied.e.message}）`);
  const prefs = await must('getPrefs');
  prefs.apps.ignoredApps = [];
  await must('setPrefs', { prefs });

  // 取り込み: AutomationId と値（パスワード欄は空）
  const cap0 = await rpc('captureApp', { windowTitle: 'TkrTest Login' });
  ok(cap0.ok, `前面ウィンドウ（のタイトル指定）を UI Automation で取り込める ${cap0.e ? cap0.e.message : ''}`);
  const cap = await must('appCaptureGet');
  ok(cap.exeName.toLowerCase() === 'powershell.exe' && cap.title === 'TkrTest Login', '取り込んだ exe 名とタイトル');
  const ids = cap.fields.map((f) => f.id).sort();
  ok(ids.includes('txtUser') && ids.includes('txtPw'), `Edit コントロールの AutomationId を取得（${ids.join(', ')}）`);
  ok(cap.fields.find((f) => f.id === 'txtPw').isPassword === true && cap.fields.find((f) => f.id === 'txtPw').value === '', 'パスワード欄は IsPassword で判別でき、値は空');

  // 保存ダイアログの代わりに saveItem（appsave.js と同じ形）
  const saved = await must('saveItem', { mode: 'new', item: { type: 4, name: 'TestApp', folder: '/', exePath: cap.exePath, windowTitle: 'TkrTest', submit: true,
    fields: [{ name: 'txtUser', id: 'txtUser', value: 'alice', kind: 'text', role: 'user' }, { name: 'txtPw', id: 'txtPw', value: 'S3cret-App-Pw', kind: 'password', role: 'password' }] } });

  // 記入（ValuePattern.SetValue）+ 既定のログインボタン
  const filled = await rpc('fillApp', { id: saved.id, windowTitle: 'TkrTest Login' });
  ok(filled.ok && filled.r.filled === 2, `2 つの欄に記入できる ${filled.e ? filled.e.message : ''}`);
  await waitFor(() => fs.existsSync(out), 8000, '記入後にログインボタンが押される');
  ok(fs.readFileSync(out, 'utf8') === 'alice|S3cret-App-Pw', '記入した値でログインボタンが押された（ID | パスワード）');

  // 照合: タイトルが違うウィンドウには記入しない
  const other = startForm('Another App Window');
  await sleep(2500);
  const bad = await rpc('fillApp', { id: saved.id, windowTitle: 'Another App Window' });
  ok(!bad.ok && bad.e.code === 'URL_MISMATCH', `タイトルが一致しないウィンドウには記入しない（${bad.e && bad.e.message}）`);
  killTree(other);

  // 連結オフ
  prefs.apps.linkApps = false;
  await must('setPrefs', { prefs });
  const off = await rpc('fillApp', { id: saved.id, windowTitle: 'TkrTest Login' });
  ok(!off.ok && off.e.code === 'POLICY_DENIED', '「Windows アプリと連結」をオフにすると記入しない');
  ui.close();
} catch (e) {
  failed++;
  console.log('ERROR', e.stack || e);
} finally {
  if (form) killTree(form);
  killTree(app.child);
  console.log(failed ? `${failed} 件失敗` : 'すべて成功');
  process.exit(failed ? 1 : 0);
}
