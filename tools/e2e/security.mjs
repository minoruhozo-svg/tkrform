// セキュリティセンター（§13）の E2E: 検査結果、スコア、タブ表示（件数・切り替え・0 件・グループ・最初のタブ・キー操作）、
// 漏洩チェックの同意画面と k-匿名性（モックの HIBP サーバ）。
//   node tools/e2e/security.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { Cdp, startApp, killTree, waitTarget, waitFor, tmpDir, sleep } from './lib.mjs';

const PORT = 9344;
const HIBP = 8792;
const dataDir = tmpDir('tk-sec-');
const shots = path.join(dataDir, '..', 'shots-sec');
import('node:fs').then((fs) => fs.mkdirSync(shots, { recursive: true }));
const received = [];
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex').toUpperCase();
const LEAKED = 'password123';
const server = http.createServer((req, res) => {
  const prefix = req.url.split('/').pop();
  received.push({ prefix, padding: req.headers['add-padding'] });
  const h = sha1(LEAKED);
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(h.startsWith(prefix.toUpperCase()) ? `${h.slice(5)}:4242\r\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0\r\n` : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0\r\n');
});
await new Promise((r) => server.listen(HIBP, '127.0.0.1', r));
const app = startApp({ dataDir, cdpPort: PORT, env: { TKRFORM_PIPE_SUFFIX: 'e2e-sec', TKRFORM_HIBP_URL: `http://127.0.0.1:${HIBP}/range/` } });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };
const MP = 'security-test-correct-horse-battery-8080';

try {
  const t = await waitTarget(PORT, (x) => x.url.includes('setup.html'));
  const ui = await Cdp.connect(t.webSocketDebuggerUrl);
  await waitFor(() => ui.eval(`typeof rpc === 'function'`), 10000);
  const rpc = (cmd, args = {}) => ui.eval(`rpc(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }))`);
  const must = async (cmd, args) => { const x = await rpc(cmd, args); if (!x.ok) throw new Error(`${cmd}: ${x.e.message}`); return x.r; };
  await must('setup', { mp: MP, hint: '', iterations: 100000 });
  const strong = 'Xk9#mQ2$vLp7!wRz-8Tn';
  const add = (name, url, user, pw, extra = {}) => must('saveItem', { mode: 'new', item: { type: 1, name, folder: '/', url, fields: [{ name: 'u', value: user, kind: 'text', role: 'user' }, { name: 'p', value: pw, kind: 'password', role: 'password' }], ...extra } });

  // ---- タブ: ログインが 1 件もないとき（すべて 0 件）は、「弱い」を開く
  await must('openWindow', { name: 'security' });
  const st = await waitTarget(PORT, (x) => x.url.includes('security.html'));
  const sec = await Cdp.connect(st.webSocketDebuggerUrl);
  const tabInfo = () => sec.eval(`JSON.stringify([...document.querySelectorAll('#tabs [role=tab]')].map((b) => ({ id: b.id.slice(4), text: b.textContent, sel: b.getAttribute('aria-selected') === 'true', ti: b.tabIndex })))`).then(JSON.parse);
  const selTab = async () => (await tabInfo()).find((x) => x.sel)?.id;
  const visiblePanels = () => sec.eval(`JSON.stringify([...document.querySelectorAll('[role=tabpanel]')].filter((x) => !x.classList.contains('hidden')).map((x) => x.id))`).then(JSON.parse);
  const text = (sel) => sec.eval(`document.querySelector(${JSON.stringify(sel)}).textContent`);
  const count = (sel) => sec.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  await waitFor(() => sec.eval(`document.querySelectorAll('#tabs [role=tab]').length === 5 && !!document.querySelector('#panel-weak .body').firstChild`), 10000, 'セキュリティ画面（空）');
  let tabs = await tabInfo();
  ok(tabs.map((x) => x.id).join() === 'weak,reused,old,dups,breach' && tabs.map((x) => x.text.replace(/\s*\(.*\)$/, '')).join() === '弱い,使い回し,古い,重複,漏洩', 'タブは「弱い・使い回し・古い・重複・漏洩」の順に並ぶ');
  ok(tabs.slice(0, 4).every((x) => /\(0\)$/.test(x.text)) && /\(オフ\)$/.test(tabs[4].text), 'ログインがないときは件数が 0、漏洩は件数の代わりに「オフ」と出る');
  ok((await selTab()) === 'weak', 'すべて 0 件なら、最初に開くタブは「弱い」');
  ok((await text('#panel-weak .body')).includes('問題は見つかりませんでした'), '0 件のタブは「問題は見つかりませんでした」と出る（タブ自体は出したまま）');

  // ---- 重複だけを入れて開き直す → 件数が 1 以上の最初のタブ（重複）を開く
  await add('重複1', 'https://dup.example.com/login', 'same', 'Rt5$hG9&mC3*jL7^vN');
  await add('重複2', 'https://www.dup.example.com/login', 'same', 'Zx3@cV7#bN1$mQ5^wE');
  await sec.eval('location.reload()');
  await waitFor(() => sec.eval(`document.querySelectorAll('#tabs [role=tab]').length === 5 && document.querySelectorAll('#panel-dups .rows li').length > 0`), 10000, 'セキュリティ画面（重複のみ）');
  ok((await selTab()) === 'dups', '件数が 1 以上の最初のタブ（ここでは「重複」）を、最初に開く');
  ok(/\(2\)$/.test((await tabInfo()).find((x) => x.id === 'dups').text), 'タブに件数が付く（重複 (2)）');
  ok((await count('#panel-dups .grp')) === 1 && (await text('#panel-dups .grp-title')).includes('2 件'), '重複は、重複しているものごとにまとめ、見出しに件数を出す');
  ok((await text('#panel-dups .sub')).includes('URL とユーザー ID が同じ'), 'タブの先頭に、条件の説明文がある');

  // ---- 残りのログインを入れる
  const weak = await add('弱い', 'https://weak.example.com', 'u', 'abc123');
  await add('使い回し1', 'https://r1.example.com', 'u', strong);
  await add('使い回し2', 'https://r2.example.com', 'u', strong);
  await add('古い', 'https://old.example.com', 'u', 'Qw8!zT4#nB6@kP1%xY', { created: new Date(Date.now() - 400 * 864e5).toISOString() });
  const leaked = await add('漏洩', 'https://leak.example.com', 'u', LEAKED);

  const rep = await must('securityReport');
  ok(rep.total === 7, `パスワードを持つログイン 7 件を調べる（${rep.total}）`);
  ok(rep.weak.some((r) => r.id === weak.id) && rep.weak.length >= 1, '弱いパスワードを検出');
  ok(rep.reused.length === 1 && rep.reused[0].length === 2, '使い回しを検出（2 件のグループ）');
  ok(rep.old.length === 1 && rep.old[0].name === '古い' && /^\d{4}-\d{2}-\d{2}$/.test(rep.old[0].changed), '365 日以上変更のないパスワードを検出（変更した日つき）');
  ok(rep.duplicates.length === 1 && rep.duplicates[0].length === 2, 'URL とユーザー ID が同じ重複を検出（www. を無視）');
  ok(rep.score > 0 && rep.score < 100, `総合スコア 0〜100（${rep.score}）`);
  ok(!JSON.stringify(rep).includes(strong) && !JSON.stringify(rep).includes('abc123'), '検査結果にパスワードは含まれない');

  // ---- 開いたままの画面を更新: 件数が変わっても、選んでいるタブは保たれる
  await sec.click('#rescan');
  await waitFor(() => sec.eval(`document.querySelectorAll('#panel-weak .rows li').length > 0`), 10000, '再検査');
  tabs = await tabInfo();
  const num = (id) => Number((tabs.find((x) => x.id === id).text.match(/\((\d+)\)$/) || [])[1]);
  ok(num('weak') === rep.weak.length && num('reused') === 2 && num('old') === 1 && num('dups') === 2, `再検査で件数が更新される（${tabs.map((x) => x.text).join(' | ')}）`);
  ok((await selTab()) === 'dups', '再検査しても、選んでいるタブは保たれる');

  // ---- タブの切り替え・グループ表示・説明文
  await sec.click('#tab-reused');
  ok((await selTab()) === 'reused' && (await visiblePanels()).join() === 'panel-reused', 'タブを押すと、そのタブの内容だけを表示する');
  ok((await count('#panel-reused .grp')) === 1 && (await count('#panel-reused .grp li')) === 2 && (await text('#panel-reused .grp-title')).includes('2 件'), '使い回しは、同じパスワードのログインごとにまとめ、見出しに件数を出す');
  ok((await text('#panel-reused .sub')).includes('同じパスワード'), '使い回しのタブの先頭に、条件の説明文がある');
  await sec.click('#tab-old');
  const oldRow = await text('#panel-old .rows li');
  ok(oldRow.includes('古い') && /変更: \d{4}-\d{2}-\d{2}/.test(oldRow), '古いタブには、パスワードを変更した日が出る');
  ok(await sec.eval(`!!document.querySelector('#panel-old .rows li .av') && [...document.querySelectorAll('#panel-old .rows li button.primary')].every((b) => b.textContent === 'パスワードを変える') && !!document.querySelector('#panel-old .rows li .pill')`), '行に、頭文字・理由の chip・色つきの「パスワードを変える」がある');
  ok(/あと \d+ 件/.test(await text('#score-hint')), '点数の横に、あと何件変えると 100 点になるかが出る');
  ok((await text('#panel-old .sub')).includes('365 日'), '古いタブの先頭に、条件（365 日以上）の説明文がある');
  await sec.click('#tab-weak');
  ok((await text('#panel-weak .sub')).includes('50 ビット未満'), '弱いタブの先頭に、条件（50 ビット未満）の説明文がある');

  // ---- キーボード操作
  await sec.eval(`document.querySelector('#tab-weak').focus()`);
  ok((await tabInfo()).filter((x) => x.ti === 0).map((x) => x.id).join() === 'weak', '選んでいるタブだけがキーボードの移動先（tabindex 0）になる');
  await sec.press('ArrowRight', 'ArrowRight', 39);
  ok((await selTab()) === 'reused' && (await sec.eval(`document.activeElement.id`)) === 'tab-reused', '→ キーで次のタブへ移る');
  await sec.press('ArrowLeft', 'ArrowLeft', 37);
  await sec.press('ArrowLeft', 'ArrowLeft', 37);
  ok((await selTab()) === 'breach', '← キーで前のタブへ移る（先頭からは末尾へ回る）');
  ok((await sec.eval(`document.querySelector('#tabs').getAttribute('role')`)) === 'tablist' && (await sec.eval(`document.querySelector('#panel-breach').getAttribute('aria-labelledby')`)) === 'tab-breach' && (await sec.eval(`document.querySelector('#panel-breach').getAttribute('role')`)) === 'tabpanel', 'role の tablist / tab / tabpanel が付いている');
  ok((await text('#breach-state')).includes('オフ') && (await count('#breach-enable')) === 1, '漏洩のタブの中で、有効にする方法（同意の画面へ進むボタン）を案内する');
  await sec.screenshot(path.join(shots, 'security.png'));

  // 既定オフ: 同意前は呼べず、何も送られない
  const prefs = await must('getPrefs');
  ok(prefs.security.breachCheck === false, '漏洩チェックは既定でオフ');
  const denied = await rpc('breachCheck');
  ok(!denied.ok && denied.e.code === 'POLICY_DENIED' && received.length === 0, '同意前は POLICY_DENIED で、サーバへは何も送られない');

  // UI: オンにするときに同意画面を出す
  await sec.click('#breach-enable');
  await waitFor(() => sec.eval(`!!document.querySelector('dialog[open]')`), 3000, '同意ダイアログ');
  const body = await sec.eval(`document.querySelector('dialog[open]').textContent`);
  ok(body.includes('先頭 5 文字') && body.includes('api.pwnedpasswords.com'), '同意画面で、送る内容（先頭 5 文字のみ）と通信先を説明している');
  await sec.screenshot(path.join(shots, 'consent.png'));
  await sec.eval(`document.querySelector('dialog[open] #dlg-cancel').click()`);
  await sleep(300);
  ok((await must('getPrefs')).security.breachCheck === false, '同意しなければオンにならない');
  await sec.click('#breach-enable');
  await waitFor(() => sec.eval(`!!document.querySelector('dialog[open]')`), 3000);
  await sec.eval(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === '同意して有効にする').click()`);
  await waitFor(() => sec.eval(`!!document.querySelector('#breach-run')`), 5000, '有効化');
  const p2 = await must('getPrefs');
  ok(p2.security.breachCheck === true && !!p2.security.breachConsent, '同意するとオンになり、同意日時が記録される');
  tabs = await tabInfo();
  ok(/\(–\)$/.test(tabs.find((x) => x.id === 'breach').text), '有効にしたあと、確認するまでの漏洩タブの件数は「–」');

  await sec.click('#breach-run');
  await waitFor(() => sec.eval(`document.querySelectorAll('#breach-result .rows li').length === 1`), 10000, '漏洩の結果');
  ok((await sec.eval(`document.querySelector('#breach-result .rows li').textContent`)).includes('漏洩') && (await sec.eval(`document.querySelector('#breach-result').textContent`)).includes('4242'), '漏洩が確認されたアイテムを回数つきで表示');
  ok(/\(1\)$/.test((await tabInfo()).find((x) => x.id === 'breach').text), '確認後、漏洩タブに件数が付く');
  ok(received.length > 0 && received.every((r) => /^[0-9A-F]{5}$/.test(r.prefix)), `サーバへ送ったのは SHA-1 の先頭 5 文字だけ（${received.map((r) => r.prefix).join(',')}）`);
  ok(received.every((r) => r.padding === 'true'), 'Add-Padding を付けて送る');
  ok(!received.some((r) => sha1(LEAKED).slice(5).startsWith(r.prefix)), '残りの 35 文字は送られていない');
  await sec.screenshot(path.join(shots, 'breach.png'));
  const off = await must('breachConsent', { agree: false });
  ok(off.enabled === false && (await must('getPrefs')).security.breachCheck === false, 'いつでもオフに戻せる');
  sec.close(); ui.close();
} catch (e) {
  failed++;
  console.log('ERROR', e.stack || e);
} finally {
  killTree(app.child);
  server.close();
  console.log(failed ? `${failed} 件失敗` : 'すべて成功');
  process.exit(failed ? 1 : 0);
}
