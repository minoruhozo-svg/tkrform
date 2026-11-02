// プロトコル（§9）の E2E: Named Pipe と NM ホストの中継、コマンドの許可リスト、ロック通知の遅延。
//   node tools/e2e/pipe.mjs
import path from 'node:path';
import { Cdp, PipeClient, startApp, killTree, waitTarget, waitFor, tmpDir, sleep, spawnNmHost, INTERACTIVE } from './lib.mjs';

const PORT = 9334;
const dataDir = tmpDir('tk-pipe-');
const app = startApp({ dataDir, cdpPort: PORT });
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failed++; };
const MP = 'pipe-test-correct-horse-battery-1234';
const ORIGIN = 'chrome-extension://peloncdiaianimbhoficpdcpiooldofd/';

try {
  const t = await waitTarget(PORT, (x) => x.url.includes('setup.html'));
  const ui = await Cdp.connect(t.webSocketDebuggerUrl);
  await waitFor(() => ui.eval(`typeof rpc === 'function'`), 10000);
  await ui.eval(`rpc('setup', { mp: ${JSON.stringify(MP)}, hint: '', iterations: 100000 })`);

  const p = await PipeClient.connect();
  // 接続直後に lockState が push される
  await waitFor(() => p.events.find((e) => e.event === 'lockState'), 5000, '接続時の lockState');
  ok(p.events[0].data.locked === false, '接続直後に現在のロック状態が届く');

  const hello = await p.ok('hello', { extVersion: '0.2.0' });
  ok(hello.locked === false && !!hello.appVersion, 'hello が応答する');

  // 許可リスト: 拡張からは UI 専用コマンドを呼べない
  for (const cmd of ['exportData', 'purgeItem', 'backupNow', 'changeMp', 'setup', 'listEntries', 'importRun', 'restoreBackup']) {
    const r = await p.call(cmd, { password: 'x', ids: [], path: 'x', format: 'csv', old: 'a', new: 'b' });
    if (r.code !== 'POLICY_DENIED') { ok(false, `${cmd} は拒否されるべき（${r.code}）`); }
  }
  ok(true, 'UI 専用コマンドは POLICY_DENIED');

  // helloUnlock は拡張に許可する（解除するだけで、秘密は返さない）。UI 専用の他のコマンドは引き続き拒否
  const hu = await p.call('helloUnlock');
  ok(hu.code !== 'POLICY_DENIED' && !JSON.stringify(hu).includes('kek'), '拡張に helloUnlock を許可している（解除済みなら何もせず成功。秘密は返さない）');

  // 保存と照合
  const saved = await p.ok('saveItem', { mode: 'new', item: { type: 1, name: 'GitHub', folder: '/', url: 'https://github.com/login',
    fields: [{ name: 'login', id: 'login_field', value: 'octocat', kind: 'text', role: 'user' }, { name: 'password', id: 'password', value: 'hunter2-XYZ', kind: 'password', role: 'password' }],
    totpKey: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', submit: true } });
  ok(!!saved.id, 'saveItem(new) で保存できる');
  const m = await p.ok('match', { url: 'https://www.github.com/session' });
  ok(m.logins.length === 1 && m.logins[0].user === 'octocat' && m.logins[0].hasTotp === true, 'match が一致するログインを返す');
  ok(!JSON.stringify(m).includes('hunter2'), 'match の応答にパスワードは含まれない');
  const noMatch = await p.ok('match', { url: 'https://evil-github.com/login' });
  ok(noMatch.logins.length === 0, '似たドメインには一致しない');
  const noHttp = await p.ok('match', { url: 'http://github.com/login' });
  ok(noHttp.logins.length === 0, 'https で保存したものは http のページに出さない');

  const fill = await p.ok('getFill', { id: saved.id, url: 'https://github.com/login' });
  ok(fill.fields.find((f) => f.role === 'password').value === 'hunter2-XYZ' && fill.submit === true, 'getFill が記入情報を返す');
  const mismatch = await p.call('getFill', { id: saved.id, url: 'https://evil.example/login' });
  ok(!mismatch.success && mismatch.code === 'URL_MISMATCH', 'getFill は URL を再照合して URL_MISMATCH を返す');

  // 自動保存の判定（new / update / none）
  const c1 = await p.ok('checkSave', { url: 'https://github.com/login', user: 'octocat', password: 'hunter2-XYZ' });
  const c2 = await p.ok('checkSave', { url: 'https://github.com/login', user: 'octocat', password: 'changed-pass' });
  const c3 = await p.ok('checkSave', { url: 'https://github.com/login', user: 'someone-else', password: 'x' });
  ok(c1.action === 'none' && c2.action === 'update' && c2.id === saved.id && c3.action === 'new', 'checkSave: 同じ=none / パスワード違い=update / 別ユーザー=new');

  // パスワード更新（部分更新）→ 履歴に積まれる
  const item = await p.ok('getItem', { id: saved.id });
  const fields = item.fields.map((f) => (f.role === 'password' ? { ...f, value: 'changed-pass' } : f));
  await p.ok('saveItem', { mode: 'update', item: { id: saved.id, fields } });
  const after = await p.ok('getItem', { id: saved.id });
  ok(after.passwordHistory?.[0]?.value === 'hunter2-XYZ' && after.rev === item.rev + 1, '更新でパスワード履歴が積まれ rev が増える');

  const totp = await p.ok('totp', { id: saved.id });
  ok(/^\d{6}$/.test(totp.code) && totp.remainSec >= 1 && totp.remainSec <= 30, 'totp が 6 桁のコードを返す');

  // ベーシック認証
  await p.ok('saveItem', { mode: 'new', item: { type: 1, name: 'Intranet', url: 'https://intra.example.com/', basicAuth: true,
    fields: [{ name: 'u', value: 'bob', kind: 'text', role: 'user' }, { name: 'p', value: 'bob-pass', kind: 'password', role: 'password' }] } });
  const ba = await p.ok('getBasicAuth', { url: 'https://intra.example.com/secret' });
  ok(ba.username === 'bob' && ba.password === 'bob-pass', 'getBasicAuth が資格情報を返す');
  // 印のない（取り込んだ）ログインも、一致すれば使う。一致するログインがないサイトには返さない
  const ba2 = await p.call('getBasicAuth', { url: 'https://github.com/' });
  ok(ba2.success && ba2.data.username === 'octocat', '印のないログインも、URL が一致すればベーシック認証に使える');
  const ba3 = await p.call('getBasicAuth', { url: 'https://nomatch.example.net/' });
  ok(!ba3.success, '一致するログインがないサイトには資格情報を返さない');

  // プロフィール
  const idt = await p.ok('saveItem', { mode: 'new', item: { type: 5, name: '自宅', country: 'JP',
    groups: [{ group: 'Person', instances: [{ name: '既定', fields: { LastName: '山田', FirstName: '太郎', Email: 'taro@example.jp' } }] },
      { group: 'Address', instances: [{ name: '既定', fields: { ZipOrPostCode: '100-0001', City: '千代田区' } }] }] } });
  const mi = await p.ok('match', { url: 'https://shop.example.com/checkout' });
  ok(mi.identities.length === 1, 'match がプロフィールの一覧を返す');
  const fi = await p.ok('getIdentityFill', { id: idt.id });
  ok(fi.fields.FullName === '山田 太郎' && fi.fields.ZipOrPostCode === '100-0001', 'getIdentityFill: 平らなフィールド + 氏名の補完');

  // 検索・フォルダ・生成・設定
  const sr = await p.ok('search', { q: 'git', types: [1], limit: 10 });
  ok(sr.length === 1 && sr[0].name === 'GitHub', 'search が動く');
  const g = await p.ok('generate', { options: { length: 20, mode: 'random' } });
  ok(g.password.length === 20 && g.bits > 100, 'generate');
  const prefs = await p.ok('getPrefs');
  ok(prefs.autofill && !prefs.security && !prefs.hotkeys, 'getPrefs は拡張に必要な項目だけを返す');
  await p.ok('setPrefs', { autosave: { ...prefs.autosave, mode: 'auto' }, security: { autoLockMinutes: 1 } });
  const prefs2 = await p.ok('getPrefs');
  ok(prefs2.autosave.mode === 'auto', 'setPrefs: 自動保存の設定を変えられる');
  const full = await ui.eval(`rpc('getPrefs')`);
  ok(full.security.autoLockMinutes === 60, 'setPrefs: 拡張からセキュリティ設定は変えられない');

  // クリップボード: アプリが直接コピーし、設定秒数後に「まだ同じ値なら」消す
  await ui.eval(`rpc('getPrefs').then((p) => { p.security.clipboardClearSecs = 2; return rpc('setPrefs', { prefs: p }); })`);
  const { execSync: ex } = await import('node:child_process');
  const clip = () => ex('powershell -NoProfile -Command "Get-Clipboard -Raw"', { encoding: 'utf8' }).trim();
  await p.ok('copyItem', { id: saved.id, field: 'password' });
  await sleep(500);
  ok(clip() === 'changed-pass', 'copyItem(password) でパスワードがクリップボードに入る');
  await sleep(3200);
  ok(clip() === '', '設定した秒数後にクリップボードが消える');
  await p.ok('copyItem', { id: saved.id, field: 'user' });
  await sleep(300);
  await ex('powershell -NoProfile -Command "Set-Clipboard -Value other"');
  await ui.eval(`rpc('getPrefs').then((pp) => { pp.security.clipboardClearSecs = 30; return rpc('setPrefs', { prefs: pp }); })`);

  // ロック通知の遅延（3 秒以内）
  p.events.length = 0;
  const t0 = Date.now();
  await p.ok('lock');
  await waitFor(() => p.events.find((e) => e.event === 'lockState' && e.data.locked), 3000, 'lockState(locked)');
  ok(Date.now() - t0 < 3000, `ロックの通知が 3 秒以内に届く（${Date.now() - t0}ms）`);
  const locked = await p.call('match', { url: 'https://github.com/' });
  ok(locked.code === 'LOCKED', 'ロック中は LOCKED');
  const bad = await p.call('unlock', { password: 'nope' });
  ok(bad.code === 'BAD_PASSWORD', '誤った MP は BAD_PASSWORD');
  await p.ok('unlock', { password: MP });
  await waitFor(() => p.events.find((e) => e.event === 'lockState' && !e.data.locked), 3000);
  ok(true, '解除の通知も届く');

  // Windows のセッションロック（WM_WTSSESSION_CHANGE / WTS_SESSION_LOCK）を隠しウィンドウへ送り、ロックされることを確認する
  p.events.length = 0;
  const ps = [
    `Add-Type -Namespace T -Name W -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern System.IntPtr FindWindowW(string c, string n); [DllImport("user32.dll")] public static extern System.IntPtr SendMessageW(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'`,
    `$h = [T.W]::FindWindowW('TkrformEventSink-e2e', [NullString]::Value)`,
    `if ($h -eq [System.IntPtr]::Zero) { exit 3 }`,
    `[void][T.W]::SendMessageW($h, 0x02B1, [System.IntPtr]7, [System.IntPtr]::Zero)`,
  ].join('; ');
  const t1 = Date.now();
  const { spawnSync } = await import('node:child_process');
  const sr2 = spawnSync('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8' });
  if (sr2.status !== 0) console.log('powershell:', sr2.status, sr2.stdout, sr2.stderr.slice(0, 500));
  ok(sr2.status === 0, 'セッションロック通知の送信先（隠しウィンドウ）が存在する');
  await waitFor(() => p.events.find((e) => e.event === 'lockState' && e.data.locked), 3000, 'セッションロックによる自動ロック');
  ok(Date.now() - t1 < 3000, `Windows のロック通知で自動ロックされ、拡張へ 3 秒以内に伝わる（${Date.now() - t1}ms）`);
  await p.ok('unlock', { password: MP });

  // グローバルホットキー: 実際のキー入力（SendKeys）を前面のアプリへ送るため、TKRFORM_E2E_INTERACTIVE=1 のときだけ確認する
  if (INTERACTIVE) {
    // グローバルホットキー（利用者の tkrform と衝突しないキーに変えて、実際にキー入力を送る）
    await p.ok('unlock', { password: MP }).catch(() => {});
    await ui.eval(`rpc('getPrefs').then((pp) => { pp.hotkeys.lock = 'Ctrl+Alt+Shift+F9'; return rpc('setPrefs', { prefs: pp }); })`);
    p.events.length = 0;
    const hk = spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^%+{F9}')`], { encoding: 'utf8' });
    const gotLock = await waitFor(() => p.events.find((e) => e.event === 'lockState' && e.data.locked), 4000, 'ホットキーでロック').catch(() => null);
    ok(!!gotLock, `グローバルホットキー（設定で変更したキー）でロックされる ${hk.status}`);
    await p.ok('unlock', { password: MP });
  } else console.log('SKIP  グローバルホットキー（実キー入力）: TKRFORM_E2E_INTERACTIVE=1 のときだけ');

  // 受け入れ基準: items/*.tki を 1 バイト改変すると、そのアイテムだけが「破損」になり、他は読める
  await p.ok('lock');
  const fsm = await import('node:fs');
  const tki = path.join(dataDir, 'main', 'items', `${saved.id}.tki`);
  const raw = fsm.readFileSync(tki);
  raw[raw.length - 3] ^= 0x01;
  fsm.writeFileSync(tki, raw);
  await p.ok('unlock', { password: MP });
  const entries = await ui.eval(`rpc('listEntries')`);
  const corruptOnes = entries.filter((e) => e.corrupt);
  ok(corruptOnes.length === 1 && corruptOnes[0].id === saved.id && entries.length >= 3, '1 バイト改変すると、そのアイテムだけが「破損」と表示される');
  const badGet = await p.call('getItem', { id: saved.id });
  const goodGet = await p.call('getItem', { id: idt.id });
  ok(!badGet.success && goodGet.success, '破損したアイテムは読めず、他のアイテムは読める');

  // 他製品からのインポート（アプリ経由: プレビュー → 取り込み）
  {
    const lp = path.join(dataDir, '..', 'lastpass.csv');
    const kp = path.join(dataDir, '..', 'keeper.csv');
    fsm.writeFileSync(lp, 'url,username,password,totp,extra,name,grouping,fav\nhttps://lp.example.org,lpuser,lppw,,extra,LP Site,Work,1\nhttp://sn,,,,secret body,LP Note,Work,0\n');
    fsm.writeFileSync(kp, 'Biz,Keeper Site,kuser,kpw,https://keeper.example.net,kn\n');
    const pv1 = await ui.eval(`rpc('importPreview', { path: ${JSON.stringify(lp)} })`);
    ok(pv1.format === 'lastpass' && pv1.rowCount === 2, 'LastPass の CSV を自動判定する');
    const r1 = await ui.eval(`rpc('importRun', { path: ${JSON.stringify(lp)}, kind: 'csv', skipDuplicates: true })`);
    ok(r1.added === 2, 'LastPass: ログインとセキュアノートを取り込む');
    const pv2 = await ui.eval(`rpc('importPreview', { path: ${JSON.stringify(kp)}, format: 'keeper' })`);
    ok(pv2.format === 'keeper' && pv2.rowCount === 1, 'Keeper（ヘッダ行なし）は形式を指定して読む');
    const r2 = await ui.eval(`rpc('importRun', { path: ${JSON.stringify(kp)}, kind: 'csv', format: 'keeper', skipDuplicates: true })`);
    const all = await ui.eval(`rpc('listEntries')`);
    ok(r2.added === 1 && all.some((e) => e.name === 'Keeper Site') && all.some((e) => e.name === 'LP Note' && e.type === 7), 'Keeper: 取り込めて、メモは種別 7 になる');
  }

  // NM ホスト（stdio）の中継と origin 検証
  const nm = spawnNmHost(ORIGIN);
  nm.send({ id: 5, cmd: 'hello', args: {} });
  const r5 = await nm.nextWhere((m) => m.id === 5);
  ok(r5.success && r5.data.locked === false, 'NM ホスト経由で hello が通る');
  nm.send({ id: 6, cmd: 'match', args: { url: 'https://intra.example.com/' } });
  const r6 = await nm.nextWhere((m) => m.id === 6);
  ok(r6.success && r6.data.logins.length === 1, 'NM ホスト経由で match が通る ' + JSON.stringify(r6).slice(0, 200));
  await p.ok('lock');
  const ev = await nm.nextWhere((m) => m.event === 'lockState' && m.data.locked, 3000);
  ok(!!ev, 'ロックのプッシュが NM ホスト経由でブラウザ側へ届く');
  nm.child.kill();

  const bad1 = spawnNmHost('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/');
  const code = await new Promise((res) => bad1.child.on('exit', res));
  ok(code === 1, '許可されていない origin の NM 呼び出しは拒否（終了コード 1）');
  p.close(); ui.close();
} catch (e) {
  failed++;
  console.log('ERROR', e.stack || e);
} finally {
  killTree(app.child);
  console.log(failed ? `${failed} 件失敗` : 'すべて成功');
  process.exit(failed ? 1 : 0);
}
