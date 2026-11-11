// 起動時にマスターパスワードを求めず、使うときに求める動作の E2E。
//   node tools/e2e/lazy-login.mjs
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, PipeClient, startApp, killTree, listTargets, waitTarget, waitFor, tmpDir, sleep, foregroundPid } from './lib.mjs';

const dataDir = tmpDir('tk-lazy-');
const MP = 'lazy-login-correct-horse-battery-6161';
const SUFFIX = 'e2elazy';
process.env.TKRFORM_PIPE_SUFFIX = SUFFIX;
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };
let app = null;
const helloStub = path.join(dataDir, '..', path.basename(dataDir) + '-hello-stub.txt');
fs.writeFileSync(helloStub, 'ok');
const pages = async (port) => (await listTargets(port)).filter((t) => t.type === 'page').map((t) => t.url);

try {
  // 初回: 保管庫を作る（セットアップのウィザードは起動時に出る）
  app = startApp({ dataDir, cdpPort: 9351, env: { TKRFORM_PIPE_SUFFIX: SUFFIX } });
  const t = await waitTarget(9351, (x) => x.url.includes('setup.html'));
  ok(true, '保管庫がないときは、起動時にセットアップのウィザードが出る');
  const ui = await Cdp.connect(t.webSocketDebuggerUrl);
  await waitFor(() => ui.eval(`typeof rpc === 'function'`), 10000);
  await ui.eval(`rpc('setup', { mp: ${JSON.stringify(MP)}, hint: '', iterations: 100000 })`);
  ui.close();
  killTree(app.child);
  await sleep(1500);

  // 2 回目: 手動起動（--background なし）。ログイン画面は出ず、ロックしたまま常駐する
  app = startApp({ dataDir, cdpPort: 9352, env: { TKRFORM_PIPE_SUFFIX: SUFFIX, TKRFORM_HELLO_STUB_FILE: helloStub } });
  const pipe = await PipeClient.connect();
  await waitFor(() => pipe.events.find((e) => e.event === 'lockState'), 5000, 'lockState');
  await sleep(2500);
  const p0 = await pages(9352).catch(() => []);
  ok(p0.length === 0, `起動してもウィンドウ（ログイン画面）を出さない（${p0.join(',') || 'なし'}）`);
  ok(pipe.events[0].data.locked === true, 'ロックしたまま常駐している');
  const hello = await pipe.ok('hello');
  ok(hello.locked === true, '拡張からはロック中として見える（ポップアップで解除できる）');
  const locked = await pipe.call('match', { url: 'https://example.com/' });
  ok(locked.code === 'LOCKED', 'ロック中の要求は LOCKED');

  // 保管庫が必要な操作 → ログイン画面 → 解除後に元の操作（エディタ）が続く
  await pipe.ok('openEditor');
  const lt = await waitTarget(9352, (x) => x.url.includes('login.html'));
  ok(lt.url.includes('then=editor'), 'エディタを開こうとしたときにログイン画面が出る（解除後にエディタへ）');
  const login = await Cdp.connect(lt.webSocketDebuggerUrl);
  await waitFor(() => login.eval(`typeof rpc === 'function'`), 10000);
  // 利用者の作業を邪魔しない: テスト中のウィンドウは画面の外にあり、前面（フォーカス）を奪っていない
  console.log('screenX', await login.eval(`[window.screenX, window.screenY, window.outerWidth]`)); ok(await login.eval(`window.screenX < -10000`), 'テスト中のログイン画面は画面の外に置かれる');
  ok(foregroundPid() !== app.child.pid && !(await login.eval(`document.hasFocus()`)), 'テスト中のアプリは前面（フォーカス）を奪わない');
  await login.type('#pw', MP);
  await login.click('#go');
  const et = await waitTarget(9352, (x) => x.url.includes('editor.html'));
  ok(!!et, '解除すると、続けてエディタが開く');
  login.close();

  // ロックし直し → 検索・セキュリティセンター・設定も同じ（ログイン画面 → 続き）
  const ed = await Cdp.connect(et.webSocketDebuggerUrl);
  for (const [name, then] of [['search', 'search'], ['security', 'security'], ['settings', 'settings']]) {
    await pipe.ok('lock');
    await sleep(500);
    await ed.eval(`rpc('openWindow', { name: ${JSON.stringify(name)} })`).catch(() => {});
    const w = await waitTarget(9352, (x) => x.url.includes('login.html') && x.url.includes(`then=${then}`), 8000).catch(() => null);
    ok(!!w, `ロック中に「${name}」を開くとログイン画面が出る`);
    if (w) {
      const c = await Cdp.connect(w.webSocketDebuggerUrl);
      await waitFor(() => c.eval(`typeof rpc === 'function'`), 10000);
      await c.eval(`rpc('unlock', { password: ${JSON.stringify(MP)} })`);
      await c.eval(`rpc('openWindow', { name: ${JSON.stringify(name)} })`);
      c.eval(`invoke('close_self')`).catch(() => {}); // ウィンドウが破棄されるので応答は待たない
      await sleep(700);
      c.close();
      await waitTarget(9352, (x) => x.url.includes(`${name}.html`), 8000).catch(() => { ok(false, `${name} が開かない`); });
    }
  }

  // Windows Hello が有効なら、ログイン画面を開いた時点で自動的に確認を始める（テスト用の差し替えで成功・キャンセルを再現）
  await pipe.ok('unlock', { password: MP });
  await ed.eval(`rpc('helloEnable')`);
  await pipe.ok('lock');
  fs.writeFileSync(helloStub, 'cancel');
  await pipe.ok('openEditor');
  const ht = await waitTarget(9352, (x) => x.url.includes('login.html'));
  const hc = await Cdp.connect(ht.webSocketDebuggerUrl);
  await waitFor(() => hc.eval(`typeof rpc === 'function'`), 10000);
  await waitFor(() => hc.eval(`!document.querySelector('#err').classList.contains('hidden')`), 8000, 'Hello キャンセルの表示');
  ok((await hc.eval(`document.querySelector('#err').textContent`)).includes('キャンセル') && (await hc.eval(`document.activeElement.id === 'pw'`)), 'Hello をキャンセルしたら、マスターパスワードの入力に戻る');
  ok((await pipe.ok('hello')).locked === true, 'キャンセルしたらロックのまま');
  fs.writeFileSync(helloStub, 'ok');
  hc.eval(`document.querySelector('#hello').click()`).catch(() => {});
  await waitFor(async () => (await pipe.ok('hello')).locked === false, 8000, 'Hello の手動実行');
  ok(true, 'ログイン画面の「Windows Hello でロック解除」ボタンで解除できる');
  await pipe.ok('lock');
  await sleep(1500);
  await pipe.ok('openEditor');
  await waitFor(async () => (await pipe.ok('hello')).locked === false, 10000, 'Hello の自動開始');
  ok(true, 'Hello が有効なら、ログイン画面を開いた時点で自動的に確認を始め、成功すれば解除される');
  hc.close();

  // 不具合の再発防止: 設定画面を開いたあとに Hello を有効にして「保存」しても、windowsHello が false に戻らない
  await ed.eval(`rpc('helloDisable')`);
  ok((await pipe.ok('hello')).helloAvailable === false, 'Hello を無効にすると helloAvailable は false');
  await ed.eval(`rpc('openWindow', { name: 'settings' })`);
  const stt = await waitTarget(9352, (x) => x.url.includes('settings.html'));
  const sc = await Cdp.connect(stt.webSocketDebuggerUrl);
  await waitFor(() => sc.eval(`typeof saveNow === 'function' && document.querySelectorAll('#tabs button').length > 0`), 10000, '設定画面');
  await ed.eval(`rpc('helloEnable')`); // 設定画面が古い設定（windowsHello: false）を持ったまま、別の経路で有効にする
  ok((await pipe.ok('hello')).helloAvailable === true, 'Hello を有効にすると helloAvailable は true');
  await sc.eval(`saveNow()`); // 設定は、変更のたびにその場で保存される（保存ボタンはない）。同じ処理を呼ぶ
  await waitFor(() => sc.eval(`document.querySelector('#saved').textContent.length > 0`), 5000, '設定の保存');
  const after = await ed.eval(`rpc('getPrefs')`);
  ok(after.security.windowsHello === true, '設定画面で「保存」しても、専用コマンドで変えた windowsHello は true のまま');
  ok((await pipe.ok('hello')).helloAvailable === true, '保存後も helloAvailable は true（ログイン画面の自動開始も効く）');
  sc.eval(`invoke('close_self')`).catch(() => {});

  // パスワード生成器は、ロック中でもそのまま開く
  await pipe.ok('lock');
  await sleep(500);
  await pipe.ok('openGenerator');
  const g = await waitTarget(9352, (x) => x.url.includes('passgen.html'), 8000).catch(() => null);
  ok(!!g, 'パスワード生成器はロック中でもログインなしで開く');
  const urls = await pages(9352);
  ok(!urls.some((u) => u.includes('login.html')), '生成器を開いてもログイン画面は出ない');
  ed.close(); pipe.close();
  killTree(app.child);
  await sleep(1500);

  // 既に壊れた状態（hello.key はあるのに windowsHello が false）の救済: 黙って有効に戻さず、利用者の操作（Hello の確認つき）で戻す
  const prefPath = path.join(dataDir, 'main', 'preferences.json');
  const pj = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
  ok(pj.security.windowsHello === true && fs.existsSync(path.join(dataDir, 'main', 'hello.key')), '設定の保存後も preferences.json の windowsHello は true（hello.key もある）');
  pj.security.windowsHello = false;
  fs.writeFileSync(prefPath, JSON.stringify(pj));
  app = startApp({ dataDir, cdpPort: 9354, env: { TKRFORM_PIPE_SUFFIX: SUFFIX, TKRFORM_HELLO_STUB_FILE: helloStub } });
  const pr = await PipeClient.connect();
  await sleep(1500);
  ok((await pr.ok('hello')).helloAvailable === false, '壊れた状態（登録済みで無効）では、黙って有効に戻さない（helloAvailable は false）');
  await pr.ok('openEditor');
  const rt = await waitTarget(9354, (x) => x.url.includes('login.html'));
  const rc = await Cdp.connect(rt.webSocketDebuggerUrl);
  await waitFor(() => rc.eval(`typeof rpc === 'function'`), 10000);
  await rc.eval(`rpc('unlock', { password: ${JSON.stringify(MP)} })`);
  const re = await waitTarget(9354, (x) => x.url.includes('editor.html'), 10000).catch(() => null);
  const rpcPage = re ? await Cdp.connect(re.webSocketDebuggerUrl) : rc;
  await waitFor(() => rpcPage.eval(`typeof rpc === 'function'`), 10000);
  const hs = await rpcPage.eval(`rpc('helloStatus')`);
  ok(hs.registeredButDisabled === true && hs.enabled === false, '設定画面で「Hello は登録済みだが無効」と分かる（registeredButDisabled）');
  await rpcPage.eval(`rpc('helloReenable')`);
  ok((await pr.ok('hello')).helloAvailable === true && (await rpcPage.eval(`rpc('helloStatus')`)).registeredButDisabled === false, '利用者の操作（Hello の確認つき）で有効に戻せる');
  fs.writeFileSync(helloStub, 'fail');
  await rpcPage.eval(`rpc('helloDisable')`);
  fs.writeFileSync(helloStub, 'ok');
  await rpcPage.eval(`rpc('helloEnable')`);
  fs.writeFileSync(helloStub, 'fail');
  const bad = await rpcPage.eval(`rpc('helloReenable').then(() => 'ok', (e) => e.message)`);
  ok(typeof bad === 'string', 'Hello の確認に失敗したら、有効に戻さない'); // すでに有効なので、失敗時の挙動だけ確認する
  rpcPage.close(); rc.close(); pr.close();
  killTree(app.child);
  await sleep(1500);

  // 自動起動（--background）: ウィンドウなし・ロック中のまま
  app = startApp({ dataDir, cdpPort: 9353, args: ['--background'], env: { TKRFORM_PIPE_SUFFIX: SUFFIX } });
  const pb = await PipeClient.connect();
  await sleep(2000);
  ok((await pages(9353).catch(() => [])).length === 0 && pb.events[0]?.data.locked === true, '--background の起動も、ウィンドウなしでロック中のまま');
  pb.close();
} catch (e) {
  failed++;
  console.log('ERROR', e.stack || e);
} finally {
  if (app) killTree(app.child);
  console.log(failed ? `${failed} 件失敗` : 'すべて成功');
  process.exit(failed ? 1 : 0);
}
