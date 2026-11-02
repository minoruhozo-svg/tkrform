// バックアップの保存先の変更（設定の「バックアップ」タブ）の E2E。
//   node tools/e2e/backup-dir.mjs
// 保存先を変える → 今すぐバックアップ → 新しい保存先にできる → 復元の一覧に出る。
// 世代の整理は規則に合う名前のファイルだけ、保存先に書けないときは黙って既定に切り替えない、設定の「保存」で保存先が戻らない。
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, startApp, killTree, waitTarget, waitFor, tmpDir, sleep } from './lib.mjs';

const PORT = 9363;
const dataDir = tmpDir('tk-bkdir-');
const target = tmpDir('tk-bkdest-');
const target2 = tmpDir('tk-bkdest2-');
const app = startApp({ dataDir, cdpPort: PORT, env: { TKRFORM_PIPE_SUFFIX: 'e2ebk', TKRFORM_PICK_FOLDER: target2 } });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };
const MP = 'backup-dir-correct-horse-battery-5151';
const tkbs = (d) => fs.readdirSync(d).filter((n) => /^\d{8}-\d{6}(-\d+)?\.tkb$/.test(n));

try {
  const t = await waitTarget(PORT, (x) => x.url.includes('setup.html'));
  const ui = await Cdp.connect(t.webSocketDebuggerUrl);
  await waitFor(() => ui.eval(`typeof rpc === 'function'`), 10000);
  const rpc = (cmd, args = {}) => ui.eval(`rpc(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: e.message }))`);
  const must = async (cmd, args) => { const x = await rpc(cmd, args); if (!x.ok) throw new Error(`${cmd}: ${x.e}`); return x.r; };
  await must('setup', { mp: MP, hint: '', iterations: 100000 });
  const vaultDir = path.join(dataDir, 'main');
  await must('saveItem', { mode: 'new', item: { type: 1, name: 'BackupTest', folder: '/', url: 'https://bk.example.com', fields: [] } });

  // 既定の保存先
  let st = await must('backupStatus');
  ok(st.isDefault && st.dir === path.join(vaultDir, 'backups') && !st.lastError, '既定では、保管庫のフォルダの backups が保存先');
  const r0 = await must('backupNow');
  ok(path.dirname(r0.path) === path.join(vaultDir, 'backups') && fs.existsSync(r0.path), '今すぐバックアップは既定の保存先に作る');

  // 保存先を変える: 検証
  const bad1 = await rpc('backupSetDir', { dir: path.join(vaultDir, 'items') });
  ok(!bad1.ok && /保管庫のフォルダ/.test(bad1.e), '保管庫のフォルダの中は保存先にできない');
  const bad2 = await rpc('backupSetDir', { dir: path.join(target, 'no-such-folder') });
  ok(!bad2.ok && /見つかりません/.test(bad2.e), '存在しないフォルダは保存先にできない');
  const bad3 = await rpc('backupSetDir', { dir: 'relative\\dir' });
  ok(!bad3.ok, '相対パスは保存先にできない');
  ok(fs.readdirSync(target).length === 0, '検証の試し書きの一時ファイルは残らない');
  ok((await must('backupStatus')).isDefault, '拒否したときは、保存先は変わらない');

  // 変更 → バックアップ
  await must('backupSetDir', { dir: target });
  st = await must('backupStatus');
  ok(!st.isDefault && st.dir === target, '保存先を変更できる');
  ok(st.previous.some((p) => p.dir === path.join(vaultDir, 'backups') && p.count >= 1), '以前の保存先に残っているバックアップの件数が出る（移動も削除もしない）');
  ok(tkbs(path.join(vaultDir, 'backups')).includes(path.basename(r0.path)), '古い保存先のバックアップは、そのまま残る');
  const r1 = await must('backupNow');
  ok(path.dirname(r1.path) === target && fs.existsSync(r1.path), '今すぐバックアップは、新しい保存先に作る');
  ok(tkbs(path.join(vaultDir, 'backups')).length === 1, '既定の保存先には増えない');

  // 復元の一覧: 今の保存先と既定の保存先の両方
  const list = await must('listBackups');
  ok(list.some((b) => b.location === 'current' && b.dir === target) && list.some((b) => b.location === 'default'), '復元の一覧に、今の保存先と既定の保存先の両方が出る（場所つき）');

  // 世代の整理: 規則に合うファイルだけ
  const prefs = await must('getPrefs');
  prefs.backup.generations = 1;
  await must('setPrefs', { prefs });
  fs.writeFileSync(path.join(target, 'report.txt'), 'keep');
  fs.writeFileSync(path.join(target, 'my-20200101-000000.tkb'), 'keep');
  fs.mkdirSync(path.join(target, 'sub'));
  fs.writeFileSync(path.join(target, 'sub', '20190101-000000.tkb'), 'keep');
  fs.writeFileSync(path.join(target, '20200101-000000.tkb'), 'old');
  await must('backupNow');
  ok(tkbs(target).length === 1, '世代の整理は、規則に合う名前のバックアップだけが対象（1 世代に整理）');
  ok(fs.existsSync(path.join(target, 'report.txt')) && fs.existsSync(path.join(target, 'my-20200101-000000.tkb')) && fs.existsSync(path.join(target, 'sub', '20190101-000000.tkb')), '無関係のファイルとサブフォルダの中身は消さない');

  // 設定の「保存」で保存先が古い値に戻らない（設定画面を開いたまま、別の操作で保存先が変わる場合）
  await must('openWindow', { name: 'settings' });
  const sp = await waitTarget(PORT, (x) => x.url.includes('settings.html'));
  const sc = await Cdp.connect(sp.webSocketDebuggerUrl);
  await waitFor(() => sc.eval(`!!document.querySelector('#save') && !!document.querySelector('#bk-dir')`), 10000, '設定画面');
  await waitFor(() => sc.eval(`document.querySelector('#bk-dir').value !== ''`), 5000, '保存先の表示');
  ok((await sc.eval(`document.querySelector('#bk-dir').value`)) === target, '設定の「バックアップ」タブに、今の保存先が表示される');
  await must('backupSetDir', { dir: target2 }); // 設定画面が古い値を持ったまま、保存先が変わる
  await sc.click('#save');
  await sleep(800);
  ok((await must('backupStatus')).dir === target2, '設定画面で「保存」しても、保存先は古い値に戻らない');
  // フォルダ選択（テスト時は差し替え）で変更
  await sc.eval(`changeBackupDir(${JSON.stringify(target)})`);
  ok((await must('backupStatus')).dir === target, '画面から保存先を変更できる');

  // 保存先に書けない（ドライブ未接続を、フォルダの削除で再現）: 黙って既定に切り替えず、失敗として知らせる
  fs.rmSync(target2, { recursive: true, force: true });
  await must('backupSetDir', { dir: target });
  const gone = tmpDir('tk-bkgone-');
  await must('backupSetDir', { dir: gone });
  fs.rmSync(gone, { recursive: true, force: true });
  const fail = await rpc('backupNow');
  ok(!fail.ok, '保存先に書けないときは、今すぐバックアップが失敗する');
  st = await must('backupStatus');
  ok(st.dir === gone && !st.isDefault && !!st.lastError, '黙って既定の保存先に切り替えない。失敗が記録され、設定・エディタで知らせられる');
  ok(!fs.existsSync(gone) && tkbs(path.join(vaultDir, 'backups')).length === 1, '存在しない保存先を作り直さず、既定の保存先にも作らない');
  // 自動バックアップ（ロック解除時）の失敗も記録される
  await must('lock');
  await must('unlock', { password: MP });
  await waitFor(async () => !!(await must('backupStatus')).lastError, 8000, '自動バックアップの失敗');
  const log = fs.readFileSync(path.join(dataDir, 'logs', 'tkrform.log'), 'utf8');
  ok(/backup\.failed/.test(log), '失敗はログに残る');
  // フォルダを指定して復元: 選んだフォルダの中のバックアップを、復元の一覧に追加で出す
  const other = tmpDir('tk-bkother-');
  // 世代の整理（1 世代）で、先に作った r1 は消えていることがある。いま保存先にあるバックアップを使う
  fs.copyFileSync(path.join(target, tkbs(target)[0]), path.join(other, '20210101-010101.tkb'));
  fs.writeFileSync(path.join(other, 'memo.tkb'), 'not a backup');
  const inDir = await must('listBackupsIn', { dir: other });
  ok(inDir.length === 1 && inDir[0].name === '20210101-010101.tkb' && inDir[0].location === 'picked', '指定したフォルダの中の、tkrform のバックアップだけを一覧にできる');
  ok(!(await rpc('listBackupsIn', { dir: path.join(other, 'nope') })).ok, '存在しないフォルダはエラー');
  // ロック → 解除で設定画面は再読み込みされる（LockGuard）。作り直された画面にボタンが出るのを待ってから確認する
  await waitFor(() => sc.eval("!!document.querySelector('#bk-restore-folder') && typeof pickedBackups !== 'undefined'"), 15000, '再読み込み後の設定画面');
  ok(await sc.eval("document.querySelector('#bk-restore-folder').textContent.includes('フォルダを指定して復元')"), '「フォルダを指定して復元...」のボタンがある（バックアップのタブに表示される）');
  // フォルダ選択ダイアログは差し替え済み（TKRFORM_PICK_FOLDER）。画面の一覧への追加は、選んだ結果を渡して確認する
  await sc.eval(`pickedBackups = ${JSON.stringify(inDir)}; refreshBackups()`);
  await waitFor(() => sc.eval(`[...document.querySelectorAll('#backups li')].some((li) => li.textContent.includes('20210101-010101.tkb') && li.textContent.includes(${JSON.stringify(path.basename(other))}))`), 5000, '一覧');
  ok(true, '選んだフォルダのバックアップが、場所つきで復元の一覧に出る');
  // 既定に戻す
  await must('backupSetDir', { dir: '' });
  st = await must('backupStatus');
  ok(st.isDefault && !st.lastError, '「既定に戻す」で既定の保存先に戻り、失敗の表示も消える');
  // ---- 全初期化: マスターパスワードが合わないと消えない。消えるのは保管庫・設定など。指定した別の保存先のバックアップは残る
  await must('backupSetDir', { dir: target });
  await must('backupNow');
  const keep = tkbs(target).length;
  const keepDefault = tkbs(path.join(vaultDir, 'backups')).length;
  const noPw = await rpc('factoryReset', {});
  const wrongPw = await rpc('factoryReset', { password: 'wrong-master-password' });
  ok(!noPw.ok && !wrongPw.ok && fs.existsSync(path.join(vaultDir, 'vault.hdr')) && fs.existsSync(path.join(vaultDir, 'items')), 'マスターパスワードなし・誤りでは、全初期化できない（何も消えない）');
  const ok1 = await rpc('factoryReset', { password: MP });
  ok(ok1.ok, '正しいマスターパスワードを入力すると、全初期化が実行される');
  await sleep(1200);
  ok(!fs.existsSync(path.join(vaultDir, 'vault.hdr')) && !fs.existsSync(path.join(vaultDir, 'items')) && !fs.existsSync(path.join(vaultDir, 'preferences.json')), '保管庫・設定が消えている');
  ok(tkbs(target).length === keep && tkbs(path.join(vaultDir, 'backups')).length === keepDefault, '指定した保存先と既定の保存先のバックアップは、消えない');
  await waitTarget(PORT, (x) => x.url.includes('setup.html'), 40000);
  ok(true, '全初期化のあと、最初のセットアップ画面が開く');
  ui.close();
} catch (e) {
  failed++;
  console.log('ERROR', e.stack || e);
} finally {
  killTree(app.child);
  console.log(failed ? `${failed} 件失敗` : 'すべて成功');
  process.exit(failed ? 1 : 0);
}
