// 同期サーバ（server/sync.php）の API テスト。PHP の組み込みサーバで動かす。
//   node tools/e2e/sync.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sleep, waitFor, tmpDir } from './lib.mjs';

const PORT = 8790;
const docroot = tmpDir('tk-php-');
fs.copyFileSync(path.join(ROOT, 'server', 'sync.php'), path.join(docroot, 'sync.php'));
const php = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', docroot], { stdio: 'ignore' });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };
const post = async (action, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/sync.php?action=${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const b64 = (n) => Buffer.alloc(n, 7).toString('base64');

try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/sync.php`)).status === 405, 10000, 'PHP サーバ');
  ok(true, 'GET は 405 + JSON エラー');
  const e = 'user@example.jp';
  const pre = await post('prelogin', { email: e });
  ok(pre.json.success && pre.json.salt && pre.json.iter === 600000, '未登録でも prelogin が偽の salt を返す');
  const pre2 = await post('prelogin', { email: e });
  ok(pre.json.salt === pre2.json.salt, '偽の salt は決定的');

  const reg = await post('register', { email: e, authHash: b64(32), salt: b64(16), iter: 600000, wrappedVaultKey: b64(60) });
  ok(reg.json.success && /^[0-9a-f]{64}$/.test(reg.json.token), 'register でトークンを得る');
  const dup = await post('register', { email: e, authHash: b64(32), salt: b64(16), iter: 600000, wrappedVaultKey: b64(60) });
  ok(!dup.json.success && dup.json.message.includes('既に'), '二重登録はエラー（日本語メッセージ）');
  const bad = await post('register', { email: 'bad', authHash: b64(32), salt: b64(16), iter: 600000, wrappedVaultKey: b64(60) });
  ok(!bad.json.success, '不正なメールアドレスは拒否');
  const badIter = await post('register', { email: 'x@example.jp', authHash: b64(32), salt: b64(16), iter: 10, wrappedVaultKey: b64(60) });
  ok(!badIter.json.success, '範囲外の反復回数は拒否');

  const pre3 = await post('prelogin', { email: e });
  ok(pre3.json.salt === b64(16), '登録後は本物の salt を返す');
  const lg = await post('login', { email: e, authHash: b64(32) });
  ok(lg.json.success && lg.json.wrappedVaultKey === b64(60), 'login で wrappedVaultKey を得る');
  const lgBad = await post('login', { email: e, authHash: b64(31) });
  ok(!lgBad.json.success && lgBad.json.message.includes('違います'), '誤った authHash は拒否');
  const token = lg.json.token;

  const items = [{ id: 'a1', rev: 1, blob: 'QkxPQi1B', deleted: false }, { id: 'b2', rev: 1, blob: 'QkxPQi1C', deleted: false }];
  const p1 = await post('push', { token, baseRev: 0, items });
  ok(p1.json.success && p1.json.headRev === 2 && p1.json.conflicts.length === 0, 'push が成功し headRev が進む');
  const pl = await post('pull', { token, sinceRev: 0 });
  ok(pl.json.items.length === 2 && pl.json.headRev === 2, 'pull で全件を取得');
  const pl2 = await post('pull', { token, sinceRev: 1 });
  ok(pl2.json.items.length === 1 && pl2.json.items[0].id === 'b2', 'pull(sinceRev) は差分だけ');

  // 競合: 別の端末が a1 を更新（rev 3）した後、古い baseRev=0 で a1 を push → conflicts
  await post('push', { token, baseRev: 2, items: [{ id: 'a1', rev: 2, blob: 'bmV3', deleted: false }] });
  const cf = await post('push', { token, baseRev: 0, items: [{ id: 'a1', rev: 2, blob: 'b2xk', deleted: false }, { id: 'c3', rev: 1, blob: 'Qw==', deleted: false }] });
  ok(cf.json.success && cf.json.conflicts.join() === 'a1', '古い baseRev での更新は conflicts に返る（新規 c3 は受理）');
  const del = await post('push', { token, baseRev: 4, items: [{ id: 'b2', rev: 2, blob: '', deleted: true }] });
  const pl3 = await post('pull', { token, sinceRev: 4 });
  ok(del.json.success && pl3.json.items.some((i) => i.id === 'b2' && i.deleted), '削除は墓石として同期される');
  const huge = await post('push', { token, baseRev: 0, items: [{ id: '../x', blob: 'x' }] });
  ok(!huge.json.success, '不正な ID は拒否');

  const noTok = await post('pull', { token: 'zz', sinceRev: 0 });
  ok(!noTok.json.success, '無効なトークンは拒否');

  // 認証情報の変更 → 古いトークンは失効、新しい authHash でログイン
  const lg2 = await post('login', { email: e, authHash: b64(32) });
  const ch = await post('changeAuth', { token, newAuthHash: b64(33), newSalt: b64(16), newIter: 700000, newWrappedVaultKey: b64(60) });
  ok(ch.json.success, 'changeAuth');
  const old = await post('pull', { token: lg2.json.token, sinceRev: 0 });
  ok(!old.json.success, 'changeAuth 後、ほかのトークンは失効する');
  const lg3 = await post('login', { email: e, authHash: b64(33) });
  ok(lg3.json.success && lg3.json.iter === 700000, '新しい認証情報でログインできる');
  await post('logout', { token: lg3.json.token });
  const after = await post('pull', { token: lg3.json.token, sinceRev: 0 });
  ok(!after.json.success, 'logout でトークンが無効になる');

  // レート制限（1 分 10 回）
  let limited = false;
  for (let i = 0; i < 14; i++) { const r = await post('prelogin', { email: 'rate@example.jp' }); if (r.status === 429) limited = true; }
  ok(limited, '同じメールへの連続リクエストは 429 で制限される');
  ok(fs.existsSync(path.join(docroot, 'data', '.htaccess')), 'data/.htaccess が作られる（外部から読めない）');
} catch (err) {
  failed++;
  console.log('ERROR', err.stack || err);
} finally {
  php.kill();
  await sleep(200);
  console.log(failed ? `${failed} 件失敗` : 'すべて成功');
  process.exit(failed ? 1 : 0);
}
