// ブラウザ拡張の E2E: 本物の Chrome に拡張を読み込み、tkrform アプリと NM ホスト経由で連携させる。
//   node tools/e2e/ext.mjs [--headful]
// 受け入れ基準（§20）のうち、拡張まわり（自動保存 → ロック → 解除 → 自動記入、パスワード変更の「更新」提案、
// プロフィールの記入、ロックの伝播、ベーシック認証、TOTP）を確認する。
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { nmRegistrySave, nmRegistryRestore, Cdp, PipeClient, startApp, killTree, waitTarget, waitFor, tmpDir, sleep, ROOT, listTargets, watchWindows } from './lib.mjs';

const APP_PORT = 9336;
const CHROME_PORT = 9677;
const WEB_PORT = 8765;
const EXT_ID = fs.readFileSync(path.join(ROOT, 'tools', 'ext-id.txt'), 'utf8').trim();
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MP = 'ext-test-correct-horse-battery-9876';
const headful = process.argv.includes('--headful');

const dataDir = tmpDir('tk-ext-');
const profile = tmpDir('tk-chrome-');
const shots = path.join(dataDir, '..', 'shots-ext');
fs.mkdirSync(shots, { recursive: true });
let failed = 0;
// 出力は同期で書く（timeout で強制終了されても、それまでの行が残るように）。最後に通った確認を覚えておく
const T0 = Date.now();
let lastOk = '(開始前)';
const ok = (cond, msg) => { lastOk = msg; try { fs.writeSync(1, `[${((Date.now() - T0) / 1000).toFixed(0)}s] ${cond ? 'PASS' : 'FAIL'}  ${msg}\n`); } catch (_) { /* 無視 */ } if (!cond) failed++; };
// 全体の監視: 時間を超えたら、最後に通った確認を出して失敗にする（外側の timeout を使い切る前に止める）
const WATCHDOG_MS = Number(process.env.EXT_E2E_TIMEOUT_MS || 720000);
const watchdog = setTimeout(() => { try { fs.writeSync(1, `ERROR  全体のタイムアウト（${WATCHDOG_MS / 1000} 秒）。最後に通った確認: ${lastOk}\n`); } catch (_) { /* 無視 */ } try { cleanup(); } catch (_) { /* 無視 */ } process.exit(2); }, WATCHDOG_MS);

// closed Shadow DOM の中の要素（class が一致するもの）の位置を、CDP の DOM.getDocument（pierce）で調べる。無ければ null
async function pierceBox(pg, cls) {
  const { root } = await pg.send('DOM.getDocument', { depth: -1, pierce: true });
  const find = (n) => {
    const a = n.attributes || [];
    const i = a.indexOf('class');
    if (i >= 0 && a[i + 1].split(/\s+/).includes(cls)) return n;
    for (const c of [...(n.children || []), ...(n.shadowRoots || []), ...(n.contentDocument ? [n.contentDocument] : [])]) { const r = find(c); if (r) return r; }
    return null;
  };
  const n = find(root);
  if (!n) return null;
  const { model } = await pg.send('DOM.getBoxModel', { backendNodeId: n.backendNodeId });
  const q = model.border;
  return { left: q[0], top: q[1], right: q[2], bottom: q[5] };
}

// 試験用の PNG（RGBA）。外周が bg、中央の半分の大きさの四角が fg
function makePng(w, h, bg, fg) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inner = x >= w / 4 && x < (3 * w) / 4 && y >= h / 4 && y < (3 * h) / 4;
      const c = inner ? fg : bg;
      const o = y * stride + 1 + x * 4;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = c[3];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- テスト用の Web サーバ

const pages = {
  // ストア用のスクリーンショット（STORE_SHOTS_DIR）に使う、見た目のあるページ（架空のサイト）
  '/shop-welcome.html': `<!doctype html><meta charset="utf-8"><title>Example Shop</title><body style="margin:0;font-family:'Segoe UI','Yu Gothic UI',sans-serif;background:#f4f6f9;color:#1f2933"><header style="background:#fff;border-bottom:1px solid #e3e8ed;padding:16px 40px;font-weight:700;font-size:22px;color:#e8590c">Example Shop</header><main style="padding:60px 40px"><h1>ようこそ</h1><p>ログインしました。</p></main>`,
  '/blank.html': `<!doctype html><title>blank</title><body></body>`,
  '/shop-login.html': `<!doctype html><meta charset="utf-8"><title>Example Shop</title>
    <style>body{margin:0;font-family:'Segoe UI','Yu Gothic UI',sans-serif;background:#f4f6f9;color:#1f2933}header{background:#fff;border-bottom:1px solid #e3e8ed;padding:16px 40px;font-weight:700;font-size:22px;color:#e8590c}
    main{display:flex;justify-content:center;padding:70px 20px}form{background:#fff;border:1px solid #e3e8ed;border-radius:12px;padding:34px 40px;width:360px;box-shadow:0 8px 30px rgba(20,40,60,.08)}
    h1{margin:0 0 20px;font-size:22px}label{display:block;font-size:13px;color:#5b6773;margin:14px 0 4px}input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cdd5dc;border-radius:6px;font-size:15px}
    button{margin-top:24px;width:100%;padding:12px;border:0;border-radius:6px;background:#e8590c;color:#fff;font-size:16px;font-weight:600}</style>
    <header>Example Shop</header><main><form id="f" method="post" action="/shop-welcome.html"><h1>ログイン</h1>
    <label for="email">メールアドレス</label><input id="email" name="email" type="email" autocomplete="username">
    <label for="pw">パスワード</label><input id="pw" name="password" type="password" autocomplete="current-password">
    <button id="go" type="submit">ログイン</button></form></main>`,
  '/shop-signup.html': `<!doctype html><meta charset="utf-8"><title>Example Shop</title>
    <style>body{margin:0;font-family:'Segoe UI','Yu Gothic UI',sans-serif;background:#f4f6f9;color:#1f2933}header{background:#fff;border-bottom:1px solid #e3e8ed;padding:16px 40px;font-weight:700;font-size:22px;color:#e8590c}
    main{display:flex;justify-content:center;padding:50px 20px}form{background:#fff;border:1px solid #e3e8ed;border-radius:12px;padding:30px 40px;width:380px;box-shadow:0 8px 30px rgba(20,40,60,.08)}
    h1{margin:0 0 14px;font-size:22px}label{display:block;font-size:13px;color:#5b6773;margin:12px 0 4px}input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cdd5dc;border-radius:6px;font-size:15px}
    button{margin-top:22px;width:100%;padding:12px;border:0;border-radius:6px;background:#e8590c;color:#fff;font-size:16px;font-weight:600}</style>
    <header>Example Shop</header><main><form id="f" method="post" action="/welcome"><h1>新規登録</h1>
    <label for="user">メールアドレス</label><input id="user" name="user" type="email" autocomplete="username">
    <label for="pw1">パスワード</label><input id="pw1" name="pw1" type="password" autocomplete="new-password">
    <label for="pw2">パスワード（確認）</label><input id="pw2" name="pw2" type="password" autocomplete="new-password">
    <button id="go" type="submit">登録する</button></form></main>`,
  // 新規登録のようなフォーム（パスワード欄が縦に 2 つ）。生成パネルの位置のテスト用。-low は、フォームが画面の下端に来る
  '/signup.html': `<!doctype html><title>signup</title><body style="margin:0;font:14px sans-serif"><h1>Sign up</h1>
    <form id="f" method="post" action="/welcome"><div><input id="user" name="user" type="text" autocomplete="username" style="width:260px"></div>
    <div><input id="pw1" name="pw1" type="password" autocomplete="new-password" style="width:260px"></div>
    <div><input id="pw2" name="pw2" type="password" autocomplete="new-password" style="width:260px"></div>
    <button id="go" type="submit">Sign up</button></form><div style="height:1200px"></div>`,
  '/signup-low.html': `<!doctype html><title>signup-low</title><body style="margin:0;font:14px sans-serif"><div style="height:1500px"></div><h1>Sign up</h1>
    <form id="f" method="post" action="/welcome"><div><input id="user" name="user" type="text" autocomplete="username" style="width:260px"></div>
    <div><input id="pw1" name="pw1" type="password" autocomplete="new-password" style="width:260px"></div>
    <div><input id="pw2" name="pw2" type="password" autocomplete="new-password" style="width:260px"></div>
    <button id="go" type="submit">Sign up</button></form><div style="height:20px"></div>`,
  '/login.html': `<!doctype html><title>login</title><body><h1>Sign in</h1>
    <form id="f" method="post" action="/welcome"><label>Email <input id="email" name="email" type="email" autocomplete="username"></label>
    <label>Password <input id="pw" name="password" type="password" autocomplete="current-password"></label>
    <button id="go" type="submit">Sign in</button></form>`,
  '/change.html': `<!doctype html><title>change</title><body><h1>Change password</h1>
    <form id="f" method="post" action="/welcome"><input id="email" name="username" type="text" value="octocat@example.com">
    <input id="old" name="old" type="password" autocomplete="current-password"><input id="new1" name="new1" type="password" autocomplete="new-password">
    <input id="new2" name="new2" type="password" autocomplete="new-password"><button id="go" type="submit">Update</button></form>`,
  '/address.html': `<!doctype html><title>address</title><body><h1>Shipping</h1><form id="f" method="post" action="/welcome">
    <input id="ln" name="last_name" placeholder="姓"><input id="fn" name="first_name" placeholder="名">
    <input id="mail" name="email" type="email"><input id="zip" name="zip" placeholder="郵便番号"><input id="city" name="city" placeholder="市区町村">
    <button type="submit">OK</button></form>`,
  '/otp.html': `<!doctype html><title>otp</title><body><h1>2FA</h1><form id="f" method="post" action="/welcome">
    <input id="otp" name="otp" autocomplete="one-time-code" inputmode="numeric" maxlength="6"><button type="submit">Verify</button></form>`,
  '/slow-login.html': `<!doctype html><title>slow login</title><body><h1>Sign in (slow)</h1>
    <form id="f" method="post" action="/slow-auth"><input id="user" name="user" type="text" autocomplete="username">
    <input id="pw" name="password" type="password" autocomplete="current-password"><button id="go" type="submit">Login</button></form>`,
  '/welcome': `<!doctype html><title>welcome</title><body><h1 id="ok">Welcome</h1>`,
  // ラジオ（ドメインの種類）で、ドメイン欄の表示が切り替わる。アカウントとパスワード。ドメインの欄は、ユーザー ID と取り違えやすい
  '/lolipop.html': `<!doctype html><title>lolipop-like</title><body><h1>Login</h1>
    <form id="f" method="post" action="/welcome">
      <label><input type="radio" name="domain_type" id="dt1" value="lolipop" checked>ロリポップのドメイン</label>
      <label><input type="radio" name="domain_type" id="dt2" value="original">独自ドメイン</label>
      <div id="lp"><select name="domain_name_3" id="domain_name_3"><option value="co.jp">co.jp</option><option value="ne.jp">ne.jp</option><option value="to">to</option></select></div>
      <div id="own" style="display:none"><input type="text" name="domain_name_own" id="domain_name_own" placeholder="独自ドメイン"></div>
      <label>アカウント <input type="text" name="account" id="account"></label>
      <label>パスワード <input type="password" name="passwd" id="passwd"></label>
      <button type="submit" id="go">ログイン</button>
    </form>
    <script>
      for (const r of document.querySelectorAll('input[name=domain_type]')) r.addEventListener('change', () => {
        const own = document.querySelector('#dt2').checked;
        document.querySelector('#lp').style.display = own ? 'none' : '';
        document.querySelector('#own').style.display = own ? '' : 'none';
      });
    </script>`,
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/auth') {
    const h = req.headers.authorization || '';
    if (h === 'Basic ' + Buffer.from('bob:bob-pass').toString('base64')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>auth ok</title><h1 id="ok">Basic OK</h1>'); return; }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="t"', 'content-type': 'text/html' });
    res.end('denied');
    return;
  }
  if (url.pathname === '/slow-auth') {
    setTimeout(() => { res.writeHead(303, { location: '/welcome' }); res.end(); }, 1500);
    return;
  }
  const body = pages[url.pathname];
  if (!body) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
});
await new Promise((r) => server.listen(WEB_PORT, '127.0.0.1', r));
const BASE = `http://localhost:${WEB_PORT}`;
server.on('connection', () => {});

// ---------------------------------------------------------------- 起動

const helloStub = path.join(dataDir, '..', path.basename(dataDir) + '-hello-stub.txt');
fs.writeFileSync(helloStub, 'ok');
// Windows Hello の確認ダイアログは自動操作できないため、テスト専用の差し替え（TKRFORM_TEST のときだけ有効）で成功・失敗を再現する
const nmSaved = nmRegistrySave(); // アプリが書き換える Native Messaging の登録を、終わったら戻す
const app = startApp({ dataDir, cdpPort: APP_PORT, env: { TKRFORM_REGISTER_NM: '1', TKRFORM_HELLO_STUB_FILE: helloStub } });
let chrome = null;
const cleanup = () => { try { server.close(); } catch (_) { /* 無視 */ } if (chrome) killTree(chrome); killTree(app.child); nmRegistryRestore(nmSaved); };

async function chromeTargets() {
  return (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json();
}

/** タブそのものを閉じる（後のテストが、残ったタブを対象に選ばないように）。 */
async function closeTab(c) {
  c.close();
  if (c.targetId) await fetch(`http://127.0.0.1:${CHROME_PORT}/json/close/${c.targetId}`).catch(() => {});
}

// 保存ダイアログの [保存] を押す。ダイアログの iframe は、中身の高さが決まるまで小さく、ボタンが表示領域の外にあることがある
// （その間に座標を押すと、何にも当たらない）。ボタンが表示領域に入って位置が落ち着くのを待ってから押す。
async function clickSave(frame, host) {
  // ダイアログを載せているページが裏のタブだと、描画が止まって、iframe の大きさが決まらないことがある
  if (host) await host.send('Page.bringToFront').catch(() => {});
  const state = () => frame.eval(`(() => { const b = document.querySelector('#save'); const r = b.getBoundingClientRect(); return { w: r.width, top: Math.round(r.top), bottom: Math.round(r.bottom), inner: window.innerHeight, doc: document.documentElement.scrollHeight, vis: document.visibilityState }; })()`);
  await waitFor(async () => { const r = await state(); return r.w > 0 && r.top >= 0 && r.bottom <= r.inner; }, 8000, '保存ボタンが見える位置にある').catch(async (e) => {
    throw new Error(e.message + ' / ' + JSON.stringify(await state().catch((x) => x.message)));
  });
  await sleep(250);
  await frame.click('#save');
}

async function openTab(url) {
  const r = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const t = await r.json();
  const c = await Cdp.connect(t.webSocketDebuggerUrl);
  c.targetId = t.id; // タブそのものを閉じるときに使う（close() は接続を閉じるだけで、タブは残る）
  // ヘッドレスではページにフォーカスがないため、フォーカスイベントが発火するようエミュレートする
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await c.send('Page.bringToFront').catch(() => {});
  await c.waitLoaded(); // 指定した URL のページが読み込まれるまで待つ（about:blank のまま返さない）
  return c;
}

try {
  // アプリ: ウィザードを飛ばして保管庫を作る
  const st = await waitTarget(APP_PORT, (x) => x.url.includes('setup.html'));
  const ui = await Cdp.connect(st.webSocketDebuggerUrl);
  await waitFor(() => ui.eval(`typeof rpc === 'function'`), 10000);
  await ui.eval(`rpc('setup', { mp: ${JSON.stringify(MP)}, hint: '', iterations: 100000 })`);
  ok(fs.existsSync(path.join(dataDir, 'main', 'vault.hdr')), 'アプリで保管庫を作成');

  const pipe = await PipeClient.connect();

  // Chrome 137 以降の製品版は --load-extension を無視するため、CDP（--remote-debugging-pipe）の
  // Extensions.loadUnpacked で読み込む。ほかの操作は --remote-debugging-port の CDP を使う。
  chrome = spawn(CHROME, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${CHROME_PORT}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', ...(headful ? [] : ['--headless=new']), 'about:blank',
  ], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    // 接続役がアプリを起動し直すとき、利用者の保管庫ではなく、テスト用のものを使うよう、環境を引き継がせる
    env: { ...process.env, TKRFORM_TEST: '1', TKRFORM_DATA_DIR: dataDir, WEBVIEW2_USER_DATA_FOLDER: dataDir + '-wv2-relaunch', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${APP_PORT}` },
  });
  chrome.stderr.on('data', (d) => { if (process.env.E2E_DEBUG) console.log('chrome:', String(d).slice(0, 400)); });
  chrome.on('exit', (c) => console.log('chrome exit', c));
  await waitFor(async () => (await chromeTargets()).length > 0, 30000, 'Chrome の起動');
  const pipeIn = chrome.stdio[3];
  const pipeOut = chrome.stdio[4];
  let pbuf = '';
  const loaded = new Promise((resolve, reject) => {
    pipeOut.on('data', (d) => {
      pbuf += String(d);
      for (;;) {
        const i = pbuf.indexOf(' ');
        if (i < 0) return;
        const m = JSON.parse(pbuf.slice(0, i));
        pbuf = pbuf.slice(i + 1);
        if (m.id === 1) { if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); }
      }
    });
  });
  watchWindows(chrome.pid, 'chrome');
  pipeIn.write(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: path.join(ROOT, 'extension') } }) + ' ');
  const lr = await loaded;
  ok(lr.id === EXT_ID, `拡張を読み込んだ（ID ${lr.id} が固定 ID と一致）`);

  // 拡張のサービスワーカーが起動するのを待つ
  const sw = await waitFor(async () => (await chromeTargets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID)), 30000, '拡張のサービスワーカー');
  ok(true, '拡張が Chrome に読み込まれた（ID が固定されている）');
  // サービスワーカー自身は自分宛てのメッセージを受けられないので、拡張ページ（設定）を橋渡しに使う
  const swc = await openTab(`chrome-extension://${EXT_ID}/start.html`);
  await waitFor(() => swc.eval(`typeof bg === 'function'`), 10000, '拡張ページ');
  const swState = async () => swc.eval(`bg({ t: 'state' }).catch((e) => ({ connected: false, locked: true, __err: JSON.stringify(e) }))`);
  await waitFor(async () => (await swState()).connected, 20000, 'NM 接続');
  ok(true, 'NM ホスト経由でアプリに接続できた');
  ok((await swState()).locked === false, '拡張がロック状態（解除）を受け取っている');

  // ------------------------------------------------------ 確認用（HOME_REAL_SHOT=保存先の PNG）: 実際の公開サイトのアイコンを取得して、ホームを撮る。通常の実行では動かない
  if (process.env.HOME_REAL_SHOT) {
    const real = [
      ['楽天銀行', 'https://www.rakuten-bank.co.jp/'], ['楽天カード', 'https://www.rakuten-card.co.jp/'], ['楽天証券', 'https://www.rakuten-sec.co.jp/'],
      ['Yahoo! JAPAN', 'https://www.yahoo.co.jp/'], ['ヨドバシ.com', 'https://www.yodobashi.com/'], ['モノタロウ', 'https://www.monotaro.com/'],
      ['三井住友カード', 'https://www.smbc-card.com/'], ['Amazon.co.jp', 'https://www.amazon.co.jp/'], ['GitHub', 'https://github.com/'], ['Google', 'https://www.google.com/'],
    ];
    for (const [name, url] of real) {
      await pipe.ok('saveItem', { mode: 'new', item: { type: 1, name, folder: '/', url, fields: [{ name: 'u', value: 'sample-user', kind: 'text', role: 'user' }, { name: 'p', value: 'Sample-Pass-1', kind: 'password', role: 'password' }] } });
    }
    await swc.eval(`chrome.storage.local.set({ 'tkrform.home.icons': true })`);
    await swc.eval(`bg({ t: 'iconClear' })`);
    const rh = await openTab(`chrome-extension://${EXT_ID}/start.html`);
    await rh.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    // 取得が落ち着くまで待つ（最大 90 秒）。取得済みのキャッシュの数が、5 秒変わらなくなったら終わり
    let last = -1, stable = 0;
    for (let i = 0; i < 90 && stable < 5; i++) {
      await sleep(1000);
      const n = await swc.eval(`chrome.storage.local.get(null).then((a) => Object.keys(a).filter((k) => k.startsWith('icon:')).length)`);
      if (n === last && n >= real.length) stable++; else stable = 0;
      last = n;
    }
    await sleep(500);
    await rh.screenshot(process.env.HOME_REAL_SHOT);
    const cache = await swc.eval(`chrome.storage.local.get(null).then((a) => Object.entries(a).filter(([k]) => k.startsWith('icon:')).map(([k, v]) => ({ origin: k.slice(5), ok: !v.fail, w: v.w || 0, h: v.h || 0, bg: v.bg || '', why: v.why || '' })))`);
    for (const c of cache) console.log(`${c.ok ? 'OK  ' : 'NONE'} ${c.origin} ${c.ok ? c.w + 'x' + c.h : ''} bg=${c.bg} :: ${c.why}`);
    clearTimeout(watchdog);
    cleanup();
    process.exit(0);
  }

  // ------------------------------------------------------ 確認用（STORE_SHOTS_DIR=保存先のフォルダ）: ストアに出すスクリーンショット（1366×768）を、架空のデータで撮る。通常の実行では動かない
  if (process.env.STORE_SHOTS_DIR || process.env.MANUAL_SHOTS_DIR) {
    const dir = process.env.STORE_SHOTS_DIR || path.join(process.env.TEMP || '.', 'store-shots-tmp'); // MANUAL_SHOTS_DIR だけのときは、ストア用の画像は、使い捨ての場所へ
    fs.mkdirSync(dir, { recursive: true });
    const [W, H] = (process.env.STORE_SHOTS_SIZE || '1366x768').split('x').map(Number); // Store は 1366×768、拡張のストアは 1280×800
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const old = new Date(Date.now() - 500 * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');
    const mk = (name, url, user, pw, extra = {}) => pipe.ok('saveItem', { mode: 'new', item: { type: 1, name, folder: extra.folder || '/', url, favorite: !!extra.favorite, useCount: extra.uses || 0, useScore: extra.uses || 0, scoreAt: extra.uses ? now : undefined, lastUsed: extra.uses ? now : undefined, created: extra.created, totpKey: extra.totp || '', fields: [{ name: 'user', id: 'user', value: user, kind: 'text', role: 'user' }, { name: 'pw', id: 'pw', value: pw, kind: 'password', role: 'password' }] } });
    await mk('Example Mail', 'https://mail.example.com/login', 'taro.example@example.com', 'Kq7#vN2$mXp9-wLr4', { favorite: true, uses: 9, totp: 'JBSWY3DPEHPK3PXP' });
    await mk('Sample Shop', 'https://shop.example.net/signin', 'taro.example@example.com', 'Zt5!hD8&cYb3-nQe6', { favorite: true, uses: 7 });
    await mk('Demo Bank', 'https://bank.example.org/login', 'demo-user-01', 'Rw9$jF4#kLs2-pVx7', { uses: 5, folder: '/金融' });
    await mk('Test Cloud', 'https://cloud.example.com/', 'taro@example.com', 'Bn6@gT3!zHc8-mUy1', { uses: 4, folder: '/仕事' });
    await mk('Example News', 'https://news.example.net/account', 'taro-news', 'Xe2#qM7$vKd5-oJa9', { uses: 3 });
    await mk('Sample Travel', 'https://travel.example.org/login', 'taro_travel', 'Lp8!wC1&yRf4-sGn6', { uses: 2, folder: '/買い物' });
    await mk('Demo Forum', 'https://forum.example.com/login', 'taro', 'password1', { uses: 1 });
    await mk('Old Blog', 'https://blog.example.net/wp-login', 'taro', 'Reused-Pass-Example-7!', { created: old });
    await mk('Reused Site', 'https://wiki.example.org/login', 'taro', 'Reused-Pass-Example-7!');
    await mk('Example Game', 'https://game.example.com/login', 'taro-game', 'Reused-Pass-Example-7!');
    await mk('Sample Shop (サブ)', 'https://shop.example.net/signin', 'taro.example@example.com', 'Vd4$kP9!bNz2-xTq5');
    await swc.eval(`chrome.storage.local.set({ 'tkrform.home.icons': false, 'tkrform.home.iconsNoteClosed': true })`);
    const light = (c) => c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }).catch(() => {});
    const size = (c, w, h) => c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    const shot = async (c, name) => { await c.screenshot(path.join(dir, name)); console.log('撮影: ' + name); };
    const ids = (await pipe.ok('search', { q: '', types: [1], limit: 50 })).map((e) => e.id);

    // 1. エディタ（ログインの詳細）
    await ui.eval(`rpc('openWindow', { name: 'editor' })`);
    const edT = await waitTarget(APP_PORT, (x) => x.url.includes('editor.html'), 30000);
    const ed = await Cdp.connect(edT.webSocketDebuggerUrl);
    await size(ed, W, H); await light(ed);
    await waitFor(() => ed.eval(`document.querySelectorAll('.rowitem').length >= 8`), 15000, 'エディタの一覧');
    await ed.eval(`[...document.querySelectorAll('.rowitem')].find((r) => r.querySelector('.name').textContent === 'Example Mail').click()`);
    await waitFor(() => ed.eval(`!!document.querySelector('.view .vname') && document.querySelector('.view .vname').textContent === 'Example Mail'`), 8000, 'ログインの詳細（表示の画面）');
    await sleep(1000);
    await shot(ed, '01-editor-login.png');

    // 2. セキュリティセンター
    await ui.eval(`rpc('openWindow', { name: 'security' })`);
    const seT = await waitTarget(APP_PORT, (x) => x.url.includes('security.html'), 30000);
    const se = await Cdp.connect(seT.webSocketDebuggerUrl);
    await size(se, W, H); await light(se);
    await waitFor(() => se.eval(`document.querySelectorAll('#tabs [role=tab]').length === 5 && !!document.querySelector('#panel-weak .body').firstChild`), 15000, 'セキュリティセンター');
    await se.eval(`document.querySelector('#tab-reused').click()`);
    await sleep(800);
    await shot(se, '02-security-center.png');
    // 2a. 長い URL の行（改良案の確認用。掲載用の画像には出さない）
    if (/gui-proposal/.test(dir)) {
      const longUrl = 'https://login.account.example.com/sso/start?client_id=sample-client&redirect_uri=' + 'https%3A%2F%2Fapp.example.com%2Fcallback%2F'.repeat(12) + '&state=abc123';
      const lu = await pipe.ok('saveItem', { mode: 'new', item: { type: 1, name: 'Long SSO Example', folder: '/', url: longUrl, fields: [{ name: 'u', value: 'taro.sample@example.com', kind: 'text', role: 'user' }, { name: 'p', value: 'password1', kind: 'password', role: 'password' }] } });
      await se.eval(`document.querySelector('#rescan').click()`);
      await se.eval(`document.querySelector('#tab-weak').click()`);
      await waitFor(() => se.eval(`[...document.querySelectorAll('#panel-weak .rows li')].some((li) => li.textContent.includes('Long SSO Example'))`), 8000, '長い URL の行');
      await sleep(500);
      await shot(se, '02c-security-long-url.png');
      await pipe.ok('deleteItem', { id: lu.id });
      await se.eval(`document.querySelector('#rescan').click()`);
      await se.eval(`document.querySelector('#tab-reused').click()`);
      await sleep(500);
    }
    // 2b. 設定
    await ui.eval(`rpc('openWindow', { name: 'settings' })`);
    const stT = await waitTarget(APP_PORT, (x) => x.url.includes('settings.html'), 30000);
    const stg = await Cdp.connect(stT.webSocketDebuggerUrl);
    await size(stg, W, H); await light(stg);
    await sleep(1000);
    await shot(stg, '02b-settings.png');

    // 3. ホーム（タイル）
    const home = await openTab(`chrome-extension://${EXT_ID}/start.html`);
    await size(home, W, H); await light(home);
    await waitFor(() => home.eval(`document.querySelectorAll('.tile').length >= 8`), 15000, 'ホーム');
    await sleep(800);
    await shot(home, '03-home.png');
    await closeTab(home);

    // 4. 拡張のポップアップ（よく使う）。小さい画面なので、1366×768 の背景の中央に置く
    const pop = await openTab(`chrome-extension://${EXT_ID}/popup.html`);
    await size(pop, 380, 600); await light(pop);
    await waitFor(() => pop.eval(`document.querySelectorAll('#list li').length >= 5`), 15000, 'ポップアップの一覧');
    // ポップアップは、ふつうは開いているページに合うログインを「このサイト」に出す。撮影では、今のページを、保存したサイトのものにする（見た目だけ）
    await pop.eval(`activeTab = { id: 0, url: 'https://mail.example.com/login' }; loadList();`);
    await waitFor(() => pop.eval(`!document.querySelector('#here').classList.contains('hidden')`), 8000, '「このサイト」の枠');
    await sleep(800);
    const popPng = path.join(dir, '.popup-raw.png');
    await pop.screenshot(popPng);
    await closeTab(pop);

    // 5. 自動保存のダイアログと、パスワード生成のパネル（ページの上に出る）。一致するログインの候補を出すため、このページ用の項目をここで作る
    await mk('Example Shop', `${BASE}/shop-login.html`, 'taro.example@example.com', 'Hj3$mQ8!vZc5-rWd2', { uses: 6 });
    const page = await openTab(`${BASE}/shop-login.html`);
    await size(page, W, H); await light(page);
    await sleep(600);
    // 入力欄にフォーカスすると、一致するログインの候補が出る
    await page.click('#email');
    await sleep(1500);
    await shot(page, '07-inline-menu.png');
    await page.type('#email', 'new.account@example.com');
    await page.type('#pw', 'Hj3$mQ8!vZc5-rWd2');
    await page.press('Escape', 'Escape', 27); // 候補のメニューが送信ボタンに重なるので、閉じてから押す
    await sleep(300);
    await page.click('#go');
    const sv = await waitFor(async () => (await chromeTargets()).find((t) => t.url.includes(`${EXT_ID}/save.html`)), 15000, '保存ダイアログ');
    const svc = await Cdp.connect(sv.webSocketDebuggerUrl);
    await waitFor(() => svc.eval(`!document.querySelector('#form').classList.contains('hidden')`), 8000, '保存フォーム');
    await svc.eval(`document.querySelector('#name').value = 'Example Shop'; document.querySelector('#who').textContent = 'new.account@example.com @ shop.example.net'`);
    await sleep(1200);
    await shot(page, '04-autosave-dialog.png');
    svc.close();
    const page2 = await openTab(`${BASE}/shop-signup.html`);
    await size(page2, W, H); await light(page2);
    await sleep(600);
    await page2.eval(`document.querySelector('#pw1').focus()`);
    await sleep(1200);
    await page2.press('Escape', 'Escape', 27); // 候補のメニューを閉じる
    await sleep(300);
    await swc.eval(`(async () => { const [tab] = await chrome.tabs.query({ url: '${BASE}/shop-signup.html' }); await chrome.tabs.sendMessage(tab.id, { t: 'cmd', name: 'generate' }); })()`);
    await sleep(2000);
    await shot(page2, '05-password-generator.png');

    // ポップアップを、背景の上に置いた画像にする
    const comp = await openTab(`${BASE}/blank.html`);
    await size(comp, W, H); await light(comp);
    const b64 = fs.readFileSync(popPng).toString('base64');
    await comp.eval(`document.body.style.cssText = 'margin:0;width:${W}px;height:${H}px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#dbeafe,#e6f4ee)'; document.body.innerHTML = '<img src="data:image/png;base64,${b64}" style="box-shadow:0 18px 60px rgba(20,40,60,.35);border-radius:10px;height:680px">';`);
    await sleep(500);
    await shot(comp, '06-extension-popup.png');
    // マニュアルの画像（画面の要素から、番号つきの枠の位置も出す）
    if (process.env.MANUAL_SHOTS_DIR) {
      const { run } = await import('./manual-shots.mjs');
      await run({ pipe, ui, APP_PORT, waitTarget, Cdp, openTab, closeTab, EXT_ID, swc, sleep, waitFor, fs, path, outDir: path.resolve(process.env.MANUAL_SHOTS_DIR), ed, se, stg });
    }
    for (const p of [ed, se, comp, page, page2]) { try { p.close(); } catch (_) { /* 無視 */ } }
    fs.rmSync(popPng, { force: true });
    clearTimeout(watchdog);
    cleanup();
    process.exit(0);
  }

  // ------------------------------------------------------ 自動保存
  let login = await openTab(`${BASE}/login.html`);
  await waitFor(() => login.eval(`document.readyState === 'complete'`));
  await sleep(600);
  await login.type('#email', 'octocat@example.com');
  await login.type('#pw', 'first-Password-123');
  await login.click('#go');
  // 保存ダイアログ（拡張の iframe）が出る
  const saveFrame = await waitFor(async () => (await chromeTargets()).find((t) => t.url.includes(`${EXT_ID}/save.html`)), 15000, '保存ダイアログ');
  ok(true, 'ログイン送信を検知して保存ダイアログが出る');
  const sf = await Cdp.connect(saveFrame.webSocketDebuggerUrl);
  await waitFor(() => sf.eval(`!document.querySelector('#form').classList.contains('hidden')`), 8000, '保存フォーム');
  ok((await sf.eval(`document.querySelector('#title').textContent`)).includes('保存'), '保存ダイアログのタイトル');
  ok((await sf.eval(`document.querySelector('#name').value`)) === 'localhost', '名前の既定はドメイン');
  await clickSave(sf);
  await waitFor(async () => (await pipe.ok('search', { q: 'octocat', types: [1], limit: 5 })).length === 1, 8000, '保存の反映');
  const saved = (await pipe.ok('search', { q: 'octocat', types: [1], limit: 5 }))[0];
  const full = await pipe.ok('getItem', { id: saved.id });
  ok(full.login_password === undefined && full.fields.find((f) => f.role === 'password').value === 'first-Password-123', '自動保存でパスワードが保管庫に入った');
  ok(full.fields.find((f) => f.role === 'user').id === 'email', '保存時のフィールド id も記録される');
  sf.close(); login.close();

  // ------------------------------------------------------ 送信後の応答が遅く、旧ページにダイアログが出てから遷移する場合
  const slow = await openTab(`${BASE}/slow-login.html`);
  await waitFor(() => slow.eval(`document.readyState === 'complete'`));
  await sleep(600);
  await slow.type('#user', 'slowuser');
  await slow.type('#pw', 'slow-Password-789');
  await slow.click('#go');
  await waitFor(async () => (await chromeTargets()).some((t) => t.url.includes(`${EXT_ID}/save.html`)), 5000, '遷移前の保存ダイアログ');
  await waitFor(async () => (await chromeTargets()).some((t) => t.type === 'page' && t.url === `${BASE}/welcome`), 8000, 'ログイン後のページへ遷移');
  await sleep(1500); // 遷移前のページに出たダイアログが消え切るのを待つ
  const slowFrame = await waitFor(async () => (await chromeTargets()).find((t) => t.url.includes(`${EXT_ID}/save.html`)), 8000, '遷移後の保存ダイアログ');
  ok(true, '応答の遅いサイトでも、遷移後のページに保存ダイアログが出直す');
  const ssf = await Cdp.connect(slowFrame.webSocketDebuggerUrl);
  await waitFor(() => ssf.eval(`!document.querySelector('#form').classList.contains('hidden')`), 8000, '保存フォーム（遷移後）');
  await clickSave(ssf);
  await waitFor(async () => (await pipe.ok('search', { q: 'slowuser', types: [1], limit: 5 })).length === 1, 8000, '遷移後の保存の反映');
  ok(true, '遷移後のダイアログから保存できる');
  ssf.close(); slow.close();
  // 後続のテストは localhost のログインが 1 件である前提なので、ゴミ箱へ移す
  await pipe.ok('deleteItem', { id: (await pipe.ok('search', { q: 'slowuser', types: [1], limit: 5 }))[0].id });

  // ------------------------------------------------------ ポップアップから手動保存（送信せず、入力内容だけを保存）
  const man = await openTab(`${BASE}/login.html`);
  await waitFor(() => man.eval(`document.readyState === 'complete'`));
  await sleep(600);
  await man.type('#email', 'manual@example.com');
  const mp = await openTab(`chrome-extension://${EXT_ID}/popup.html`);
  await waitFor(() => mp.eval(`typeof bg === 'function'`), 8000, 'ポップアップ');
  const manTab = `(await chrome.tabs.query({ url: '${BASE}/login.html' }))[0].id`;
  // 前のテストの保存ダイアログが閉じきるのを待つ（残っていると、そちらを掴んでしまう）
  await waitFor(async () => !(await chromeTargets()).some((t) => t.url.includes(`${EXT_ID}/save.html`)), 8000, '前の保存ダイアログが閉じる');
  const emptyErr = await mp.eval(`(async () => bg({ t: 'saveFormInTab', tabId: ${manTab} }).then(() => '', (e) => e.message))()`);
  ok(emptyErr.includes('パスワードが入力されていません'), `パスワード未入力ならエラーになる（${emptyErr}）`);
  await man.type('#pw', 'manual-Pass-1');
  await mp.eval(`(async () => bg({ t: 'saveFormInTab', tabId: ${manTab} }))()`);
  const manFrame = await waitFor(async () => (await chromeTargets()).find((t) => t.url.includes(`${EXT_ID}/save.html`)), 8000, '手動保存のダイアログ');
  ok(true, 'ポップアップの「フォームの入力内容を保存」で保存ダイアログが出る');
  const mf = await Cdp.connect(manFrame.webSocketDebuggerUrl);
  await waitFor(() => mf.eval(`!document.querySelector('#form').classList.contains('hidden')`), 8000, '保存フォーム（手動）');
  await clickSave(mf, man);
  await waitFor(async () => (await pipe.ok('search', { q: 'manual@example.com', types: [1], limit: 5 })).length === 1, 8000, '手動保存の反映').catch(async (e) => {
    // 切り分け用: 保存されたか（件数・名前）と、保存ダイアログの状態
    const found = await pipe.ok('search', { q: 'manual@example.com', types: [1], limit: 10 }).then((r) => r.map((x) => `${x.name}/${x.id.slice(0, 6)}`).join(','), (x) => 'err ' + x.message);
    const dlg = await mf.eval(`JSON.stringify({ form: !document.querySelector('#form').classList.contains('hidden'), name: document.querySelector('#name').value, saveDisabled: document.querySelector('#save').disabled, err: document.querySelector('#err') ? document.querySelector('#err').textContent : null, title: document.querySelector('#title').textContent })`).catch((x) => 'dialog gone: ' + x.message);
    throw new Error(`${e.message} / 検索結果 [${found}] / ダイアログ ${dlg}`);
  });
  const manItem = await pipe.ok('getItem', { id: (await pipe.ok('search', { q: 'manual@example.com', types: [1], limit: 5 }))[0].id });
  ok(manItem.fields.find((f) => f.role === 'password').value === 'manual-Pass-1', '送信せずに、入力中の ID とパスワードを保存できる');
  ok(!(await man.eval(`location.pathname`)).includes('welcome'), '手動保存ではフォームを送信しない');
  // 後続のテストは localhost のログインが 1 件である前提なので、ゴミ箱へ移す
  await pipe.ok('deleteItem', { id: manItem.id });
  // close() は CDP の接続を閉じるだけでタブは残る。後続のテストが login.html のタブを探すので、別のページへ移しておく
  await man.eval(`location.href = '/welcome'`);
  mf.close(); mp.close(); man.close();

  // ------------------------------------------------------ ロックの伝播（3 秒以内）→ 解除 → 自動記入
  const t0 = Date.now();
  await pipe.ok('lock');
  await waitFor(async () => (await swState()).locked === true, 3000, '拡張がロックを認識');
  ok(Date.now() - t0 < 3000, `ロックが拡張に 3 秒以内に伝わる（${Date.now() - t0}ms）`);

  // ポップアップでロック解除
  const popup = await openTab(`chrome-extension://${EXT_ID}/popup.html`);
  await waitFor(() => popup.eval(`!document.querySelector('#v-locked').classList.contains('hidden')`), 8000, 'ポップアップのロック画面');
  await popup.screenshot(path.join(shots, 'popup-locked.png'));
  await popup.type('#mp', 'wrong-pass');
  await popup.click('#unlock');
  await waitFor(() => popup.eval(`!document.querySelector('#unlock-err').classList.contains('hidden')`), 5000, '誤った MP のエラー');
  ok((await popup.eval(`document.querySelector('#unlock-err').textContent`)).includes('違います'), 'ポップアップ: 誤った MP はエラー');
  await popup.type('#mp', MP);
  await popup.click('#unlock');
  await waitFor(() => popup.eval(`!document.querySelector('#v-main').classList.contains('hidden')`), 8000, 'ポップアップの解除');
  await waitFor(async () => (await swState()).locked === false, 5000, '拡張が解除を認識');
  ok(true, 'ポップアップから解除できる');
  // ログイン一覧タブ（既定のタブ）
  await popup.eval(`document.querySelectorAll('#tabs button')[0].click()`);
  await waitFor(() => popup.eval(`document.querySelectorAll('#list li .name').length === 1`), 5000, 'ログイン一覧');
  await popup.screenshot(path.join(shots, 'popup-main.png'));
  ok((await popup.eval(`document.querySelector('#list li .name').textContent`)) === 'localhost', 'ポップアップにログインが並ぶ');


  // ログイン一覧のフォルダ階層（検索語なし: フォルダ → 項目 / 検索語あり: 全フォルダから一覧）
  const pwField = (v) => [{ name: 'u', value: 'u', kind: 'text', role: 'user' }, { name: 'p', value: v, kind: 'password', role: 'password' }];
  await pipe.ok('saveItem', { mode: 'new', item: { type: 1, name: 'Work-top', url: 'https://work.example.com', folder: '/仕事', fields: pwField('a') } });
  await pipe.ok('saveItem', { mode: 'new', item: { type: 1, name: 'EC-site', url: 'https://ec.example.com', folder: '/仕事/EC', fields: pwField('b') } });
  const names = () => popup.eval(`[...document.querySelectorAll('#list li')].map((li) => li.querySelector('.name').textContent + (li.querySelector('.count') ? '(' + li.querySelector('.count').textContent + ')' : '')).join('|')`);
  const clickRow = (label) => popup.eval(`[...document.querySelectorAll('#list li')].find((li) => li.querySelector('.name').textContent === ${JSON.stringify(label)}).click()`);
  await popup.eval(`document.querySelectorAll('#tabs button')[1].click()`);
  await popup.eval(`document.querySelectorAll('#tabs button')[0].click()`);
  await waitFor(async () => (await names()) === '仕事(2)|localhost', 5000, 'ルートのフォルダ表示');
  ok(true, 'ポップアップのログイン一覧: ルートにフォルダ（件数つき）と項目が並ぶ');
  await clickRow('仕事');
  await waitFor(async () => (await names()) === '上のフォルダへ|EC(1)|Work-top', 5000, 'サブフォルダの表示');
  ok(true, 'フォルダを開くと「上へ」・サブフォルダ・項目が並ぶ');
  await clickRow('EC');
  await waitFor(async () => (await names()) === '上のフォルダへ|EC-site', 5000, '孫フォルダの表示');
  await popup.screenshot(path.join(shots, 'popup-folder.png'));
  await clickRow('上のフォルダへ');
  await waitFor(async () => (await names()) === '上のフォルダへ|EC(1)|Work-top', 5000, '上のフォルダへ戻る');
  ok(true, '「上のフォルダへ」で 1 つ上に戻れる');
  await popup.type('#q', 'EC-site');
  await waitFor(async () => (await popup.eval(`(document.querySelector('#list li .meta') || {}).textContent || ''`)).includes('仕事/EC'), 5000, '検索結果のフォルダ名');
  ok(true, '検索すると全フォルダから探し、フォルダ名が添えられる');
  await popup.type('#q', '');
  await waitFor(async () => (await names()).startsWith('上のフォルダへ'), 5000, '検索を消すとフォルダ表示に戻る');
  await clickRow('上のフォルダへ');
  await waitFor(async () => (await names()).startsWith('仕事(2)'), 5000, 'ルートへ戻る');

  // タブの並びと既定のタブ、「よく使う」（お気に入り → 使用回数 → 最近使った順。最上位・検索なしのときだけ）
  const fresh = await openTab(`chrome-extension://${EXT_ID}/popup.html`);
  await waitFor(() => fresh.eval(`!document.querySelector('#v-main').classList.contains('hidden') && document.querySelectorAll('#list li').length > 0`), 8000, '新しいポップアップ');
  const tabLabels = await fresh.eval(`[...document.querySelectorAll('#tabs button')].map((b) => b.textContent).join('|')`);
  ok(tabLabels === 'ログイン|プロフィール|メモ', `タブの並びは「ログイン | プロフィール | メモ」（${tabLabels}）。「このサイト」は、いちばん上の枠`);
  ok(await fresh.eval(`document.querySelector('#tabs button').getAttribute('aria-selected') === 'true'`), '開いたときの既定のタブは「ログイン」');
  ok(await fresh.eval(`document.activeElement && document.activeElement.id === 'q'`), '開いた直後に検索欄へフォーカスする');
  // 長い名前・ID・URL（数百文字）でも、ポップアップとホームの行・タイルがはみ出さず、操作が見える
  {
    const longName = 'LongName-' + 'n'.repeat(120), longUser = 'user-' + 'u'.repeat(150) + '@example.com', longUrl = 'https://login.example.com/sso?redirect=' + 'a'.repeat(400);
    const li = await pipe.ok('saveItem', { mode: 'new', item: { type: 1, name: longName, url: longUrl, folder: '/', fields: [{ name: 'u', value: longUser, kind: 'text', role: 'user' }, { name: 'p', value: 'Zq7#mK2$vLp9-xx', kind: 'password', role: 'password' }] } });
    await fresh.eval(`(() => { const q = document.querySelector('#q'); q.value = 'LongName-'; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(() => fresh.eval(`[...document.querySelectorAll('#list li .name')].some((n) => n.textContent.startsWith('LongName-'))`), 8000, '長い名前の行');
    await fresh.eval(`(() => { const s = document.createElement('style'); s.id = 'forcehover'; s.textContent = '#list li .actions { display: flex !important; }'; document.head.append(s); })()`);
    const pg = JSON.parse(await fresh.eval(`JSON.stringify((() => { const li = [...document.querySelectorAll('#list li')].find((x) => x.textContent.includes('LongName-')); const w = document.documentElement.clientWidth; return { w, scroll: document.documentElement.scrollWidth, liRight: li.getBoundingClientRect().right, bs: [...li.querySelectorAll('.actions button')].map((b) => b.getBoundingClientRect().right) }; })())`));
    ok(pg.scroll <= pg.w && pg.liRight <= pg.w && pg.bs.length > 0 && pg.bs.every((x) => x <= pg.w), `ポップアップの行は、長い名前・ID・URL でもはみ出さず、操作のボタンが見える（${JSON.stringify(pg)}）`);
    await fresh.eval(`document.querySelector('#forcehover').remove(); (() => { const q = document.querySelector('#q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const hm = await openTab(`chrome-extension://${EXT_ID}/start.html`);
    await waitFor(() => hm.eval(`[...document.querySelectorAll('.tile b')].some((b) => b.textContent.startsWith('LongName-'))`), 15000, 'ホームの長い名前のタイル');
    const hg = JSON.parse(await hm.eval(`JSON.stringify((() => { const t = [...document.querySelectorAll('.tile')].find((x) => x.textContent.includes('LongName-')); const w = document.documentElement.clientWidth; return { w, scroll: document.documentElement.scrollWidth, right: t.getBoundingClientRect().right, h: Math.round(t.getBoundingClientRect().height) }; })())`));
    ok(hg.scroll <= hg.w && hg.right <= hg.w && hg.h <= 170, `ホームのタイルは、長い名前でもはみ出さず、高さが伸びない（${JSON.stringify(hg)}）`);
    await closeTab(hm);
    await pipe.ok('deleteItem', { id: li.id });
  }
  // E2E ではポップアップ自体がアクティブなタブ（chrome-extension://）なので、ボタンは出ない。http(s) のページがアクティブなら出ることは、下で確認する
  const barHidden = () => fresh.eval(`document.querySelector('#site-bar').classList.contains('hidden')`);
  ok(await barHidden(), '「フォームの入力内容を保存」は、アクティブなタブが http(s) でなければ出ない（ログインタブ）');
  // activeTab を http(s) のページに見立てて、タブごとの表示を確認する
  await fresh.eval(`activeTab = { url: 'https://example.com/login' }; loadList();`);
  await waitFor(async () => !(await barHidden()), 3000, 'ログインタブでボタン表示');
  ok(true, '「ログイン」タブでも「フォームの入力内容を保存」が出る（アクティブなタブが http(s) のとき）');
  const tabBar = async (i) => { await fresh.eval(`document.querySelectorAll('#tabs button')[${i}].click()`); await sleep(400); return !(await barHidden()); };
  ok(!(await tabBar(1)) && !(await tabBar(2)) && (await tabBar(0)), '「ログイン」では出て、プロフィール・メモでは出ない');
  await fresh.eval(`activeTab = null; loadList();`);
  await sleep(400);
  const listNames = () => fresh.eval(`[...document.querySelectorAll('#list li')].map((li) => (li.classList.contains('empty') ? '!' + li.textContent : li.querySelector('.name').textContent + (li.querySelector('.count') ? '(' + li.querySelector('.count').textContent + ')' : ''))).join('|')`);
  const segSel = (pg) => (pg || fresh).eval(`(document.querySelector('#login-seg [aria-selected=true]') || {}).textContent || ''`);
  const segLabels = () => fresh.eval(`[...document.querySelectorAll('#login-seg button')].map((b) => b.textContent).join('|')`);
  ok((await segLabels()) === 'よく使う|ABC' && !(await fresh.eval(`document.querySelector('#login-seg').classList.contains('hidden')`)), '「ログイン」タブに「よく使う | ABC」のタグが出る');
  // 初回（保存した選択がなく、よく使うログインが 0 件）は「ABC」。フォルダが上に来る
  ok((await segSel()) === 'ABC', '初回は、よく使うログインが 0 件なので「ABC」を出す');
  ok(!(await listNames()).startsWith('!') && !(await fresh.eval(`!!document.querySelector('#list li.section')`)), '「ABC」の先頭に「よく使う」の欄は出ない（タグに移した）');
  await fresh.eval(`document.querySelector('#seg-frequent').click()`);
  await waitFor(async () => (await listNames()).startsWith('!'), 5000, '0 件の案内');
  ok((await listNames()).includes('まだよく使うログインはありません。ABC から選んで使うと、ここに並びます。'), '「よく使う」が 0 件のときは、案内を出す');
  await fresh.eval(`document.querySelector('#seg-abc').click()`);
  await waitFor(async () => !(await listNames()).startsWith('!'), 5000, 'ABC に戻る');
  const idOf = async (q) => (await pipe.ok('search', { q, types: [1], limit: 5 }))[0].id;
  const workId = await idOf('Work-top'), ecId = await idOf('EC-site'), localId = (await pipe.ok('search', { q: 'localhost', types: [1], limit: 5 })).find((e) => e.name === 'localhost').id;
  // 60 秒以内の続けての使用は 1 回と数えるため、使用の点数は直接書く（3 回使った状態）
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  await pipe.ok('saveItem', { mode: 'update', item: { id: workId, useCount: 3, useScore: 3, scoreAt: stamp, lastUsed: stamp } });
  await pipe.ok('touch', { id: ecId });
  await pipe.ok('saveItem', { mode: 'update', item: { id: localId, favorite: true } });
  const reload = async () => { await fresh.eval(`document.querySelectorAll('#tabs button')[1].click(); document.querySelectorAll('#tabs button')[0].click();`); };
  await reload();
  await waitFor(async () => (await segSel()) === 'ABC' && (await listNames()) === '仕事(2)|localhost', 5000, 'ABC の表示');
  ok(true, '「ABC」は、フォルダ → ログインの順（フォルダが上）に並ぶ');
  await fresh.eval(`document.querySelector('#seg-frequent').click()`);
  await waitFor(async () => (await listNames()) === 'localhost|Work-top|EC-site', 5000, '「よく使う」の表示');
  ok(true, `「よく使う」は、お気に入り → 使用の点数の高い順で並び、フォルダは出さない（${await listNames()}）`);
  ok((await fresh.eval(`[...document.querySelectorAll('#list li')].find((li) => li.querySelector('.name').textContent === 'Work-top').querySelector('.meta').textContent`)).includes('仕事'), '「よく使う」の行には、フォルダ名が小さく添えられる');
  await fresh.screenshot(path.join(shots, 'popup-frequent.png'));
  ok((await fresh.eval(`localStorage.getItem('tkrform.popupLoginView')`)) === 'frequent', '選んだタグ（よく使う）が保存される');
  // 次に開いたときも、選んだタグ。ABC のフォルダは常に上
  const fresh2 = await openTab(`chrome-extension://${EXT_ID}/popup.html`);
  await waitFor(() => fresh2.eval(`!document.querySelector('#v-main').classList.contains('hidden') && document.querySelectorAll('#list li').length > 0`), 8000, '開き直したポップアップ');
  await waitFor(async () => (await segSel(fresh2)) === 'よく使う', 5000, '保存したタグ');
  ok(true, '開き直しても、前に選んだタグ（よく使う）が出る');
  await fresh2.eval(`document.querySelector('#seg-abc').click()`);
  await waitFor(() => fresh2.eval(`[...document.querySelectorAll('#list li')].map((li) => li.querySelector('.name').textContent).join('|') === '仕事|localhost'`), 5000, 'ABC（フォルダが上）');
  ok(true, '「ABC」では、フォルダ（仕事）がログイン（localhost）の上に並ぶ');
  await fresh2.eval(`[...document.querySelectorAll('#list li.folder')].find((li) => li.querySelector('.name').textContent === '仕事').click()`);
  await waitFor(() => fresh2.eval(`[...document.querySelectorAll('#list li')].map((li) => li.querySelector('.name').textContent).join('|') === '上のフォルダへ|EC|Work-top'`), 5000, 'サブフォルダの表示');
  ok(true, 'フォルダの中でも、サブフォルダ（EC）がログイン（Work-top）の上に並ぶ');
  // 検索欄に入力したら、どちらのタグでも全フォルダから探した一覧
  await fresh2.type('#q', 'Work');
  await waitFor(() => fresh2.eval(`[...document.querySelectorAll('#list li .name')].map((n) => n.textContent).join('|') === 'Work-top'`), 5000, 'ABC での検索');
  await fresh2.eval(`document.querySelector('#seg-frequent').click()`);
  await waitFor(() => fresh2.eval(`[...document.querySelectorAll('#list li .name')].map((n) => n.textContent).join('|') === 'Work-top'`), 5000, 'よく使う での検索');
  ok(true, '検索すると、どちらのタグでも、同じ（全フォルダから探した）一覧になる');
  await closeTab(fresh2);
  await fresh.type('#q', 'Work');
  await waitFor(async () => !(await listNames()).startsWith('上のフォルダへ'), 5000, '検索中の表示');
  ok(!(await listNames()).includes('仕事('), '検索中は、フォルダの一覧にならない');
  fresh.close();

  // ホーム（ポップアップの「ホーム」から開くタブ）
  const start = await openTab(`chrome-extension://${EXT_ID}/start.html`);
  await sleep(1500);
  await start.screenshot(path.join(shots, 'start-page.png'));
  const startMsg = await start.eval(`(() => { const m = document.querySelector('#msg'); return m.classList.contains('hidden') ? '' : m.textContent; })()`);
  ok(startMsg === '', `ホームがアプリに接続できている（${startMsg || 'メッセージなし'}）`);
  ok((await start.eval(`document.querySelectorAll('#grid .tile').length`)) >= 1, 'ホームにログインのタイルが並ぶ');

  // 件数が多い保管庫: 120 件を超えるログインが、すべてホームに出る（見出しで分け、件数も出す）。作ったログインは、あとで消す
  const bulkIds = [];
  for (let i = 0; i < 640; i++) {
    const r = await pipe.ok('saveItem', { mode: 'new', item: { type: 1, name: `Bulk-${String(i).padStart(4, '0')}`, folder: '/', url: `https://bulk${i}.example.com`, fields: [{ name: 'u', value: 'u', kind: 'text', role: 'user' }, { name: 'p', value: 'p', kind: 'password', role: 'password' }] } });
    bulkIds.push(r.id);
  }
  const allLogins = async () => { const out = []; for (;;) { const part = await pipe.ok('search', { q: '', types: [1], limit: 500, offset: out.length }); out.push(...part); if (part.length < 500) return out; } };
  const total = (await allLogins()).length;
  ok(total > 600, `テスト用に 600 件を超えるログインを用意した（合計 ${total} 件）`);
  await start.eval(`load()`);
  await waitFor(() => start.eval(`document.querySelectorAll('#grid .tile').length === ${total}`), 20000, 'ホームの全タイル');
  ok(true, `120 件を超えても、ログインがすべてホームに出る（${total} 件）`);
  ok((await start.eval(`document.querySelector('#count').textContent`)).includes(String(total)), 'ホームに件数が出る');
  ok((await start.eval(`[...document.querySelectorAll('#grid h2.sec')].map((h) => h.textContent).join('|')`)).includes('すべてのログイン'), '「すべてのログイン」の見出しで分かれる');
  ok((await start.eval(`new Set([...document.querySelectorAll('#grid .tile b')].map((b) => b.textContent)).size`)) === total, '同じものが重複して出ない');
  // 絞り込み: 検索語に合うものだけが、件数つきで出る
  await start.eval(`document.querySelector('#q').value = 'Bulk-063'; document.querySelector('#q').dispatchEvent(new Event('input'))`);
  await waitFor(() => start.eval(`document.querySelectorAll('#grid .tile').length === 10`), 8000, '検索の絞り込み');
  ok((await start.eval(`document.querySelector('#grid h2.sec').textContent`)).includes('10'), '検索すると、一致する件数が見出しに出る');
  await start.eval(`document.querySelector('#q').value = ''; document.querySelector('#q').dispatchEvent(new Event('input'))`);
  for (const id of bulkIds) await pipe.ok('deleteItem', { id }); // 後片付け（ゴミ箱へ）
  await start.eval(`load()`);
  await waitFor(() => start.eval(`document.querySelectorAll('#grid .tile').length === ${total - bulkIds.length}`), 20000, '後片付け後のタイル');
  start.close();

  // ---- 歯車メニュー・バージョン情報・生成器の画面（見出しの右の ⚙）
  ok((await popup.eval(`document.querySelector('header .brand span').textContent`)) === 'TKRForm', 'ポップアップの見出しは「TKRForm」');
  ok((await popup.eval(`document.querySelector('#menu-btn').getAttribute('aria-label')`)) === 'メニュー', '見出しの右に歯車のボタン（名前は「メニュー」）がある');
  ok((await popup.eval(`!document.querySelector('footer') && ![...document.querySelectorAll('#tabs button')].some((b) => b.textContent === '生成器')`)), 'フッターと「生成器」タブはない');
  const menuLabels = () => popup.eval(`[...document.querySelectorAll('#menu button')].map((b) => b.textContent).join('|')`);
  await popup.eval(`document.querySelector('#menu-btn').click()`);
  ok((await menuLabels()) === 'ホーム|パスワード生成|設定|編集|ロック|バージョン情報', `歯車のメニュー: ホーム | パスワード生成 | 設定 | 編集 | ロック | バージョン情報（${await menuLabels()}）`);
  ok(await popup.eval(`document.activeElement.textContent === 'ホーム' && document.querySelector('#menu-btn').getAttribute('aria-expanded') === 'true'`), 'メニューを開くと、先頭の項目にフォーカスが移る');
  await popup.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  ok(await popup.eval(`document.activeElement.textContent === 'パスワード生成'`), '↓ キーで次の項目へ移る');
  await popup.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  ok(await popup.eval(`document.querySelector('#menu').classList.contains('hidden')`), 'Esc でメニューが閉じる');
  await popup.eval(`document.querySelector('#menu-btn').click()`);
  await popup.eval(`document.body.click()`);
  ok(await popup.eval(`document.querySelector('#menu').classList.contains('hidden')`), 'メニューの外をクリックすると閉じる');
  // パスワード生成: ポップアップの中に生成器の画面が出る。「← 戻る」で一覧に戻る
  await popup.eval(`document.querySelector('#menu-btn').click(); document.querySelector('#menu-gen').click()`);
  await waitFor(() => popup.eval(`!document.querySelector('#gen-view').classList.contains('hidden') && document.querySelectorAll('#gen input').length > 0`), 5000, '生成器の画面');
  ok(await popup.eval(`document.querySelector('#list-wrap').classList.contains('hidden') && document.querySelector('#tabs').classList.contains('hidden')`), '「パスワード生成」で、一覧とタブが隠れ、生成器の画面が出る');
  await popup.eval(`document.querySelector('#gen-back').click()`);
  await waitFor(() => popup.eval(`document.querySelector('#gen-view').classList.contains('hidden') && !document.querySelector('#list-wrap').classList.contains('hidden')`), 5000, '一覧へ戻る');
  ok(true, '「← 戻る」で、元の一覧に戻る');
  // バージョン情報
  await popup.eval(`document.querySelector('#menu-btn').click(); document.querySelector('#menu-about').click()`);
  const about = await popup.eval(`document.querySelector('#about').classList.contains('hidden') ? '' : document.querySelector('#about').innerText`);
  ok(about.includes('TKRForm') && /バージョン \d+\.\d+\.\d+/.test(about) && about.includes('(c) タカラシスコム') && about.includes('https://tkrs.jp/'), `バージョン情報: TKRForm・バージョン・(c) タカラシスコム・https://tkrs.jp/（${about.replace(/\n/g, ' / ')}）`);
  const tabsBefore = (await chromeTargets()).filter((t) => t.url.startsWith('https://tkrs.jp')).length;
  await popup.eval(`document.querySelector('#about-link').click()`);
  const tkrsTab = await waitFor(async () => (await chromeTargets()).find((t) => t.type === 'page' && t.url.startsWith('https://tkrs.jp')), 8000, 'リンク先のタブ').catch(() => null);
  ok(!!tkrsTab || tabsBefore > 0, 'リンクをクリックすると、新しいタブで https://tkrs.jp/ を開く');
  if (tkrsTab) await fetch(`http://127.0.0.1:${CHROME_PORT}/json/close/${tkrsTab.id}`).catch(() => {});
  await popup.eval(`document.querySelector('#about-close').click()`);
  ok(await popup.eval(`document.querySelector('#about').classList.contains('hidden')`), '「閉じる」でバージョン情報が閉じる');

  // （記入は使用回数を増やすので、「よく使う」の確認が終わったあとに行う）
  // 「ログイン」タブの ✎ は「記入（一致する候補）」: 今開いているページに記入し、一致しないページには記入しない
  const locRow = (await pipe.ok('search', { q: 'localhost', types: [1], limit: 5 }))[0];
  ok((await popup.eval(`[...document.querySelectorAll('#list li .actions')].find((a) => a.querySelectorAll('button').length >= 2).querySelectorAll('button')[1].title`)) === '記入（一致する候補）', '「ログイン」タブの ✎ の名前は「記入（一致する候補）」');
  const hereOk = await openTab(`${BASE}/login.html`);
  await waitFor(() => hereOk.eval(`document.readyState === 'complete'`));
  await sleep(600);
  const rFill = await swc.eval(`bg({ t: 'fillTab', id: ${JSON.stringify(locRow.id)}, submit: false }).catch((e) => ({ err: JSON.stringify(e) }))`);
  ok(rFill && rFill.filled === true, `✎ で、今のページ（保存した URL と一致）に記入できる（${JSON.stringify(rFill)}）`);
  ok((await hereOk.eval(`document.querySelector('#email').value`)) === 'octocat@example.com' && (await hereOk.eval(`location.pathname`)) === '/login.html', '記入だけで、送信はしない');
  await closeTab(hereOk);
  const hereNg = await openTab(`http://127.0.0.1:${WEB_PORT}/login.html`);
  await waitFor(() => hereNg.eval(`document.readyState === 'complete'`));
  await sleep(600);
  const rNg = await swc.eval(`bg({ t: 'fillTab', id: ${JSON.stringify(locRow.id)}, submit: false }).catch((e) => ({ err: JSON.stringify(e) }))`);
  ok(rNg && rNg.filled === false && rNg.code === 'URL_MISMATCH', `一致しないページ（別のドメイン）には、記入しない（${JSON.stringify(rNg)}）`);
  ok((await hereNg.eval(`document.querySelector('#email').value`)) === '', '一致しないページの欄は、空のまま');
  await closeTab(hereNg);
  // ポップアップの表示: 「このページは ○○ と一致しません」と「開いて記入」
  await popup.eval(`showMismatch({ id: ${JSON.stringify(locRow.id)}, url: 'https://bank.example.jp/login' })`);
  ok((await popup.eval(`document.querySelector('#mismatch').textContent`)).includes('bank.example.jp と一致しません'), '一致しないときは、ポップアップに「このページは (保存した URL のホスト) と一致しません」が出る');
  ok((await popup.eval(`[...document.querySelectorAll('#mismatch button')].map((b) => b.textContent).join()`)) === '開いて記入', '「開いて記入」のボタンが出る');
  await popup.eval(`loadList()`);
  // ポップアップでは右クリックメニューを出さない（入力欄を除く）
  const ctx = (sel) => popup.eval(`(() => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); document.querySelector(${JSON.stringify(sel)}).dispatchEvent(e); return e.defaultPrevented; })()`);
  ok((await ctx('#list li')) === true, 'ポップアップの一覧では、右クリックメニューを出さない');
  ok((await ctx('#q')) === false, '検索欄では、右クリックメニュー（コピー・貼り付け）を出す');
  popup.close();

  // 歯車メニューの「ホーム」「設定」「編集」: ポップアップは、操作のあと自分で閉じる（window.close）。それぞれ新しいポップアップで確認する
  const within = (pr, ms, what) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error(`タイムアウト: ${what}（${ms / 1000} 秒）`)), ms))]);
  const freshPopup = async () => {
    const pg = await openTab(`chrome-extension://${EXT_ID}/popup.html`);
    await waitFor(() => pg.eval(`!document.querySelector('#v-main').classList.contains('hidden') && !!document.querySelector('#menu-btn')`), 8000, '歯車メニュー用のポップアップ');
    return pg;
  };
  const menuClick = async (id) => {
    const pg = await freshPopup();
    await within(pg.eval(`document.querySelector('#menu-btn').click(); document.querySelector('#menu-${id}').click()`), 8000, `メニュー「${id}」の操作`).catch(() => {});
    return pg;
  };
  const closeOther = async (pred) => { for (const t of await chromeTargets()) if (t.type === 'page' && pred(t)) await fetch(`http://127.0.0.1:${CHROME_PORT}/json/close/${t.id}`).catch(() => {}); };
  let pg = await menuClick('home');
  const homeTab = await waitFor(async () => (await chromeTargets()).find((t) => t.type === 'page' && t.url.includes(`${EXT_ID}/start.html`)), 8000, 'ホームのタブ').catch(() => null);
  ok(!!homeTab, '「ホーム」で、ホームのページが開く');
  pg.close(); await closeOther((t) => t.url.includes(`${EXT_ID}/start.html`) && t.id !== swc.targetId); // swc（橋渡しに使っている start.html のタブ）は閉じない
  pg = await menuClick('options');
  const optTab = await waitFor(async () => (await chromeTargets()).find((t) => t.type === 'page' && t.url.includes(`${EXT_ID}/options.html`)), 8000, '設定のタブ').catch(() => null);
  ok(!!optTab, '「設定」で、拡張の設定ページが開く');
  pg.close(); await closeOther((t) => t.url.includes(`${EXT_ID}/options.html`));
  pg = await menuClick('edit');
  const edTarget = await waitTarget(APP_PORT, (x) => x.url.includes('editor.html'), 10000).catch(() => null);
  ok(!!edTarget, '「編集」で、デスクトップのエディタが開く');
  pg.close(); await closeOther((t) => t.url.includes(`${EXT_ID}/popup.html`));

  // 自動記入（ショートカット相当: fillBest）。これまでに開いた login.html のタブ（close() は接続を閉じるだけで、タブは残る）を閉じてから、新しく開く
  await closeOther((t) => t.url.startsWith(`${BASE}/login.html`));
  login = await openTab(`${BASE}/login.html`);
  await waitFor(() => login.eval(`document.readyState === 'complete'`));
  await sleep(800);
  await within(swc.eval(`(async () => { const [tab] = await chrome.tabs.query({ url: '${BASE}/login.html' }); await chrome.tabs.sendMessage(tab.id, { t: 'cmd', name: 'fillBest' }); })()`), 15000, 'fillBest の送信').catch((e) => console.log('fillBest:', e.message));
  await waitFor(() => login.eval(`document.querySelector('#pw').value !== ''`), 8000, '自動記入');
  ok((await pipe.ok('getItem', { id: saved.id })).useCount >= 1, 'ショートカット相当（fillBest）での記入で使用回数が増える');
  ok((await login.eval(`document.querySelector('#email').value`)) === 'octocat@example.com' && (await login.eval(`document.querySelector('#pw').value`)) === 'first-Password-123', '解除後に自動記入できる（ID とパスワード）');
  await login.screenshot(path.join(shots, 'login-filled.png'));
  login.close();

  // ------------------------------------------------------ インラインメニュー（フォーカスで候補が出て、クリックで記入）
  login = await openTab(`${BASE}/login.html`);
  await waitFor(() => login.eval(`document.readyState === 'complete'`));
  await sleep(800);
  await login.click('#email');
  await sleep(1200);
  await login.screenshot(path.join(shots, 'inline-menu.png'));
  // メニュー（closed Shadow DOM）の最初の行は入力欄の少し下
  const rowBox = await pierceBox(login, 'row');
  const pos = { x: (rowBox.left + rowBox.right) / 2, y: (rowBox.top + rowBox.bottom) / 2 };
  await login.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await login.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await waitFor(() => login.eval(`document.querySelector('#pw').value !== ''`), 5000, 'インラインメニューからの記入');
  ok(true, 'インラインメニューの候補をクリックして記入できる');
  login.close();

  // ------------------------------------------------------ インラインメニューの見出しの帯: ドラッグで移動・× で閉じる・閉じた欄は自動で開かない
  {
    login = await openTab(`${BASE}/login.html`);
    await waitFor(() => login.eval(`document.readyState === 'complete'`));
    await sleep(800);
    const fieldBox = (sel) => login.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
    const center = (b) => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });
    const mouse = async (type, x, y, extra = {}) => login.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
    const clickAt = async (b) => { const c = center(b); await mouse('mouseMoved', c.x, c.y); await mouse('mousePressed', c.x, c.y); await mouse('mouseReleased', c.x, c.y); };
    const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    await login.click('#email');
    await waitFor(() => pierceBox(login, 'menu'), 8000, 'インラインメニュー');
    await sleep(500);
    let menu = await pierceBox(login, 'menu');
    let bar = await pierceBox(login, 'bar');
    const xb = await pierceBox(login, 'x');
    const email = await fieldBox('#email');
    ok(!!bar && !!xb && bar.bottom - bar.top > 20 && bar.bottom - bar.top < 40, 'インラインメニューの上部に、細い見出しの帯と × ボタンがある');
    ok(!overlap(menu, email), '自動の位置でも、入力中の欄そのものは覆わない');
    ok(!!(await pierceBox(login, 'row')), '帯を付けても、候補の行が並ぶ');
    // ドラッグで動かす
    const bc = center(bar);
    await mouse('mouseMoved', bc.x - 30, bc.y);
    await mouse('mousePressed', bc.x - 30, bc.y);
    for (let i = 1; i <= 5; i++) await mouse('mouseMoved', bc.x - 30 + i * 20, bc.y + i * 10, { buttons: 1 });
    await mouse('mouseReleased', bc.x + 70, bc.y + 50);
    await sleep(400);
    const moved = await pierceBox(login, 'menu');
    ok(Math.abs(moved.left - (menu.left + 100)) < 3 && Math.abs(moved.top - (menu.top + 50)) < 3, `帯をつかんでドラッグすると、メニューが動く（${Math.round(menu.left)},${Math.round(menu.top)} → ${Math.round(moved.left)},${Math.round(moved.top)}）`);
    await sleep(500);
    const still = await pierceBox(login, 'menu');
    ok(Math.abs(still.left - moved.left) < 1 && Math.abs(still.top - moved.top) < 1, '動かしたあとは、自動の位置合わせでもとの位置に戻らない');
    // × で閉じる → 同じ欄では、フォーカスしても自動で開かない
    await clickAt(await pierceBox(login, 'x'));
    await waitFor(async () => !(await pierceBox(login, 'menu')), 5000, '× で閉じる');
    ok(true, '× ボタンで、メニューが閉じる');
    await login.eval(`document.querySelector('#email').blur()`);
    await sleep(300);
    await login.click('#email');
    await sleep(1500);
    ok(!(await pierceBox(login, 'menu')), '× で閉じた欄は、フォーカスしても自動では開かない');
    // ほかの欄では、今までどおり自動で開く
    await login.click('#pw');
    await waitFor(() => pierceBox(login, 'menu'), 8000, 'ほかの欄でメニュー');
    ok(true, 'ほかの欄では、今までどおり自動で開く');
    await login.press('Escape', 'Escape', 27);
    await waitFor(async () => !(await pierceBox(login, 'menu')), 5000, 'Esc で閉じる');
    ok(true, 'Esc で閉じる動作も残っている');
    // 欄の右端のアイコンで開き直せる。ドラッグした位置ではなく、自動の位置から始まる
    await login.eval(`document.querySelector('#email').blur()`);
    await sleep(300);
    await login.click('#email');
    await sleep(500);
    await clickAt({ left: email.right - 24, right: email.right - 4, top: email.top, bottom: email.bottom });
    await waitFor(() => pierceBox(login, 'menu'), 8000, 'アイコンで開き直す');
    await sleep(500);
    menu = await pierceBox(login, 'menu');
    ok(Math.abs(menu.top - (email.bottom + 4)) < 4 && Math.abs(menu.left - moved.left) > 20, `アイコンで開き直せる（自動の位置から始まる: ${Math.round(menu.left)},${Math.round(menu.top)}）`);
    // キーボード: Shift+Tab で × に届き、Enter で閉じる
    const key = async (type, extra) => login.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, ...extra });
    await key('keyDown', { modifiers: 8 });
    await key('keyUp', { modifiers: 8 });
    await sleep(200);
    await login.press('Enter', 'Enter', 13); // keyDown + 文字つきで送る（rawKeyDown だと Enter の文字入力が起きず、ボタンが押されない）
    await waitFor(async () => !(await pierceBox(login, 'menu')), 5000, 'キーボードで × を押す');
    ok(true, '× ボタンにも Tab（Shift+Tab）で届き、Enter で閉じられる');
    await closeTab(login);
  }

  // ------------------------------------------------------ 自動で開いたメニューが入力を妨げない
  login = await openTab(`${BASE}/login.html`);
  await waitFor(() => login.eval(`document.readyState === 'complete'`));
  await sleep(800);
  await login.click('#pw');
  await sleep(1200); // メニューが開き終わるのを待ってから入力する（人の操作と同じ順）
  ok(await login.eval(`document.activeElement === document.querySelector('#pw')`), 'メニューが自動で開いてもパスワード欄にフォーカスが残る');
  await login.send('Input.insertText', { text: 'typed-by-user' });
  ok((await login.eval(`document.querySelector('#pw').value`)) === 'typed-by-user', 'メニューが開いた状態でパスワード欄に入力できる');
  login.close();

  // ------------------------------------------------------ パスワード変更 → 「更新」の提案
  const change = await openTab(`${BASE}/change.html`);
  await waitFor(() => change.eval(`document.readyState === 'complete'`));
  await sleep(800);
  await change.type('#old', 'first-Password-123');
  await change.type('#new1', 'second-Password-456');
  await change.type('#new2', 'second-Password-456');
  await change.click('#go');
  const upd = await waitFor(async () => (await chromeTargets()).find((t) => t.url.includes(`${EXT_ID}/save.html`)), 15000, '更新ダイアログ');
  const uf = await Cdp.connect(upd.webSocketDebuggerUrl);
  await waitFor(() => uf.eval(`!document.querySelector('#form').classList.contains('hidden')`), 8000);
  const title = await uf.eval(`document.querySelector('#title').textContent`);
  const btn = await uf.eval(`document.querySelector('#save').textContent`);
  ok(title.includes('更新') && btn === '更新', `パスワード変更時に「更新」が提案される（${title} / ${btn}）`);
  await clickSave(uf);
  await waitFor(async () => (await pipe.ok('getItem', { id: saved.id })).fields.find((f) => f.role === 'password').value === 'second-Password-456', 8000, '更新の反映');
  const after = await pipe.ok('getItem', { id: saved.id });
  ok(after.passwordHistory.length === 1 && after.passwordHistory[0].value === 'first-Password-123', '更新後、古いパスワードが履歴に残る');
  uf.close(); change.close();

  // ------------------------------------------------------ プロフィール（3 欄以上に記入）
  const idt = await pipe.ok('saveItem', { mode: 'new', item: { type: 5, name: '自宅', country: 'JP',
    groups: [{ group: 'Person', instances: [{ name: '既定', fields: { LastName: '山田', FirstName: '太郎', Email: 'taro@example.jp' } }] },
      { group: 'Address', instances: [{ name: '既定', fields: { ZipOrPostCode: '100-0001', City: '千代田区' } }] }] } });
  const addr = await openTab(`${BASE}/address.html`);
  await waitFor(() => addr.eval(`document.readyState === 'complete'`));
  await sleep(800);
  await swc.eval(`(async () => { const [tab] = await chrome.tabs.query({ url: '${BASE}/address.html' }); await chrome.tabs.sendMessage(tab.id, { t: 'cmd', name: 'fillIdentityById', id: '${idt.id}' }); })()`);
  await waitFor(() => addr.eval(`document.querySelector('#ln').value !== ''`), 8000, 'プロフィールの記入');
  const vals = await addr.eval(`['#ln', '#fn', '#mail', '#zip', '#city'].map((s) => document.querySelector(s).value)`);
  ok(vals.filter(Boolean).length >= 3, `プロフィールで 3 欄以上に記入できる（${vals.join(' | ')}）`);
  await addr.screenshot(path.join(shots, 'identity-filled.png'));
  addr.close();

  // ------------------------------------------------------ ベーシック認証
  await pipe.ok('saveItem', { mode: 'new', item: { type: 1, name: 'basic', url: `${BASE}/auth`, basicAuth: true,
    fields: [{ name: 'u', value: 'bob', kind: 'text', role: 'user' }, { name: 'p', value: 'bob-pass', kind: 'password', role: 'password' }] } });
  const basic = await openTab(`${BASE}/auth`);
  await waitFor(() => basic.eval(`!!document.getElementById('ok')`), 15000, 'ベーシック認証の通過');
  ok(true, 'ベーシック認証のダイアログに自動で資格情報が入る');
  const basicId = (await pipe.ok('search', { q: 'basic', types: [1], limit: 5 })).find((e) => e.name === 'basic').id;
  ok((await pipe.ok('getItem', { id: basicId })).useCount >= 1, 'ベーシック認証で使ったログインの使用回数が増える');
  // 「ベーシック認証用」の印がないログイン（他の製品から取り込んだもの）でも、ID とパスワードがあれば使う
  await pipe.ok('saveItem', { mode: 'new', item: { type: 1, name: 'ip-basic', url: `http://127.0.0.1:${WEB_PORT}/auth`,
    fields: [{ name: 'u', value: 'bob', kind: 'text', role: 'user' }, { name: 'p', value: 'bob-pass', kind: 'password', role: 'password' }] } });
  const basic2 = await openTab(`http://127.0.0.1:${WEB_PORT}/auth`);
  await waitFor(() => basic2.eval(`!!document.getElementById('ok')`), 15000, '印のないログインでのベーシック認証');
  ok(true, '「ベーシック認証用」の印がない取り込みログインでも、ベーシック認証に資格情報が入る');
  basic.close();

  // ------------------------------------------------------ TOTP（インラインメニューから記入）
  await pipe.ok('saveItem', { mode: 'update', item: { id: saved.id, totpKey: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } });
  const otp = await openTab(`${BASE}/otp.html`);
  await waitFor(() => otp.eval(`document.readyState === 'complete'`));
  await sleep(800);
  await otp.click('#otp');
  await sleep(1500);
  await otp.screenshot(path.join(shots, 'otp-menu.png'));
  const opRow = await waitFor(() => pierceBox(otp, 'row'), 8000, 'TOTP の候補'); // 見出しの帯の分だけ下がるため、実際の行の位置を押す
  const op = { x: (opRow.left + opRow.right) / 2, y: (opRow.top + opRow.bottom) / 2 };
  await otp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: op.x, y: op.y, button: 'left', clickCount: 1 });
  await otp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: op.x, y: op.y, button: 'left', clickCount: 1 });
  await waitFor(() => otp.eval(`/^\\d{6}$/.test(document.querySelector('#otp').value)`), 5000, 'TOTP の記入');
  ok(true, 'TOTP のコードを欄に記入できる');
  otp.close();

  // ------------------------------------------------------ ロリポップ型のフォーム: ユーザー ID の判定・すべての欄の保存と記入・「新しいログインとして保存」
  const closeDialogs = async () => { await waitFor(async () => !(await chromeTargets()).some((t) => t.url.includes(`${EXT_ID}/save.html`)), 8000, '保存ダイアログが閉じる').catch(() => {}); };
  const openSaveDialog = async () => {
    const fr = await waitFor(async () => (await chromeTargets()).find((t) => t.url.includes(`${EXT_ID}/save.html`)), 15000, '保存ダイアログ');
    const d = await Cdp.connect(fr.webSocketDebuggerUrl);
    await waitFor(() => d.eval(`!document.querySelector('#form').classList.contains('hidden')`), 8000, '保存フォーム');
    await sleep(300);
    return d;
  };
  const lpItems = [];
  const lpPage = async () => { const pg = await openTab(`${BASE}/lolipop.html`); await waitFor(() => pg.eval(`document.readyState === 'complete'`)); await sleep(800); return pg; };
  // 1. 独自ドメインを選び、アカウントとパスワードを入れて送信 → 保存ダイアログ
  let lp = await lpPage();
  await lp.eval(`document.querySelector('#dt2').click()`);
  await sleep(300);
  await lp.type('#domain_name_own', 'mydomain.example');
  await lp.type('#account', 'matuken');
  await lp.type('#passwd', 'Lolipop-Pass-1');
  await lp.click('#go');
  let dlg = await openSaveDialog();
  const who = await dlg.eval(`document.querySelector('#who').textContent`);
  ok(who.startsWith('matuken @') && !/co\.jp|ne\.jp|mydomain/.test(who.split('@')[0]), `保存ダイアログのユーザー ID は、ドメインの欄ではなく、アカウントの欄になる（${who}）`);
  await clickSave(dlg);
  await waitFor(async () => (await pipe.ok('search', { q: 'matuken', types: [1], limit: 5 })).length === 1, 8000, 'ロリポップ型の保存');
  const lpSaved = (await pipe.ok('search', { q: 'matuken', types: [1], limit: 5 }))[0];
  lpItems.push(lpSaved.id);
  let lpFull = await pipe.ok('getItem', { id: lpSaved.id });
  const fv = (name) => (lpFull.fields.find((f) => f.name === name) || {});
  ok(fv('account').role === 'user' && fv('account').value === 'matuken' && fv('passwd').role === 'password' && fv('passwd').value === 'Lolipop-Pass-1', 'ユーザー ID（アカウント）とパスワードが、役割つきで保存される');
  ok(fv('domain_type').kind === 'radio' && fv('domain_type').value === 'original' && fv('domain_name_own').value === 'mydomain.example', 'ラジオ（選ばれているもの）と、表示されていたドメイン欄が保存される');
  ok(!lpFull.fields.some((f) => f.name === 'domain_name_3'), '表示されていない欄（セレクト）は保存しない');
  ok(lpFull.fields.map((f) => f.name).join(',') === 'domain_type,domain_name_own,account,passwd', `保存した欄の順は画面の順（${lpFull.fields.map((f) => f.name).join(',')}）`);
  await closeDialogs(); await closeTab(lp);
  // 2. 開き直して記入 → ラジオを選んで欄が現れるのを待ち、すべて元どおりに入る
  lp = await lpPage();
  const rFill2 = await swc.eval(`bg({ t: 'fillTab', id: ${JSON.stringify(lpSaved.id)}, submit: false }).catch((e) => ({ err: JSON.stringify(e) }))`);
  ok(rFill2 && rFill2.filled === true, `記入できる（${JSON.stringify(rFill2)}）`);
  const got = await lp.eval(`JSON.stringify({ dt2: document.querySelector('#dt2').checked, own: document.querySelector('#domain_name_own').value, account: document.querySelector('#account').value, pw: document.querySelector('#passwd').value, ownVisible: getComputedStyle(document.querySelector('#own')).display !== 'none' })`);
  ok(got === JSON.stringify({ dt2: true, own: 'mydomain.example', account: 'matuken', pw: 'Lolipop-Pass-1', ownVisible: true }), `すべての欄（ラジオ・表示が切り替わる欄・アカウント・パスワード）が元どおりに入る（${got}）`);
  await closeTab(lp);
  // 3. セレクトも保存される: ロリポップのドメイン（セレクト）を選んで、パスワードを変えて送信 → 「更新」
  lp = await lpPage();
  await lp.eval(`document.querySelector('#dt1').click(); const s = document.querySelector('#domain_name_3'); s.value = 'ne.jp'; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await lp.type('#account', 'matuken');
  await lp.type('#passwd', 'Lolipop-Pass-2');
  await lp.click('#go');
  dlg = await openSaveDialog();
  ok((await dlg.eval(`document.querySelector('#title').textContent`)).includes('更新') && !(await dlg.eval(`document.querySelector('#as-new-row').classList.contains('hidden')`)), '同じアカウントでパスワードが違うので、「更新」の提案と「新しいログインとして保存する」が出る');
  const upName = await dlg.eval(`document.querySelector('#name').value`);
  ok((await dlg.eval(`document.querySelector('#name').disabled`)) === true && (await dlg.eval(`document.querySelector('#save').textContent`)) === '更新', '更新では、名前は既存のまま（変えられない）で、ボタンは「更新」');
  // 「新しいログインとして保存」にチェック → 名前が新規入力用に切り替わる
  await dlg.eval(`document.querySelector('#as-new').click()`);
  const nm = await dlg.eval(`(() => { const n = document.querySelector('#name'); return JSON.stringify({ v: n.value, disabled: n.disabled, focused: document.activeElement === n, sel: n.selectionStart === 0 && n.selectionEnd === n.value.length, btn: document.querySelector('#save').textContent }); })()`);
  const nmo = JSON.parse(nm);
  ok(!nmo.disabled && nmo.focused && nmo.sel && nmo.btn === '保存' && /^localhost \(\d+\)$/.test(nmo.v) && nmo.v !== upName, `チェックを入れると、名前が新規入力用になる（サイトのドメインに「(2)」などを付けて重複を避け、全体を選択してフォーカス）。ボタンは「保存」（${nm}）`);
  // 検証: 空・同じフォルダで重複
  await dlg.eval(`(() => { const n = document.querySelector('#name'); n.value = ''; })()`);
  await clickSave(dlg);
  ok((await dlg.eval(`document.querySelector('#err').textContent`)).includes('名前を入力'), '名前が空のときは保存できず、エラーを出す');
  await dlg.eval(`document.querySelector('#name').value = ${JSON.stringify(upName)}`);
  await clickSave(dlg);
  ok((await dlg.eval(`document.querySelector('#err').textContent`)).includes('同じ名前'), '同じフォルダに同じ名前があるときは保存できず、エラーを出す');
  // チェックを外す → 既存の名前に戻り、ボタンは「更新」
  await dlg.eval(`document.querySelector('#as-new').click()`);
  ok((await dlg.eval(`document.querySelector('#name').value`)) === upName && (await dlg.eval(`document.querySelector('#save').textContent`)) === '更新' && (await dlg.eval(`document.querySelector('#name').disabled`)), 'チェックを外すと、既存の名前に戻り、ボタンは「更新」に戻る');
  await clickSave(dlg); // 更新
  await waitFor(async () => (await pipe.ok('getItem', { id: lpSaved.id })).fields.find((f) => f.name === 'passwd').value === 'Lolipop-Pass-2', 8000, '更新の反映');
  lpFull = await pipe.ok('getItem', { id: lpSaved.id });
  ok(fv('domain_name_3').kind === 'select' && fv('domain_name_3').value === 'ne.jp' && fv('domain_type').value === 'lolipop', '更新では、ID とパスワード以外の欄（セレクト・ラジオ）も新しい値で更新される');
  ok(fv('domain_name_own').value === 'mydomain.example' && lpFull.fields.filter((f) => f.name === 'domain_type').length === 1, '取り込まれなかった既存の欄は残り、ラジオは重複しない');
  ok((lpFull.passwordHistory || []).some((h) => h.value === 'Lolipop-Pass-1'), 'パスワードの履歴は、今までどおり残る');
  await closeDialogs(); await closeTab(lp);
  // 4. 「新しいログインとして保存」: 入力した名前で、新しいログインができる
  lp = await lpPage();
  await lp.type('#account', 'matuken');
  await lp.type('#passwd', 'Lolipop-Pass-3');
  await lp.click('#go');
  dlg = await openSaveDialog();
  await dlg.eval(`document.querySelector('#as-new').click()`);
  await dlg.eval(`document.querySelector('#name').value = 'Lolipop Second'`);
  await clickSave(dlg);
  await waitFor(async () => (await pipe.ok('search', { q: 'Lolipop Second', types: [1], limit: 5 })).length === 1, 8000, '新しいログイン');
  const second = (await pipe.ok('search', { q: 'Lolipop Second', types: [1], limit: 5 }))[0];
  lpItems.push(second.id);
  const secFull = await pipe.ok('getItem', { id: second.id });
  ok(second.id !== lpSaved.id && secFull.fields.find((f) => f.role === 'password').value === 'Lolipop-Pass-3' && (await pipe.ok('getItem', { id: lpSaved.id })).fields.find((f) => f.role === 'password').value === 'Lolipop-Pass-2', '「新しいログインとして保存」で、入力した名前の新しいログインができ、既存のログインはそのまま');
  await closeDialogs(); await closeTab(lp);
  for (const id of lpItems) await pipe.ok('deleteItem', { id }); // 後片付け（ゴミ箱へ）

  // ------------------------------------------------------ ページ上のパスワード生成パネル: 位置（入力欄に重ならない）・追従・ドラッグ・「使う」
  {
    // closed Shadow DOM の中の要素の位置は、CDP の DOM.getDocument（pierce）で調べる
    const shadowBox = async (pg, cls) => {
      const { root } = await pg.send('DOM.getDocument', { depth: -1, pierce: true });
      const find = (n, want = cls) => {
        if (n.nodeName === 'DIV' || n.nodeName === 'BUTTON') { const a = n.attributes || []; const i = a.indexOf('class'); if (i >= 0 && a[i + 1] === want) return n; }
        for (const c of [...(n.children || []), ...(n.shadowRoots || []), ...(n.contentDocument ? [n.contentDocument] : [])]) { const r = find(c, want); if (r) return r; }
        return null;
      };
      const panelNode = cls === 'p' ? root : find(root, 'p');
      const n = panelNode ? find(panelNode) : null;
      if (!n) return null;
      const { model } = await pg.send('DOM.getBoxModel', { backendNodeId: n.backendNodeId });
      const q = model.border;
      return { left: q[0], top: q[1], right: q[4], bottom: q[5] };
    };
    const elBox = (pg, sel) => pg.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
    const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const genOpen = async (pg, url) => {
      await pg.eval(`document.querySelector('#pw1').focus()`);
      await swc.eval(`(async () => { const [tab] = await chrome.tabs.query({ url: '${url}' }); await chrome.tabs.sendMessage(tab.id, { t: 'cmd', name: 'generate' }); })()`);
      await waitFor(() => shadowBox(pg, 'p'), 8000, '生成パネル');
      await sleep(300);
    };
    const IDS = ['#user', '#pw1', '#pw2'];

    // 1. 登録フォーム（パスワード欄が縦に 2 つ）: いちばん下の欄の下に出て、どの欄にも重ならない。左端は対象の欄にそろう
    let sg = await openTab(`${BASE}/signup.html`);
    await sg.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false }); // 画面が低いと、パネル（高さ 360）が収まらないため、広さを決める
    await waitFor(() => sg.eval(`document.readyState === 'complete'`));
    await sleep(800);
    await genOpen(sg, `${BASE}/signup.html`);
    let panel = await shadowBox(sg, 'p');
    let boxes = await Promise.all(IDS.map((s) => elBox(sg, s)));
    ok(boxes.every((b) => !overlaps(panel, b)), `パネルは、ユーザー ID 欄・パスワード欄のどれにも重ならない（panel ${Math.round(panel.top)}-${Math.round(panel.bottom)}）`);
    ok(panel.top >= boxes[2].bottom && Math.abs(panel.left - Math.max(8, boxes[1].left)) < 2, 'パネルは、いちばん下のパスワード欄の下に出る（左端は欄にそろう。画面の端から 8px は空ける）');
    ok((await shadowBox(sg, 'bar')) && (await shadowBox(sg, 'x')), 'パネルに、見出しの帯と × ボタンがある');
    // スクロールに追従する
    await sg.eval(`window.scrollBy(0, 30)`);
    await sleep(500);
    panel = await shadowBox(sg, 'p');
    boxes = await Promise.all(IDS.map((s) => elBox(sg, s)));
    ok(Math.abs(panel.top - (boxes[2].bottom + 6)) < 3 && boxes.every((b) => !overlaps(panel, b)), 'ページをスクロールしても、パネルは欄の下に付いてくる');
    // × で閉じる
    // 位置を測り直して最大 3 回押す（測ったあとにパネルが動いた場合に備える）。閉じなければ、位置を出して失敗にする
    let closedByX = false, lastDiag = '';
    for (let n = 0; n < 3 && !closedByX; n++) {
      const xb = await shadowBox(sg, 'x');
      if (!xb) { closedByX = true; break; }
      const cx = (xb.left + xb.right) / 2, cy = (xb.top + xb.bottom) / 2;
      lastDiag = `× (${Math.round(cx)},${Math.round(cy)}) panel ${JSON.stringify(await shadowBox(sg, 'p'))}`;
      await sg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
      await sg.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
      await sg.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
      closedByX = await waitFor(async () => !(await shadowBox(sg, 'p')), 2500, '× で閉じる').then(() => true, () => false);
    }
    if (!closedByX) throw new Error('× で閉じない: ' + lastDiag);
    ok(true, '× ボタンで、パネルが閉じる');
    await closeTab(sg);

    // 2. 下に余白がない（フォームが画面の下端）: いちばん上の欄の上に出る。それでも欄には重ならない
    sg = await openTab(`${BASE}/signup-low.html`);
    await sg.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false }); // 画面が低いと、パネル（高さ 360）が収まらないため、広さを決める
    await waitFor(() => sg.eval(`document.readyState === 'complete'`));
    await sleep(800);
    await sg.eval(`window.scrollTo(0, document.body.scrollHeight)`);
    await sleep(400);
    await genOpen(sg, `${BASE}/signup-low.html`);
    panel = await shadowBox(sg, 'p');
    boxes = await Promise.all(IDS.map((s) => elBox(sg, s)));
    ok(panel.bottom <= Math.min(...boxes.map((b) => b.top)) && boxes.every((b) => !overlaps(panel, b)), `下に余白がないときは、欄の上に出て、どの欄にも重ならない（panel ${Math.round(panel.top)}-${Math.round(panel.bottom)}、欄 ${Math.round(Math.min(...boxes.map((b) => b.top)))}〜）`);

    // 3. 見出しの帯をつかんで動かせる。動かしたあとは、自動の位置合わせをしない
    const bar = await shadowBox(sg, 'bar');
    const bx = (bar.left + bar.right) / 2 - 40, by = (bar.top + bar.bottom) / 2;
    await sg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bx, y: by });
    await sg.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bx, y: by, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 5; i++) await sg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bx + i * 20, y: by + i * 10, button: 'left', buttons: 1 });
    await sg.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bx + 100, y: by + 50, button: 'left', clickCount: 1 });
    await sleep(300);
    const moved = await shadowBox(sg, 'p');
    ok(Math.abs(moved.left - (panel.left + 100)) < 3 && Math.abs(moved.top - (panel.top + 50)) < 3, `帯をつかんでドラッグすると、パネルが動く（${Math.round(panel.left)},${Math.round(panel.top)} → ${Math.round(moved.left)},${Math.round(moved.top)}）`);
    await sg.eval(`window.scrollBy(0, -40)`);
    await sleep(500);
    const after = await shadowBox(sg, 'p');
    ok(Math.abs(after.left - moved.left) < 1 && Math.abs(after.top - moved.top) < 1, '動かしたあとは、スクロールしても自動で位置を直さない');

    // 4. 「使う」: 新しいパスワードと確認用の両方に入り、パネルが閉じる
    const gt = await waitFor(async () => (await chromeTargets()).find((t) => t.url.includes(`${EXT_ID}/generator.html`)), 8000, '生成パネルの中身');
    const gp = await Cdp.connect(gt.webSocketDebuggerUrl);
    await waitFor(() => gp.eval(`!!document.querySelector('output, input[readonly], .out') || document.querySelectorAll('button').length >= 3`), 8000, '生成パネルの表示');
    await sleep(800);
    await gp.eval(`document.querySelector('#gen-use').click()`);
    await waitFor(() => sg.eval(`document.querySelector('#pw1').value !== ''`), 8000, '「使う」で記入');
    const vals = await sg.eval(`JSON.stringify([document.querySelector('#pw1').value, document.querySelector('#pw2').value])`).then(JSON.parse);
    ok(vals[0].length >= 8 && vals[0] === vals[1], '「使う」で、新しいパスワードと確認用の両方に同じ値が入る');
    await waitFor(async () => !(await shadowBox(sg, 'p')), 5000, '使ったあとに閉じる');
    ok(true, '記入したあとは、パネルが閉じて、欄の中身が見える');
    gp.close();
    await closeTab(sg);

    // 5. 低い画面（高さ 484）: 既定は小さい表示（高さ 100〜200）で、どの欄にも重ならず、入力中の欄を覆わない
    const openLow = async (h) => {
      const pg = await openTab(`${BASE}/signup.html`);
      await pg.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: h, deviceScaleFactor: 1, mobile: false });
      await waitFor(() => pg.eval(`document.readyState === 'complete'`));
      await sleep(800);
      await genOpen(pg, `${BASE}/signup.html`);
      const gt2 = await waitFor(async () => (await chromeTargets()).find((t) => t.url.includes(`${EXT_ID}/generator.html`)), 8000, '生成パネルの中身');
      const gp2 = await Cdp.connect(gt2.webSocketDebuggerUrl);
      await waitFor(() => gp2.eval(`!!document.querySelector('#gen-more')`), 8000, '詳細設定のリンク');
      await sleep(500);
      return { pg, gp2 };
    };
    let low = await openLow(484);
    panel = await shadowBox(low.pg, 'p');
    boxes = await Promise.all(IDS.map((s) => elBox(low.pg, s)));
    ok(panel.bottom - panel.top >= 100 && panel.bottom - panel.top <= 200, `既定は小さい表示（高さ ${Math.round(panel.bottom - panel.top)}px）`);
    ok(boxes.every((b) => !overlaps(panel, b)) && panel.top >= 0 && panel.bottom <= 484, `低い画面（高さ 484）でも、小さい表示のパネルはどの欄にも重ならず、画面に収まる（panel ${Math.round(panel.top)}-${Math.round(panel.bottom)}）`);
    ok(await low.gp2.eval(`document.querySelector('#gen-details').classList.contains('hidden') && document.querySelector('#gen-more').getAttribute('aria-expanded') === 'false'`), '詳細設定は、既定で閉じている');
    ok(await low.gp2.eval(`['#gen-use', '#gen-regen'].every((s) => !!document.querySelector(s)) && document.querySelectorAll('button').length >= 4`), '小さい表示にも、「使う」「コピー」「生成」のボタンがある');
    // 詳細設定を開く → パネルが大きくなり、画面内に収まる。入力中の欄は覆わない。もう一度押すと閉じる
    const smallH = panel.bottom - panel.top;
    await low.gp2.eval(`document.querySelector('#gen-more').click()`);
    await waitFor(async () => { const b = await shadowBox(low.pg, 'p'); return b.bottom - b.top > smallH + 40; }, 5000, '詳細設定を開いてパネルが大きくなる');
    await sleep(500);
    panel = await shadowBox(low.pg, 'p');
    ok(panel.top >= 0 && panel.bottom <= 484 && !overlaps(panel, boxes[1]), `詳細設定を開いても、パネルは画面に収まり、入力中の欄を覆わない（panel ${Math.round(panel.top)}-${Math.round(panel.bottom)}）`);
    ok(await low.gp2.eval(`!document.querySelector('#gen-details').classList.contains('hidden') && document.querySelector('#gen-more').getAttribute('aria-expanded') === 'true' && !!document.querySelector('#gen-details input[type=number]')`), '詳細設定に、文字数・文字種・パスフレーズ・使う記号の設定がある');
    await low.gp2.eval(`document.querySelector('#gen-more').click()`);
    await waitFor(async () => { const b = await shadowBox(low.pg, 'p'); return Math.abs((b.bottom - b.top) - smallH) < 4; }, 5000, '詳細設定を閉じてパネルが元の大きさに戻る');
    ok(true, '詳細設定をもう一度押すと閉じて、パネルが元の小さい大きさに戻る');
    low.gp2.close();
    await closeTab(low.pg);

    // 6. とても低い画面（高さ 300）: 詳細設定を開くと、パネルの高さが画面に収まる範囲に抑えられ、中をスクロールできる
    low = await openLow(300);
    await low.gp2.eval(`document.querySelector('#gen-more').click()`);
    await sleep(900);
    panel = await shadowBox(low.pg, 'p');
    ok(panel.top >= 0 && panel.bottom <= 300 && panel.bottom - panel.top <= 300 - 16 + 1, `高さが画面に収まる範囲に抑えられる（panel ${Math.round(panel.top)}-${Math.round(panel.bottom)} / 画面 300）`);
    ok(await low.gp2.eval(`document.documentElement.scrollHeight > document.documentElement.clientHeight`), 'パネルの中は、スクロールできる');
    low.gp2.close();
    await closeTab(low.pg);
  }

  // ------------------------------------------------------ ホームのサイトアイコン: 取得（各サイトから直接・Cookie なし）・表示・キャッシュ・設定のオフ
  {
    const mkSite = (handler) => new Promise((resolve) => {
      const log = [];
      const srv = http.createServer((req, res) => {
        log.push({ path: req.url, cookie: req.headers.cookie || '', referer: req.headers.referer || '' });
        handler(req, res);
      });
      srv.listen(0, '127.0.0.1', () => resolve({ srv, log, port: srv.address().port }));
    });
    const html = (res, body, cookie) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...(cookie ? { 'set-cookie': 'sid=1; Path=/' } : {}) }); res.end(body); };
    const img = (res, buf, type) => { res.writeHead(200, { 'content-type': type }); res.end(buf); };
    const nf = (res) => { res.writeHead(404); res.end('nf'); };
    // A: apple-touch-icon（180px、外周が一色の青）。ほかに小さい icon も宣言する
    const siteA = await mkSite((req, res) => {
      if (req.url === '/') html(res, '<!doctype html><title>A</title><link rel="icon" sizes="16x16" href="/small.png"><link rel="apple-touch-icon" href="/icons/a-180.png" sizes="180x180">', true);
      else if (req.url === '/icons/a-180.png') img(res, makePng(180, 180, [30, 100, 200, 255], [255, 255, 255, 255]), 'image/png');
      else nf(res);
    });
    // B: favicon.ico だけ（外周が透明の画像）
    const siteB = await mkSite((req, res) => {
      if (req.url === '/') html(res, '<!doctype html><title>B</title>', true);
      else if (req.url === '/favicon.ico') img(res, makePng(16, 16, [0, 0, 0, 0], [220, 60, 60, 255]), 'image/x-icon');
      else nf(res);
    });
    // C: 画像なし
    const siteC = await mkSite((req, res) => {
      if (req.url === '/') html(res, '<!doctype html><title>C</title>', true);
      else nf(res);
    });
    const sites = [['Alpha', siteA], ['Bravo', siteB], ['Charlie', siteC]];
    const iconIds = [];
    for (const [name, s] of sites) {
      const it = await pipe.ok('saveItem', { mode: 'new', item: { type: 1, name, folder: '/', url: `http://127.0.0.1:${s.port}/login`, fields: [{ name: 'u', value: 'iconuser', kind: 'text', role: 'user' }, { name: 'p', value: 'Icon-Pass-1', kind: 'password', role: 'password' }] } });
      iconIds.push(it.id);
    }
    // Cookie を持たせるため、各サイトのページを一度開く（アイコンの取得で、Cookie が送られないことを確かめる）
    for (const [, s] of sites) { const pg = await openTab(`http://127.0.0.1:${s.port}/`); await closeTab(pg); }
    // 既定（未設定）はオフ: 通信せず、画面の上に案内を出す。閉じたことは覚える
    await swc.eval(`chrome.storage.local.remove(['tkrform.home.icons', 'tkrform.home.iconsNoteClosed'])`);
    await swc.eval(`bg({ t: 'iconClear' })`);
    for (const [, s] of sites) s.log.length = 0;
    const offHome = await openTab(`chrome-extension://${EXT_ID}/start.html`);
    await waitFor(() => offHome.eval(`document.querySelectorAll('.tile').length > 0`), 15000, 'ホームの表示（既定オフ）');
    await sleep(2500);
    ok(sites.every(([, s]) => s.log.length === 0), '既定（未設定）では、アイコンの取得で通信しない');
    ok(await offHome.eval(`!document.querySelector('#icon-note').classList.contains('hidden') && document.querySelector('#icon-note').textContent.includes('設定でオンにしてください') && !!document.querySelector('#icon-note-link')`), 'アイコンの取得がオフのときは、画面の上に「設定でオンにしてください」と、設定を開くリンクの案内を出す');
    await offHome.click('#icon-note-close');
    await waitFor(() => offHome.eval(`document.querySelector('#icon-note').classList.contains('hidden')`), 3000, '案内を閉じる');
    await offHome.eval('location.reload()');
    await waitFor(() => offHome.eval(`document.querySelectorAll('.tile').length > 0`), 15000, '再表示');
    await sleep(500);
    ok(await offHome.eval(`document.querySelector('#icon-note').classList.contains('hidden')`), '案内を閉じたことは、覚えている');
    await closeTab(offHome);
    // オンにすると、取得する
    await swc.eval(`chrome.storage.local.set({ 'tkrform.home.icons': true })`);
    await swc.eval(`bg({ t: 'iconClear' })`);
    for (const [, s] of sites) s.log.length = 0;
    const home = await openTab(`chrome-extension://${EXT_ID}/start.html`);
    await home.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const tileOf = (s) => `.tile[data-url^="http://127.0.0.1:${s.port}"]`;
    const info = (s) => home.eval(`(() => { const t = document.querySelector(${JSON.stringify(tileOf(s))}); if (!t) return null; const i = t.querySelector('.ico img'); const c = getComputedStyle(t); return { src: i ? i.src.slice(0, 22) : '', initial: (t.querySelector('.initial') || {}).textContent || '', hasbg: t.classList.contains('hasbg'), bg: c.backgroundColor, color: c.color, title: t.title }; })()`);
    await waitFor(async () => (await info(siteA))?.src.startsWith('data:image/png'), 20000, 'A のアイコン');
    await waitFor(async () => (await info(siteB))?.src.startsWith('data:image/png'), 20000, 'B のアイコン');
    await waitFor(() => siteC.log.some((r) => r.path === '/favicon.ico'), 20000, 'C の取得');
    await sleep(800);
    const ia = await info(siteA), ib = await info(siteB), ic = await info(siteC);
    ok(ia.src.startsWith('data:image/png') && ib.src.startsWith('data:image/png'), 'apple-touch-icon のサイトと、favicon.ico だけのサイトで、画像が表示される');
    ok(ic.src === '' && ic.initial === 'C', `画像のないサイトは、名前の頭文字で表示される（${ic.initial}）`);
    ok(ia.hasbg && ia.bg === 'rgb(30, 100, 200)' && ia.color === 'rgb(255, 255, 255)', `外周が不透明で一色の画像は、その色をタイルの背景にし、文字を白にする（${ia.bg} / ${ia.color}）`);
    ok(!ib.hasbg, '外周が透明な画像は、タイルの背景色を変えない');
    ok(ia.title.includes('iconuser') && ia.title.includes('127.0.0.1'), 'ユーザー ID は、タイルの title で出す');
    const paths = (s) => s.log.map((r) => r.path).join(' ');
    ok(paths(siteA) === '/ /icons/a-180.png', `A: トップページ → いちばん大きい icon だけを取りに行く（${paths(siteA)}）`);
    ok(paths(siteB) === '/ /apple-touch-icon.png /favicon.ico', `B: トップページ → /apple-touch-icon.png → /favicon.ico の順（${paths(siteB)}）`);
    ok(paths(siteC) === '/ /apple-touch-icon.png /favicon.ico', `C: 見つからなければ、決まった場所を試して諦める（${paths(siteC)}）`);
    ok(sites.every(([, s]) => s.log.every((r) => r.cookie === '' && r.referer === '')), '取得のリクエストに、Cookie も Referer も付かない');
    await home.screenshot(path.join(shots, 'home-icons.png'));
    // 2 回目: キャッシュから表示し、通信しない
    const total = () => sites.reduce((n, [, s]) => n + s.log.length, 0);
    const before = total();
    await home.eval('location.reload()');
    await waitFor(async () => (await info(siteA))?.src.startsWith('data:image/png') && (await info(siteB))?.src.startsWith('data:image/png'), 15000, '再表示');
    await sleep(1200);
    ok(total() === before, `2 回目はキャッシュから表示し、通信しない（${before} → ${total()} 件）`);
    // 設定をオフ: キャッシュを消して開き直しても、通信しない
    await swc.eval(`chrome.storage.local.set({ 'tkrform.home.icons': false })`);
    await swc.eval(`bg({ t: 'iconClear' })`);
    await home.eval('location.reload()');
    await waitFor(async () => !!(await info(siteC)), 15000, 'オフでの表示');
    await sleep(1500);
    ok(total() === before, `設定をオフにすると、通信しない（${before} → ${total()} 件）`);
    ok((await info(siteC)).initial === 'C', 'オフのときも、画像がなければ頭文字で表示される');
    // 設定ページ: スイッチと、キャッシュを消すボタン
    const opt = await openTab(`chrome-extension://${EXT_ID}/options.html`);
    await waitFor(() => opt.eval(`!!document.querySelector('#home-icons')`), 8000, '設定ページ');
    await sleep(300);
    ok((await opt.eval(`document.querySelector('#home-icons').checked`)) === false, '設定ページのスイッチは、保存された設定（オフ）を反映する');
    await opt.click('#home-icons');
    await sleep(300);
    ok((await swc.eval(`chrome.storage.local.get('tkrform.home.icons').then((r) => r['tkrform.home.icons'])`)) === true, 'スイッチをオンにすると、すぐ保存される');
    await opt.click('#icons-clear');
    await waitFor(() => opt.eval(`document.querySelector('#icons-msg').textContent.length > 0`), 5000, 'キャッシュを消す');
    ok(true, '「アイコンのキャッシュを消す」ボタンが使える');
    await closeTab(opt);
    // 後片付け（設定は、既定の未設定に戻す）
    await swc.eval(`chrome.storage.local.remove(['tkrform.home.icons', 'tkrform.home.iconsNoteClosed'])`);
    await swc.eval(`bg({ t: 'iconClear' })`);
    await closeTab(home);
    for (const id of iconIds) await pipe.ok('deleteItem', { id });
    for (const [, s] of sites) s.srv.close();
  }

  // ------------------------------------------------------ 再度ロック → 拡張のアイコン（タイトル）が変わる
  await pipe.ok('lock');
  await waitFor(async () => (await swState()).locked === true, 3000);
  ok(true, '再ロックも拡張に伝わる');

  // ------------------------------------------------------ Windows Hello でのロック解除（ポップアップ・インラインメニュー）
  // これまでのテストで開いたままのポップアップのタブは閉じる（Hello が使えるロック中に、古いポップアップも自動開始してしまうため）
  for (const t of await chromeTargets()) if (t.type === 'page' && t.url.includes(`${EXT_ID}/popup.html`)) await fetch(`http://127.0.0.1:${CHROME_PORT}/json/close/${t.id}`).catch(() => {});
  await sleep(500);
  await waitFor(async () => (await swState()).locked === true, 3000);
  ok((await swState()).helloAvailable === false, 'Hello が有効でなければ、拡張には「使えない」と伝わる');
  await pipe.ok('unlock', { password: MP });
  await ui.eval(`rpc('helloEnable')`);
  await pipe.ok('lock');
  await waitFor(async () => (await swState()).helloAvailable === true, 5000, 'Hello 利用可の通知');
  ok(true, 'Hello が有効なら、拡張に「Hello で解除できる」と伝わる');
  // ポップアップを開いたとき、ロック中で Hello が使えるなら、ボタンを押さなくても自動で始まる（ここでは失敗するスタブで、開始の回数を数える）
  const helloFailures = () => { try { return fs.readFileSync(path.join(dataDir, 'logs', 'tkrform.log'), 'utf8').split('hello.failed').length - 1; } catch (_) { return 0; } };
  fs.writeFileSync(helloStub, 'fail');
  const f0 = helloFailures();
  const hpa = await openTab(`chrome-extension://${EXT_ID}/popup.html`);
  await hpa.send('Runtime.enable').catch(() => {});
  try {
    await waitFor(() => hpa.eval(`!document.querySelector('#unlock-err').classList.contains('hidden')`), 8000, '自動開始した Hello の失敗表示');
  } catch (e) {
    // どこでずれたか分かるよう、ポップアップ・拡張・アプリの状態を出す
    const dump = await hpa.eval(`JSON.stringify({ view: ['off','locked','main'].filter((v) => !document.querySelector('#v-' + v).classList.contains('hidden')), err: document.querySelector('#unlock-err').textContent, helloBtnHidden: document.querySelector('#hello-btn').classList.contains('hidden'), helloBtnDisabled: document.querySelector('#hello-btn').disabled })`).catch((x) => String(x));
    console.log('診断 popup:', dump);
    console.log('診断 popup 内部:', await hpa.eval(`JSON.stringify({ tried: helloAutoTried, ah: window.__ah || null })`).catch((x) => String(x)));
    console.log('診断 popup コンソール:', JSON.stringify(hpa.events.filter((e) => /console|exception|log/i.test(e.method)).slice(0, 5)).slice(0, 600));
    const t1 = Date.now();
    const late = await waitFor(() => hpa.eval(`document.querySelector('#unlock-err').textContent`), 6000, '遅れて出るエラー表示').catch(() => null);
    console.log('診断 遅れて出たエラー表示:', late, `(${Date.now() - t1}ms 後)`);
    console.log('診断 bg state:', JSON.stringify(await swState()));
    console.log('診断 hello.failed の数:', helloFailures());
    const stt = await swc.eval(`bg({ t: 'helloAuto' }).then((r) => JSON.stringify(r), (x) => 'ERR ' + JSON.stringify(x))`).catch((x) => String(x));
    console.log('診断 helloAuto の直接呼び出し:', stt);
    throw e;
  }
  ok(helloFailures() === f0 + 1, 'ポップアップを開くと、ボタンを押さなくても Windows Hello の確認が自動で始まる');
  ok(await hpa.eval(`!document.querySelector('#mp').disabled && !document.querySelector('#hello-btn').classList.contains('hidden')`), '自動開始のあとも、ボタンとマスターパスワード入力は使える');
  hpa.close();
  // 失敗した直後（30 秒以内）に開き直しても、自動では始めない
  const hpb = await openTab(`chrome-extension://${EXT_ID}/popup.html`);
  await waitFor(() => hpb.eval(`!document.querySelector('#v-locked').classList.contains('hidden')`), 8000, 'ロック画面');
  await sleep(1500);
  ok(helloFailures() === f0 + 1 && (await hpb.eval(`document.querySelector('#unlock-err').classList.contains('hidden')`)), '失敗の直後（30 秒以内）に開き直しても、Windows Hello を自動では始めない');
  // 同時に 2 回求めても、確認は 1 回だけ（二重に始めない）
  await hpb.eval(`Promise.allSettled([bg({ t: 'helloUnlock' }), bg({ t: 'helloUnlock' })])`);
  ok(helloFailures() === f0 + 2, 'Windows Hello の要求が重なっても、二重には始めない（1 回だけ）');
  hpb.close();
  fs.writeFileSync(helloStub, 'ok');
  const hp = await openTab(`chrome-extension://${EXT_ID}/popup.html`);
  await waitFor(() => hp.eval(`!document.querySelector('#v-locked').classList.contains('hidden')`), 8000, 'ロック画面');
  await sleep(500);
  ok((await swState()).locked === true, '失敗の直後は、スタブが成功でも自動では解除されない（ボタンかマスターパスワードで解除する）');
  ok(await hp.eval(`!document.querySelector('#hello-btn').classList.contains('hidden')`), 'ポップアップのロック画面に「Windows Hello でロック解除」ボタンが出る');
  await hp.screenshot(path.join(shots, 'popup-hello.png'));
  fs.writeFileSync(helloStub, 'fail');
  await hp.click('#hello-btn');
  await waitFor(() => hp.eval(`!document.querySelector('#unlock-err').classList.contains('hidden')`), 8000, 'Hello 失敗のエラー');
  ok((await hp.eval(`document.querySelector('#unlock-err').textContent`)).includes('Windows Hello'), 'Hello に失敗したら、エラーを表示する');
  ok((await swState()).locked === true && (await hp.eval(`!document.querySelector('#mp').disabled && !document.querySelector('#hello-btn').disabled`)), '失敗後もロックのまま、マスターパスワード入力と Hello の再試行を使える');
  fs.writeFileSync(helloStub, 'cancel');
  await hp.click('#hello-btn');
  await waitFor(async () => (await hp.eval(`document.querySelector('#unlock-err').textContent`)).includes('キャンセル'), 8000, 'キャンセルの表示');
  ok(true, 'Hello の確認をキャンセルしたら、その旨を表示する');
  fs.writeFileSync(helloStub, 'ok');
  await hp.click('#hello-btn');
  await waitFor(() => hp.eval(`!document.querySelector('#v-main').classList.contains('hidden')`), 8000, 'Hello で解除');
  await waitFor(async () => (await swState()).locked === false, 5000);
  ok(true, 'Hello に成功すると、ロックが解除されて一覧に切り替わる（マスターパスワードなし）');
  hp.close();
  // インラインメニュー（ロック中の表示に Hello ボタン）
  await pipe.ok('lock');
  await waitFor(async () => (await swState()).locked === true, 3000);
  const hl = await openTab(`${BASE}/login.html`);
  await waitFor(() => hl.eval(`document.readyState === 'complete'`));
  await sleep(800);
  await hl.click('#email');
  await sleep(1500);
  // ロック中は候補を自動で開かないので、入力欄の右端のアイコンを押してメニューを開く
  const ib = await hl.eval(`(() => { const r = document.querySelector('#email').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height }; })()`);
  const ix = Math.round(ib.r - 14), iy = Math.round(ib.t + ib.h / 2);
  await hl.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ix, y: iy, button: 'left', clickCount: 1 });
  await hl.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ix, y: iy, button: 'left', clickCount: 1 });
  await sleep(800);
  await hl.screenshot(path.join(shots, 'inline-hello.png'));
  // メニュー（閉じた Shadow DOM）の見出しの下に、緑の「Windows Hello でロック解除」ボタンが最初に並ぶ。その位置を押して解除できることで確認する
  const helloBox = await pierceBox(hl, 'hello');
  const hx = Math.round((helloBox.left + helloBox.right) / 2), hy = Math.round((helloBox.top + helloBox.bottom) / 2);
  await hl.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hx, y: hy, button: 'left', clickCount: 1 });
  await hl.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hx, y: hy, button: 'left', clickCount: 1 });
  await waitFor(async () => (await swState()).locked === false, 8000, 'インラインメニューの Hello で解除');
  ok(true, 'インラインメニューのロック中表示の「Windows Hello でロック解除」ボタンで、マスターパスワードなしに解除できる');
  hl.close();
  await pipe.ok('lock');
  await waitFor(async () => (await swState()).locked === true, 3000);
  // ------------------------------------------------------ アプリが終了しても、接続役（NM ホスト）は生きたまま。拡張から要求すると、接続役がアプリを起動して、つなぎ直す
  {
    const psJson = (cmd) => JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim() || '[]');
    // プロセスの一覧（Name, ProcessId, ParentProcessId）。接続役の親は、Chrome の本体とは限らない（途中に別のプロセスがある）ので、祖先をたどる
    const procs = (name) => [].concat(psJson('@(Get-CimInstance Win32_Process | Select-Object Name, ProcessId, ParentProcessId) | ConvertTo-Json -Compress')).filter((p) => p.Name.toLowerCase() === name.toLowerCase());
    const allProcs = () => [].concat(psJson('@(Get-CimInstance Win32_Process | Select-Object Name, ProcessId, ParentProcessId) | ConvertTo-Json -Compress'));
    const descendantOf = (p, rootPid, all) => { for (let q = p, n = 0; q && n < 12; n++) { if (q.ParentProcessId === rootPid) return true; q = all.find((x) => x.ProcessId === q.ParentProcessId); } return false; };
    const all0 = allProcs();
    const hostBefore = all0.filter((p) => p.Name.toLowerCase() === 'tkrform-nmhost.exe').find((p) => descendantOf(p, chrome.pid, all0));
    ok(!!hostBefore, '接続役（NM ホスト）が、この Chrome から起動されて動いている');
    killTree(app.child);
    await sleep(2500); // 接続役が disconnected を送り、拡張が「未接続」にする時間
    const hostAfter = procs('tkrform-nmhost.exe').find((p) => p.ProcessId === hostBefore.ProcessId);
    ok(!!hostAfter, 'アプリが終了しても、接続役は動き続けている');
    // 拡張から要求（ポップアップが開いたときの state の問い合わせ）→ 接続役がアプリを起動する
    const st1 = await swState();
    ok(st1.connected === true || st1.starting === true, `未接続のときに state を問い合わせると、アプリの起動が始まる（connected=${st1.connected} starting=${st1.starting}）`);
    await waitFor(async () => (await swState()).connected === true, 30000, 'アプリが起動してつながる');
    ok(true, '接続役がアプリを起動し、拡張がつなぎ直せた');
    const newApp = procs('TKRForm.exe').find((p) => p.ParentProcessId === hostBefore.ProcessId);
    ok(!!newApp, 'アプリは、接続役が起動した（親は、同じ接続役）');
    // 起動したアプリを片付ける（利用者の TKRForm には触れない。この接続役が起動したものだけ）
    if (newApp) { try { execFileSync('taskkill', ['/pid', String(newApp.ProcessId), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* 既に終了 */ } }
  }

  swc.close(); ui.close(); pipe.close();
} catch (e) {
  failed++;
  console.log(`ERROR（最後に通った確認: ${lastOk}）`, e.stack || e);
} finally {
  clearTimeout(watchdog);
  console.log('--- アプリのログ ---\n' + app.log.join('').slice(-800));
  cleanup();
  console.log(`スクリーンショット: ${shots}`);
  console.log(failed ? `${failed} 件失敗` : 'すべて成功');
  process.exit(failed ? 1 : 0);
}
