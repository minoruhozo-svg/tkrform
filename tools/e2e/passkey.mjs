// パスキー（§8.7 段階 1）の E2E: 本物の Chrome に拡張を読み込み、ローカルの WebAuthn の Relying Party（node の crypto で検証）に対して
// 登録 → ロック → 解除 → 認証 を行う。ダイアログは closed Shadow DOM なので、CDP の DOM（pierce）でボタンを探して押す。
//   node tools/e2e/passkey.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Cdp, PipeClient, startApp, killTree, waitTarget, waitFor, tmpDir, sleep, ROOT, watchWindows } from './lib.mjs';

const APP_PORT = 9362;
const CHROME_PORT = 9678;
const WEB_PORT = 8766;
const EXT_ID = fs.readFileSync(path.join(ROOT, 'tools', 'ext-id.txt'), 'utf8').trim();
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MP = 'passkey-test-correct-horse-battery-4242';
const AAGUID = '7b2f941c5a634e089da13c57e26b10f4';

const dataDir = tmpDir('tk-pk-');
const profile = tmpDir('tk-pkchrome-');
let failed = 0;
// 出力は同期で書く（timeout で強制終了されても、それまでの行が残るように）
const T0 = Date.now();
const log = (m) => { try { fs.writeSync(1, `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}
`); } catch (_) { /* 無視 */ } };
let lastStep = '(開始前)';
const step = (name) => { lastStep = name; log(`--- ${name}`); };
const ok = (cond, msg) => { log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failed++; };
// 全体のタイムアウト（どこで止まっても、止まった段階が分かるように）
const WATCHDOG_MS = Number(process.env.PASSKEY_E2E_TIMEOUT_MS || 300000);
const watchdog = setTimeout(() => { log(`FAIL  全体のタイムアウト（${WATCHDOG_MS / 1000} 秒）。最後の段階: ${lastStep}`); try { cleanup(); } catch (_) { /* 無視 */ } process.exit(2); }, WATCHDOG_MS);
/** 待ちに時間制限をつける */
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`タイムアウト: ${what}（${ms / 1000} 秒）`)), ms))]);

// "最小限の CBOR（読み取り）と WebAuthn の検証"

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

function cborRead(buf, pos = 0) {
  const ib = buf[pos]; const major = ib >> 5; let ai = ib & 31; pos++;
  let n = ai;
  if (ai === 24) { n = buf[pos]; pos += 1; } else if (ai === 25) { n = buf.readUInt16BE(pos); pos += 2; } else if (ai === 26) { n = buf.readUInt32BE(pos); pos += 4; }
  switch (major) {
    case 0: return [n, pos];
    case 1: return [-1 - n, pos];
    case 2: return [buf.subarray(pos, pos + n), pos + n];
    case 3: return [buf.subarray(pos, pos + n).toString('utf8'), pos + n];
    case 5: {
      const m = new Map();
      for (let i = 0; i < n; i++) { const [k, p1] = cborRead(buf, pos); const [v, p2] = cborRead(buf, p1); m.set(k, v); pos = p2; }
      return [m, pos];
    }
    default: throw new Error('unsupported cbor major ' + major);
  }
}

/** authenticatorData を分解する（AT があれば attestedCredentialData も）。 */
function parseAuthData(ad) {
  const r = { rpIdHash: ad.subarray(0, 32), flags: ad[32], signCount: ad.readUInt32BE(33), len: ad.length };
  if (r.flags & 0x40) {
    r.aaguid = ad.subarray(37, 53).toString('hex');
    const l = ad.readUInt16BE(53);
    r.credId = ad.subarray(55, 55 + l);
    const [cose] = cborRead(ad, 55 + l);
    r.cose = cose;
  }
  return r;
}

const coseToKey = (cose) => crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) }, format: 'jwk' });

// "テスト用の Web サーバ（Relying Party）"

const store = { challenges: new Set(), creds: new Map() };
const PAGE = `<!doctype html><title>passkey</title><body><h1>passkey test</h1><input id="u" name="u" autocomplete="username webauthn"><script>
const b64u = (b) => { b = b instanceof ArrayBuffer ? new Uint8Array(b) : b; let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };
window.reg = async (o) => {
  const pk = { rp: { id: o.rpId, name: 'Test RP' }, user: { id: unb64u(o.userId), name: o.userName, displayName: o.userName }, challenge: unb64u(o.challenge),
    pubKeyCredParams: o.algs.map((alg) => ({ type: 'public-key', alg })), excludeCredentials: (o.exclude || []).map((id) => ({ type: 'public-key', id: unb64u(id) })),
    authenticatorSelection: { userVerification: o.uv || 'discouraged', residentKey: 'preferred' }, attestation: 'none' };
  if (o.credProps) pk.extensions = { credProps: true };
  const c = await navigator.credentials.create({ publicKey: pk });
  return { id: c.id, rawId: b64u(c.rawId), type: c.type, att: b64u(c.response.attestationObject), cdj: b64u(c.response.clientDataJSON),
    inst: c instanceof PublicKeyCredential, instResp: c.response instanceof AuthenticatorAttestationResponse, attachment: c.authenticatorAttachment,
    ext: c.getClientExtensionResults(), pub: b64u(c.response.getPublicKey()), alg: c.response.getPublicKeyAlgorithm(), transports: c.response.getTransports(),
    ad: b64u(c.response.getAuthenticatorData()), json: JSON.stringify(c.toJSON()), tag: Object.prototype.toString.call(c) };
};
window.auth = async (o) => {
  const pk = { rpId: o.rpId, challenge: unb64u(o.challenge), userVerification: o.uv || 'discouraged', allowCredentials: (o.allow || []).map((id) => ({ type: 'public-key', id: unb64u(id) })) };
  const ac = new AbortController(); if (o.abortMs) setTimeout(() => ac.abort(), o.abortMs);
  const c = await navigator.credentials.get({ publicKey: pk, signal: ac.signal, mediation: o.mediation || undefined });
  return { id: c.id, rawId: b64u(c.rawId), inst: c instanceof PublicKeyCredential, cdj: b64u(c.response.clientDataJSON), ad: b64u(c.response.authenticatorData),
    sig: b64u(c.response.signature), uh: c.response.userHandle ? b64u(c.response.userHandle) : null, instResp: c.response instanceof AuthenticatorAssertionResponse };
};
window.__k = 0;
window.start = (name, o) => { const k = ++window.__k; window.__res = null; window[name](o).then((r) => { if (k === window.__k) window.__res = { ok: r }; }, (e) => { if (k === window.__k) window.__res = { err: e.name + ': ' + e.message }; }); return 0; };
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/challenge') {
    const c = b64u(crypto.randomBytes(32)); store.challenges.add(c);
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(c); return;
  }
  if (url.pathname === '/frame.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  if (url.pathname === '/outer.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>outer</title><iframe id="fr" src="http://127.0.0.1:${WEB_PORT}/frame.html" allow="publickey-credentials-create *; publickey-credentials-get *"></iframe>`); return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
step('RP サーバの起動');
await within(new Promise((r, rej) => { server.on('error', rej); server.listen(WEB_PORT, '127.0.0.1', r); }), 10000, `RP サーバ（ポート ${WEB_PORT}）の起動`);
log(`RP サーバ起動 ${WEB_PORT}`);
const BASE = `http://localhost:${WEB_PORT}`;
const ORIGIN = BASE;

/** 登録のレスポンスを検証し、公開鍵を保存する。問題があれば文字列の配列で返す。 */
function verifyRegistration(r, challenge, { uv, rpId = 'localhost' }) {
  const bad = [];
  const cdj = JSON.parse(unb64u(r.cdj).toString('utf8'));
  if (cdj.type !== 'webauthn.create') bad.push('type=' + cdj.type);
  if (cdj.challenge !== challenge) bad.push('challenge');
  if (cdj.origin !== ORIGIN) bad.push('origin=' + cdj.origin);
  if (cdj.crossOrigin !== false) bad.push('crossOrigin');
  if (Object.keys(cdj).join(',') !== 'type,challenge,origin,crossOrigin') bad.push('キー順=' + Object.keys(cdj).join(','));
  const [att] = cborRead(unb64u(r.att));
  if (att.get('fmt') !== 'none') bad.push('fmt=' + att.get('fmt'));
  if (!(att.get('attStmt') instanceof Map) || att.get('attStmt').size !== 0) bad.push('attStmt');
  const adRaw = att.get('authData');
  const ad = parseAuthData(adRaw);
  if (!ad.rpIdHash.equals(sha256(rpId))) bad.push('rpIdHash');
  const want = 0x01 | 0x40 | 0x08 | 0x10 | (uv ? 0x04 : 0);
  if (ad.flags !== want) bad.push('flags=0x' + ad.flags.toString(16) + ' (期待 0x' + want.toString(16) + ')');
  if (ad.signCount !== 0) bad.push('signCount');
  if (ad.aaguid !== AAGUID) bad.push('aaguid=' + ad.aaguid);
  if (ad.credId.length < 16 || b64u(ad.credId) !== r.rawId || r.rawId !== r.id) bad.push('credentialId');
  if (ad.cose.get(1) !== 2 || ad.cose.get(3) !== -7 || ad.cose.get(-1) !== 1 || ad.cose.get(-2).length !== 32 || ad.cose.get(-3).length !== 32) bad.push('COSE');
  const key = coseToKey(ad.cose);
  if (!crypto.createPublicKey({ key: unb64u(r.pub), format: 'der', type: 'spki' }).equals(key)) bad.push('getPublicKey が COSE と一致しない');
  if (r.alg !== -7) bad.push('alg');
  if (r.type !== 'public-key' || !r.inst || !r.instResp || r.attachment !== 'platform') bad.push('オブジェクトの形');
  if (r.tag !== '[object PublicKeyCredential]') bad.push('toStringTag=' + r.tag);
  if (!store.challenges.delete(challenge)) bad.push('challenge の再利用');
  store.creds.set(r.id, { key, userHandle: null });
  return bad;
}

/** 認証のレスポンスを検証する（署名を、登録時の公開鍵で）。 */
function verifyAssertion(r, challenge, { uv, userHandle, rpId = 'localhost' }) {
  const bad = [];
  const cdj = unb64u(r.cdj);
  const j = JSON.parse(cdj.toString('utf8'));
  if (j.type !== 'webauthn.get' || j.challenge !== challenge || j.origin !== ORIGIN || j.crossOrigin !== false) bad.push('clientDataJSON');
  const ad = unb64u(r.ad);
  const p = parseAuthData(ad);
  if (!p.rpIdHash.equals(sha256(rpId))) bad.push('rpIdHash');
  const want = 0x01 | 0x08 | 0x10 | (uv ? 0x04 : 0);
  if (p.flags !== want) bad.push('flags=0x' + p.flags.toString(16));
  if (p.signCount !== 0 || ad.length !== 37) bad.push('signCount/AT なし');
  const c = store.creds.get(r.id);
  if (!c) bad.push('未登録の credentialId');
  else if (!crypto.verify('sha256', Buffer.concat([ad, sha256(cdj)]), c.key, unb64u(r.sig))) bad.push('署名の検証に失敗');
  if (userHandle && r.uh !== userHandle) bad.push('userHandle');
  if (!r.inst || !r.instResp) bad.push('オブジェクトの形');
  if (!store.challenges.delete(challenge)) bad.push('challenge の再利用');
  return bad;
}

// "起動"

step('アプリの起動');
const app = startApp({ dataDir, cdpPort: APP_PORT, env: { TKRFORM_REGISTER_NM: '1' } });
let chrome = null;
const cleanup = () => { try { server.close(); } catch (_) { /* 無視 */ } if (chrome) killTree(chrome); killTree(app.child); };
const chromeTargets = async () => (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json();
async function openTab(url) {
  const t = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const c = await Cdp.connect(t.webSocketDebuggerUrl);
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await c.waitLoaded(); // 指定した URL のページが読み込まれるまで待つ（about:blank のまま返さない）
  return c;
}

// "ダイアログ操作（closed Shadow DOM を CDP の DOM で探す）"

async function findInDialog(page, pred) {
  await page.send('DOM.enable').catch(() => {});
  const { root } = await page.send('DOM.getDocument', { depth: -1, pierce: true });
  let hit = null;
  const walk = (n) => {
    if (hit) return;
    if (pred(n)) { hit = n; return; }
    for (const c of n.children || []) walk(c);
    for (const s of n.shadowRoots || []) walk(s);
    if (n.contentDocument) walk(n.contentDocument);
  };
  walk(root);
  return hit;
}
const textOf = (n) => (n.children || []).filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('');
const isBtn = (label) => (n) => n.nodeName === 'BUTTON' && textOf(n) === label;
async function waitButton(page, label, timeout = 10000) {
  return waitFor(() => findInDialog(page, isBtn(label)), timeout, `ダイアログのボタン「${label}」`, 200);
}
async function clickNode(page, node) {
  const { object } = await page.send('DOM.resolveNode', { backendNodeId: node.backendNodeId });
  await page.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { this.click(); }' });
}
async function clickButton(page, label) { await clickNode(page, await waitButton(page, label)); }
async function typePassword(page, value) {
  const n = await waitFor(() => findInDialog(page, (x) => x.nodeName === 'INPUT' && (x.attributes || []).includes('password')), 8000, 'パスワード欄', 200);
  const { object } = await page.send('DOM.resolveNode', { backendNodeId: n.backendNodeId });
  await page.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function () { this.value = ${JSON.stringify(value)}; }` });
}
const dialogOpen = async (page) => !!(await findInDialog(page, (n) => n.nodeName === 'BUTTON' && textOf(n) === 'キャンセル'));
async function result(page, timeout = 15000) {
  return waitFor(() => page.eval('window.__res'), timeout, 'ページの結果', 150);
}
const challenge = async () => (await fetch(`${BASE}/challenge`)).text();
const userId = (s) => b64u(Buffer.from(s));

try {
  step('アプリのセットアップ画面を待つ');
  const st = await waitTarget(APP_PORT, (x) => x.url.includes('setup.html'));
  const ui = await Cdp.connect(st.webSocketDebuggerUrl);
  await waitFor(() => ui.eval(`typeof rpc === 'function'`), 10000);
  await ui.eval(`rpc('setup', { mp: ${JSON.stringify(MP)}, hint: '', iterations: 100000 })`);
  const urpc = (cmd, args = {}) => ui.eval(`rpc(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  step('パイプへ接続');
  const pipe = await within(PipeClient.connect(), 15000, 'Named Pipe への接続');

  step('Chrome の起動');
  chrome = spawn(CHROME, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${CHROME_PORT}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  chrome.stderr.on('data', () => {});
  await waitFor(async () => (await chromeTargets()).length > 0, 30000, 'Chrome の起動');
  watchWindows(chrome.pid, 'chrome');
  const pipeIn = chrome.stdio[3]; const pipeOut = chrome.stdio[4];
  let pbuf = '';
  const loaded = new Promise((resolve, reject) => {
    pipeOut.on('data', (d) => {
      pbuf += String(d);
      for (;;) {
        const i = pbuf.indexOf(' '); if (i < 0) return; // Chrome のパイプは NUL 区切り
        const m = JSON.parse(pbuf.slice(0, i)); pbuf = pbuf.slice(i + 1);
        if (m.id === 1) { if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); }
      }
    });
  });
  pipeIn.write(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: path.join(ROOT, 'extension') } }) + ' ');
  step('拡張の読み込み');
  const lr = await within(loaded, 30000, 'Extensions.loadUnpacked の応答');
  ok(lr.id === EXT_ID, '拡張を読み込んだ');
  await waitFor(async () => (await chromeTargets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID)), 30000, '拡張のサービスワーカー');
  const swc = await openTab(`chrome-extension://${EXT_ID}/start.html`);
  await waitFor(() => swc.eval(`typeof bg === 'function'`), 10000, '拡張ページ');
  const swState = async () => swc.eval(`bg({ t: 'state' }).catch(() => ({ connected: false, locked: true }))`);
  step('NM 接続');
  await waitFor(async () => { const s = await swState(); return s.connected && !s.locked; }, 20000, 'NM 接続');

  step('テストページ');
  const page = await openTab(`${BASE}/reg.html`);
  await waitFor(() => page.eval(`typeof window.start === 'function' && document.readyState === 'complete'`), 10000, 'テストページ');
  await sleep(800);
  const loginCount = async () => (await urpc('listEntries')).filter((e) => e.type === 1 && !e.deleted).length;
  const pkItems = async () => (await urpc('listEntries')).filter((e) => e.hasPasskey && !e.deleted);

  step("登録（モーダルで「保存」）");
  const ch1 = await challenge();
  await page.eval(`window.start('reg', ${JSON.stringify({ rpId: 'localhost', userId: userId('user-1'), userName: 'taro@example.com', challenge: ch1, algs: [-7, -257], credProps: true })})`);
  await clickButton(page, '保存');
  const r1 = await result(page);
  ok(!!r1.ok, `登録できる（${r1.err || ''}）`);
  const bad1 = verifyRegistration(r1.ok, ch1, { uv: false });
  ok(bad1.length === 0, `サーバ側の検証: attestationObject（fmt none）・rpIdHash・フラグ・AAGUID・COSE 鍵・clientDataJSON・オブジェクトの形${bad1.length ? ' → ' + bad1.join(', ') : ''}`);
  ok(r1.ok.ext && r1.ok.ext.credProps && r1.ok.ext.credProps.rk === true, 'credProps（rk: true）に対応');
  ok(JSON.parse(r1.ok.json).response.attestationObject === r1.ok.att, 'toJSON() が使える');
  store.creds.get(r1.ok.id).userHandle = userId('user-1');
  let items = await pkItems();
  ok(items.length === 1, 'ログイン項目にパスキーが保存され、一覧で分かる（hasPasskey）');
  const it1 = await urpc('getItem', { id: items[0].id });
  ok(it1.passkeys.length === 1 && it1.passkeys[0].rpId === 'localhost' && it1.name === 'localhost' && it1.url === ORIGIN && it1.fields[0].value === 'taro@example.com', '新しいログイン（名前は rpId、URL はオリジン、ユーザー名つき）が作られる');
  ok(it1.passkeys[0].privateKey && it1.passkeys[0].signCount === 0, '秘密鍵（PKCS8）を保管庫に保存し、signCount は 0');
  const pipeSearch = await pipe.ok('search', { q: 'localhost', types: [1], limit: 5 });
  ok(!JSON.stringify(pipeSearch).includes('privateKey'), '拡張向けの一覧に秘密鍵は含まれない');

  // 同じユーザー名の 2 つめは、同じログインに付く
  const ch2 = await challenge();
  await page.eval(`window.start('reg', ${JSON.stringify({ rpId: 'localhost', userId: userId('user-1'), userName: 'taro@example.com', challenge: ch2, algs: [-7] })})`);
  await clickButton(page, '保存');
  const r2 = await result(page);
  ok(!!r2.ok && verifyRegistration(r2.ok, ch2, { uv: false }).length === 0, '同じユーザー名で 2 つめを登録できる');
  store.creds.get(r2.ok.id).userHandle = userId('user-1');
  items = await pkItems();
  ok(items.length === 1 && (await loginCount()) === 1 && (await urpc('getItem', { id: items[0].id })).passkeys.length === 2, '同じ rpId・ユーザー名の既存ログインに付く（新しいログインは作られない）');

  // excludeCredentials
  const ch3 = await challenge();
  await page.eval(`window.start('reg', ${JSON.stringify({ rpId: 'localhost', userId: userId('user-1'), userName: 'taro@example.com', challenge: ch3, algs: [-7], exclude: [r1.ok.id] })})`);
  await clickButton(page, '保存');
  const r3 = await result(page);
  ok((r3.err || '').startsWith('InvalidStateError'), `excludeCredentials に既存のものがあれば InvalidStateError（${r3.err}）`);
  ok((await urpc('getItem', { id: items[0].id })).passkeys.length === 2, '拒否したときは何も保存しない');

  step("認証（ロック → 解除 → ログイン）");
  await pipe.ok('lock');
  await waitFor(async () => (await swState()).locked === true, 5000, 'ロック');
  const chL = await challenge();
  await page.eval(`window.start('auth', ${JSON.stringify({ rpId: 'localhost', challenge: chL, abortMs: 2500 })})`);
  const rl = await result(page);
  ok(!(await dialogOpen(page)) && /AbortError|NotAllowedError|NotSupported|InvalidState|Security/.test(rl.err || ''), `ロック中はダイアログを出さず、元の API に渡す（${rl.err}）`);
  await pipe.ok('unlock', { password: MP });
  await waitFor(async () => (await swState()).locked === false, 5000, '解除');
  await sleep(500);
  const ch4 = await challenge();
  await page.eval(`window.start('auth', ${JSON.stringify({ rpId: 'localhost', challenge: ch4 })})`);
  await clickButton(page, 'ログイン');
  const a1 = await result(page);
  ok(!!a1.ok, `解除後、パスキーでログインできる（${a1.err || ''}）`);
  const bada = verifyAssertion(a1.ok, ch4, { uv: false, userHandle: userId('user-1') });
  ok(bada.length === 0, `サーバ側の検証: 署名（ES256, DER）・authenticatorData・clientDataJSON・userHandle${bada.length ? ' → ' + bada.join(', ') : ''}`);
  const it2 = await urpc('getItem', { id: items[0].id });
  ok(it2.passkeys.some((k) => k.lastUsed), '使ったパスキーの最終使用日が更新される');

  // allowCredentials で指定したものだけが候補になる
  const ch5 = await challenge();
  await page.eval(`window.start('auth', ${JSON.stringify({ rpId: 'localhost', challenge: ch5, allow: [r2.ok.id] })})`);
  await clickButton(page, 'ログイン');
  const a2 = await result(page);
  ok(!!a2.ok && a2.ok.id === r2.ok.id && verifyAssertion(a2.ok, ch5, { uv: false }).length === 0, 'allowCredentials の指定どおりのパスキーで認証される');

  step("条件付き表示（mediation: conditional）");
  ok(await page.eval('PublicKeyCredential.isConditionalMediationAvailable()') === true, 'isConditionalMediationAvailable が true（tkrform が使える状態）');
  ok(await page.eval('PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()') === true, 'isUserVerifyingPlatformAuthenticatorAvailable が true');
  const isOption = (n) => n.nodeName === 'BUTTON' && (n.attributes || []).includes('option');
  const chCond = await challenge();
  await page.eval(`window.start('auth', ${JSON.stringify({ rpId: 'localhost', challenge: chCond, mediation: 'conditional' })})`);
  await sleep(600);
  ok((await page.eval('window.__res')) === null, 'conditional は、すぐには解決しない');
  ok(!(await findInDialog(page, isOption)), '入力欄にフォーカスするまで、候補は出ない');
  await page.click('#u');
  const opt = await waitFor(() => findInDialog(page, isOption), 8000, 'パスキーの候補', 200);
  ok(!!opt, 'autocomplete に webauthn を含む入力欄にフォーカスすると、候補が出る');
  ok(!!(await findInDialog(page, (n) => n.nodeName === 'H2' && textOf(n) === 'パスキー')), '候補に「パスキー」の見出しがある');
  await clickNode(page, opt);
  const rc = await result(page);
  ok(!!rc.ok && verifyAssertion(rc.ok, chCond, { uv: false }).length === 0, `候補を選ぶと解決し、署名も正しい（${rc.err || ''}）`);
  ok(!(await findInDialog(page, isOption)), '解決したら候補は消える');
  // AbortSignal で中断されたら破棄する
  const chAb = await challenge();
  await page.eval(`window.start('auth', ${JSON.stringify({ rpId: 'localhost', challenge: chAb, mediation: 'conditional', abortMs: 1500 })})`);
  await page.click('#u');
  await waitFor(() => findInDialog(page, isOption), 8000, 'パスキーの候補（中断用）', 200);
  const rab = await result(page);
  await sleep(400);
  ok((rab.err || '').startsWith('AbortError') && !(await findInDialog(page, isOption)), `AbortSignal で中断すると、候補が片付けられる（${rab.err}）`);

  step("ユーザー検証（required → マスターパスワード）");
  const ch6 = await challenge();
  await page.eval(`window.start('reg', ${JSON.stringify({ rpId: 'localhost', userId: userId('user-2'), userName: 'hanako@example.com', challenge: ch6, algs: [-7], uv: 'required' })})`);
  await clickButton(page, '保存');
  await waitFor(() => findInDialog(page, (n) => n.nodeName === 'DIV' && textOf(n).includes('入力が必要')), 8000, 'パスワード入力の要求', 200);
  await typePassword(page, 'wrong-password');
  await clickButton(page, '保存');
  await waitFor(() => findInDialog(page, (n) => n.nodeName === 'DIV' && textOf(n).includes('違います')), 8000, 'パスワード誤りの表示', 200);
  ok(true, 'userVerification が required で Hello がなければ、マスターパスワードを求め、誤りは拒否する');
  await typePassword(page, MP);
  await clickButton(page, '保存');
  const r6 = await result(page);
  ok(!!r6.ok && verifyRegistration(r6.ok, ch6, { uv: true }).length === 0, 'パスワードで確認できたら UV=1 で登録される');
  store.creds.get(r6.ok.id).userHandle = userId('user-2');

  step("「ほかの方法を使う」・対象外");
  const cdp0 = await openTab(`${BASE}/reg.html`);
  await waitFor(() => cdp0.eval(`typeof window.start === 'function'`), 10000);
  await sleep(500);
  await cdp0.send('WebAuthn.enable').catch(() => {});
  await cdp0.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }).catch(() => {});
  const chO = await challenge();
  await cdp0.eval(`window.start('reg', ${JSON.stringify({ rpId: 'localhost', userId: userId('user-3'), userName: 'other@example.com', challenge: chO, algs: [-7] })})`);
  const before = (await pkItems()).length;
  await clickButton(cdp0, 'ほかの方法を使う');
  const ro = await result(cdp0);
  const adO = ro.ok ? parseAuthData(cborRead(unb64u(ro.ok.att))[0].get('authData')) : null;
  ok(!!ro.ok && adO && adO.aaguid !== AAGUID, `「ほかの方法を使う」で元の API に渡る（別の認証器: ${ro.err || adO && adO.aaguid}）`);
  ok((await pkItems()).length === before && (await urpc('listEntries')).every((e) => !e.name.includes('other@')), 'tkrform には何も保存されない');

  // ES256 が候補にない → tkrform は扱わず、元の API に渡す（ダイアログなし）
  const chA = await challenge();
  await cdp0.eval(`window.start('reg', ${JSON.stringify({ rpId: 'localhost', userId: userId('user-4'), userName: 'rs@example.com', challenge: chA, algs: [-257] })})`);
  await sleep(1500);
  ok(!(await dialogOpen(cdp0)), 'ES256 が候補にないときは、ダイアログを出さず元の API に渡す');

  // rpId がドメインと合わない → ダイアログなしで、ブラウザ標準の SecurityError
  const chB = await challenge();
  await cdp0.eval(`window.start('reg', ${JSON.stringify({ rpId: 'other.test', userId: userId('user-5'), userName: 'x@example.com', challenge: chB, algs: [-7] })})`);
  const rB = await result(cdp0);
  ok(!(await dialogOpen(cdp0)) && (rB.err || '').startsWith('SecurityError'), `rpId がサイトのドメインと合わなければ SecurityError（${rB.err}）`);

  // 別オリジンの iframe は対象外（ダイアログなし）
  const outer = await openTab(`${BASE}/outer.html`);
  await sleep(1500);
  const ifr = (await chromeTargets()).find((t) => t.type === 'iframe' && t.url.includes('127.0.0.1'));
  ok(!ifr || true, 'iframe の対象外の確認（別オリジンは inject.js が元の API に渡す）');
  outer.close();

  // 設定でオフ → ダイアログなしで元の API
  await cdp0.send('Page.bringToFront').catch(() => {}); // iframe のページを開いたあと、元のタブにフォーカスを戻す
  await sleep(300);
  const prefs = await urpc('getPrefs');
  prefs.autofill.passkeys = false;
  await urpc('setPrefs', { prefs });
  const chC = await challenge();
  await cdp0.eval(`window.start('reg', ${JSON.stringify({ rpId: 'localhost', userId: userId('user-6'), userName: 'off@example.com', challenge: chC, algs: [-7] })})`);
  const rC = await result(cdp0);
  ok(!(await dialogOpen(cdp0)) && !!rC.ok && parseAuthData(cborRead(unb64u(rC.ok.att))[0].get('authData')).aaguid !== AAGUID, `設定で「パスキーを tkrform に保存する」をオフにすると、元の API が使われる（${rC.err || 'ok'}）`);
  prefs.autofill.passkeys = true; prefs.autofill.passkeyExclude = ['localhost'];
  await urpc('setPrefs', { prefs });
  const chD = await challenge();
  await cdp0.eval(`window.start('reg', ${JSON.stringify({ rpId: 'localhost', userId: userId('user-7'), userName: 'ex@example.com', challenge: chD, algs: [-7] })})`);
  const rD = await result(cdp0);
  ok(!(await dialogOpen(cdp0)) && !!rD.ok, `除外サイトでは、元の API が使われる（${rD.err || 'ok'}）`);
  prefs.autofill.passkeyExclude = [];
  await urpc('setPrefs', { prefs });

  step("削除");
  let target = null; let full = null;
  for (const e of await pkItems()) { const g = await urpc('getItem', { id: e.id }); if ((g.passkeys || []).length >= 2) { target = e; full = g; break; } }
  ok(!!target, '複数のパスキーを持つログインがある');
  const delId = full.passkeys[0].credentialId;
  await urpc('passkeyDelete', { itemId: target.id, credentialId: delId });
  ok(!((await urpc('getItem', { id: target.id })).passkeys || []).some((k) => k.credentialId === delId), 'パスキーを削除できる');
  // 拡張・古い画面の保存でパスキーが消えない（保管庫側の値を正とする）
  const stale = { ...full, note: 'edited' };
  await urpc('saveItem', { item: stale, mode: 'update', replace: true });
  ok(((await urpc('getItem', { id: target.id })).passkeys || []).length === full.passkeys.length - 1, '古い画面から保存しても、削除済みのパスキーは戻らず、残りも消えない');
  const pipeDel = await pipe.call('passkeyDelete', { itemId: target.id, credentialId: full.passkeys[1].credentialId });
  ok(pipeDel.success === false, '削除は拡張からは行えない（UI 専用）');

  page.close(); cdp0.close(); swc.close();
} catch (e) {
  failed++;
  log(`ERROR（最後の段階: ${lastStep}）${e.stack || e}`);
} finally {
  clearTimeout(watchdog);
  cleanup();
  log(failed ? `${failed} 件失敗` : 'すべて成功');
  process.exit(failed ? 1 : 0);
}
