// 同期クライアント（§15）の E2E: 実際のアプリ 2 台 + server/sync.php（PHP の組み込みサーバ）。
//   node tools/e2e/sync-client.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, startApp, killTree, waitTarget, waitFor, tmpDir, sleep, ROOT } from './lib.mjs';

const WEB = 8791;
const URL_ = `http://127.0.0.1:${WEB}/sync.php`;
const docroot = tmpDir('tk-sync-php-');
fs.copyFileSync(path.join(ROOT, 'server', 'sync.php'), path.join(docroot, 'sync.php'));
const php = spawn('php', ['-S', `127.0.0.1:${WEB}`, '-t', docroot], { stdio: 'ignore' });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };
const MP = 'sync-test-correct-horse-battery-4242';
const EMAIL = 'sync@example.jp';
const apps = [];

async function launch(name, port) {
  const dataDir = tmpDir(`tk-sync-${name}-`);
  const app = startApp({ dataDir, cdpPort: port, env: { TKRFORM_PIPE_SUFFIX: `e2e-${name}` } });
  apps.push(app);
  const t = await waitTarget(port, (x) => x.url.includes('setup.html'));
  const ui = await Cdp.connect(t.webSocketDebuggerUrl);
  await waitFor(() => ui.eval(`typeof rpc === 'function'`), 10000);
  const rpc = (cmd, args = {}) => ui.eval(`rpc(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }))`);
  const must = async (cmd, args) => { const x = await rpc(cmd, args); if (!x.ok) throw new Error(`${name}.${cmd}: ${x.e.message}`); return x.r; };
  return { dataDir, ui, rpc, must };
}

try {
  await waitFor(async () => (await fetch(URL_, { method: 'POST', body: '{}' })).status > 0, 10000, 'PHP');
  const A = await launch('a', 9341);
  // A: 新しいアカウントを作る
  const s1 = await A.must('setup', { mp: MP, hint: '', iterations: 100000, sync: { mode: 'create', url: URL_, email: EMAIL } });
  ok(s1.ok && !s1.syncError, `A: 保管庫を作り、同期アカウントを登録した ${s1.syncError || ''}`);
  const st = await A.must('syncStatus');
  ok(st.enabled && st.loggedIn && st.email === EMAIL, 'A: 同期がオンでログイン済み');
  ok(fs.existsSync(path.join(A.dataDir, 'main', 'sync.token')) && !fs.readFileSync(path.join(A.dataDir, 'main', 'sync.token')).includes('Bearer'), 'A: トークンは sync.token（DPAPI で保護）に保存');
  ok(!fs.readFileSync(path.join(A.dataDir, 'main', 'sync.json'), 'utf8').includes(MP), 'A: sync.json に秘密は含まれない');

  const it = await A.must('saveItem', { mode: 'new', item: { type: 1, name: 'GitHub', folder: '/', url: 'https://github.com/login', fields: [{ name: 'u', value: 'octocat', kind: 'text', role: 'user' }, { name: 'p', value: 'pw-A1', kind: 'password', role: 'password' }] } });
  const r1 = await A.must('syncNow');
  ok(r1.pushed >= 1, `A: 手動同期で送信した（送信 ${r1.pushed} 件）`);

  // B: 誤った MP では参加できない
  const B = await launch('b', 9342);
  const bad = await B.rpc('setup', { mp: 'wrong-password-123456', hint: '', iterations: 100000, sync: { mode: 'join', url: URL_, email: EMAIL } });
  ok(!bad.ok, `B: 誤った MP では参加できない（${bad.e && bad.e.message}）`);
  ok(!fs.existsSync(path.join(B.dataDir, 'main', 'vault.hdr')), 'B: 失敗時に保管庫は作られない');
  const good = await B.rpc('setup', { mp: MP, hint: '', iterations: 100000, sync: { mode: 'join', url: URL_, email: EMAIL } });
  ok(good.ok, `B: MP だけで既存アカウントに参加できる ${good.e ? good.e.message : ''}`);
  await waitFor(async () => (await B.must('listEntries')).length === 1, 20000, 'B への反映');
  const bi = await B.must('getItem', { id: it.id });
  ok(bi.fields.find((f) => f.role === 'password').value === 'pw-A1', 'B: A のログインが同期された（VaultKey が共有されている）');

  // B で更新 → A
  bi.fields.find((f) => f.role === 'password').value = 'pw-B2';
  await B.must('saveItem', { mode: 'update', item: bi, replace: true });
  await B.must('syncNow');
  const r2 = await A.must('syncNow');
  ok(r2.pulled === 1 && (await A.must('getItem', { id: it.id })).fields.find((f) => f.role === 'password').value === 'pw-B2', 'A: B の更新を受け取った');

  // 自動同期（変更の 5 秒後）: A で保存すると、手動同期なしでサーバへ届く
  const it2 = await A.must('saveItem', { mode: 'new', item: { type: 7, name: '自動同期メモ', folder: '/', text: 'hello' } });
  await sleep(7500);
  await B.must('syncNow');
  ok((await B.must('listEntries')).some((e) => e.id === it2.id), 'A の変更が 5 秒の debounce で自動的にサーバへ送られた');

  // 競合: 両方が同じアイテムを変更 → 両方残す
  const ea = await A.must('getItem', { id: it.id });
  ea.fields.find((f) => f.role === 'password').value = 'from-A';
  await A.must('saveItem', { mode: 'update', item: ea, replace: true });
  const eb = await B.must('getItem', { id: it.id });
  eb.fields.find((f) => f.role === 'password').value = 'from-B';
  await B.must('saveItem', { mode: 'update', item: eb, replace: true });
  await A.must('syncNow');
  const rc = await B.must('syncNow');
  void rc;
  const entB = await B.must('listEntries');
  const copy = entB.find((e) => /^GitHub \(競合 \d{4}-\d\d-\d\d\)$/.test(e.name));
  ok(!!copy, 'B: 「名前 (競合 yyyy-MM-dd)」のアイテムが残る');
  ok((await B.must('getItem', { id: copy.id })).fields.find((f) => f.role === 'password').value === 'from-A', 'B: 競合コピーは A の版');
  await B.must('syncNow');
  await A.must('syncNow');
  ok((await A.must('listEntries')).filter((e) => e.name.startsWith('GitHub')).length === 2, 'A: 収束後、A にも競合コピーが届く');

  // 完全削除は墓石として同期される
  await A.must('purgeItem', { ids: [it2.id] });
  await A.must('syncNow');
  await B.must('syncNow');
  ok(!(await B.must('listEntries')).some((e) => e.id === it2.id), 'B: A の完全削除が反映される');

  // MP の変更が他の端末に伝わる
  const NEW = 'sync-test-NEW-staple-battery-7777';
  await A.must('changeMp', { old: MP, new: NEW });
  await B.must('lock');
  const oldLogin = await B.rpc('syncConnect', { mode: 'login', url: URL_, email: EMAIL, password: MP });
  ok(!oldLogin.ok, 'B: 変更前の MP ではサーバにログインできない');
  await B.must('unlock', { password: MP }); // B のローカルはまだ古い MP
  const nl = await B.rpc('syncConnect', { mode: 'login', url: URL_, email: EMAIL, password: NEW });
  ok(nl.ok, `B: 新しい MP でログインでき、ローカルのヘッダも合わせる ${nl.e ? nl.e.message : ''}`);
  await B.must('lock');
  const un = await B.rpc('unlock', { password: NEW });
  ok(un.ok, 'B: 新しい MP でロック解除できる');
  await B.must('syncNow');

  // 同期をやめる
  await B.must('syncDisconnect');
  const sb = await B.must('syncStatus');
  ok(!sb.enabled && !sb.loggedIn, 'B: 同期をやめるとトークンと状態が消える（保管庫は残る）');
  ok((await B.must('listEntries')).length >= 2, 'B: 保管庫のデータは残っている');
  A.ui.close(); B.ui.close();
} catch (e) {
  failed++;
  console.log('ERROR', e.stack || e);
} finally {
  for (const a of apps) killTree(a.child);
  php.kill();
  await sleep(200);
  console.log(failed ? `${failed} 件失敗` : 'すべて成功');
  process.exit(failed ? 1 : 0);
}
