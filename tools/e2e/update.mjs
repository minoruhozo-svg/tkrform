// 自動更新（§10.5）の E2E: 同意なしにダウンロードしない、SHA-256 の照合、不一致なら実行しない。
// インストーラは実行せず、実行するはずだったパスを記録する（TKRFORM_UPDATE_DRYRUN）。
//   node tools/e2e/update.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, startApp, killTree, waitTarget, waitFor, tmpDir, sleep } from './lib.mjs';

const WEB = 8793;
const EXE = Buffer.from('MZ-fake-installer-' + 'x'.repeat(5000));
const GOOD = crypto.createHash('sha256').update(EXE).digest('hex');
let manifest = { version: '0.3.0', url: `http://127.0.0.1:${WEB}/tkrform-setup-9.9.9.exe`, sha256: GOOD, notes: '修正と改善' };
let exeHits = 0;
let manifestHits = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/latest.json') { manifestHits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(manifest)); return; }
  if (req.url.endsWith('.exe')) { exeHits++; res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(EXE); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(WEB, '127.0.0.1', r));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };
const apps = [];

async function launch(name, port, answer, enable = false) {
  const dataDir = tmpDir(`tk-upd-${name}-`);
  const app = startApp({ dataDir, cdpPort: port, env: { TKRFORM_PIPE_SUFFIX: `e2e-upd-${name}`, TKRFORM_UPDATE_URL: `http://127.0.0.1:${WEB}/latest.json`, TKRFORM_UPDATE_ANSWER: answer, TKRFORM_UPDATE_DRYRUN: '1' } });
  apps.push(app);
  const t = await waitTarget(port, (x) => x.url.includes('setup.html'));
  const ui = await Cdp.connect(t.webSocketDebuggerUrl);
  await waitFor(() => ui.eval(`typeof rpc === 'function'`), 10000);
  const rpc = (cmd, args = {}) => ui.eval(`rpc(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }))`);
  if (enable) {
    // 更新の確認は、既定ではオフ。自動確認を試すときだけ、設定でオンにする
    const g = await rpc('getPrefs');
    g.r.general.checkUpdates = true;
    const s = await rpc('setPrefs', { prefs: g.r });
    if (!s.ok) throw new Error('setPrefs: ' + JSON.stringify(s.e));
  }
  return { dataDir, rpc };
}

try {
  // ---- 既定（オフ）: 起動後の自動確認で通信しない。手動の「今すぐ確認」は、押したときだけ通信する
  const off = await launch('off', 9347, 'no');
  const p0 = await off.rpc('getPrefs');
  ok(p0.ok && p0.r.general.checkUpdates === false, '更新の確認は、初期設定でオフ');
  await sleep(5000); // 起動 3 秒後に、自動確認が走るはずの時間
  ok(manifestHits === 0, `オフのときは、自動では一切通信しない（latest.json への要求 ${manifestHits} 回）`);
  const manual = await off.rpc('updateCheck');
  ok(manual.ok && manifestHits === 1, `手動の「今すぐ確認」は、オフでも、押したときだけ通信する（${manifestHits} 回）`);
  killTree(apps[0].child);
  manifestHits = 0;

  // ---- 同意しない場合
  const no = await launch('no', 9345, 'no', true);
  let r = await no.rpc('updateCheck');
  ok(r.ok && r.r.available === false, '同じ版（0.3.0）なら「更新なし」');
  manifest = { ...manifest, version: '9.9.9' };
  await sleep(4500); // 起動 3 秒後の自動確認が走る（同意なしなので何も起きない）
  r = await no.rpc('updateCheck');
  ok(r.ok && r.r.available === true && r.r.version === '9.9.9' && r.r.notes === '修正と改善', '新しい版（9.9.9）を検出し、更新内容を取得');
  r = await no.rpc('updateInstall');
  ok(!r.ok && r.e.message.includes('キャンセル'), '同意しなければ更新しない');
  ok(exeHits === 0, '同意しなければインストーラをダウンロードしない（ダウンロード 0 回）');
  killTree(apps[1].child);

  // ---- 同意する場合
  const yes = await launch('yes', 9346, 'yes', true);
  await sleep(4500); // 自動確認で同意 → ダウンロード → 照合 → 実行記録
  const rec = path.join(yes.dataDir, '..', path.basename(yes.dataDir), 'update-run.txt');
  await waitFor(() => fs.existsSync(rec), 10000, '更新の実行記録');
  const runPath = fs.readFileSync(rec, 'utf8');
  ok(exeHits === 1 && runPath.endsWith('tkrform-setup-9.9.9.exe'), `同意後にダウンロードし、照合済みのインストーラを実行（ダウンロード ${exeHits} 回）`);
  ok(crypto.createHash('sha256').update(fs.readFileSync(runPath)).digest('hex') === GOOD, '実行するファイルの SHA-256 が情報どおり');
  fs.writeFileSync(rec, '');
  // SHA-256 が一致しない場合は実行しない
  manifest = { ...manifest, sha256: 'a'.repeat(64) };
  const bad = await yes.rpc('updateInstall');
  ok(!bad.ok && bad.e.message.includes('SHA-256'), '別の SHA-256 では拒否される');
  ok(fs.readFileSync(rec, 'utf8') === '', '不一致なら実行されない');
  ok(!fs.existsSync(runPath), '不一致のファイルは片付けられる');
  // 不正な情報
  manifest = { ...manifest, url: 'http://evil.example.com/setup.exe' };
  const evil = await yes.rpc('updateCheck');
  ok(!evil.ok, '外部の http の URL は受け付けない');
} catch (e) {
  failed++;
  console.log('ERROR', e.stack || e);
} finally {
  for (const a of apps) killTree(a.child);
  server.close();
  console.log(failed ? `${failed} 件失敗` : 'すべて成功');
  process.exit(failed ? 1 : 0);
}
