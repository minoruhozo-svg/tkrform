// デスクトップ UI の E2E: セットアップウィザード → エディタでの作成・編集・検索・ゴミ箱・ロック。
//   node tools/e2e/app-ui.mjs [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, startApp, killTree, waitTarget, waitFor, tmpDir, sleep, ROOT } from './lib.mjs';

const PORT = 9333;
const dataDir = tmpDir('tk-ui-');
const shots = path.join(dataDir, '..', 'shots');
fs.mkdirSync(shots, { recursive: true });
const app = startApp({ dataDir, cdpPort: PORT });
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failed++; };

async function page(match) {
  const t = await waitTarget(PORT, match);
  return Cdp.connect(t.webSocketDebuggerUrl);
}

try {
  // ---------------------------------------------------------- セットアップ
  const setup = await page((t) => t.url.includes('setup.html'));
  await waitFor(() => setup.eval(`document.querySelector('.step.active')?.dataset.step === '1'`), 10000, 'setup step1');
  await setup.screenshot(path.join(shots, '01-setup-welcome.png'));
  await setup.click('#next'); // → 2
  await setup.click('#next'); // → 3
  ok(await setup.eval(`document.querySelector('.step.active').dataset.step === '3'`), 'MP 入力ステップへ進める');

  // 弱いパスワードは警告される
  await setup.type('#mp1', 'abc12');
  await setup.type('#mp2', 'abc12');
  await waitFor(() => setup.eval(`!document.querySelector('#weak-row').classList.contains('hidden')`), 5000, '弱いパスワード警告');
  await setup.click('#next');
  ok(await setup.eval(`!document.querySelector('#mp-msg').classList.contains('hidden')`), '弱い MP のままでは先へ進めない');
  // 不一致
  await setup.type('#mp2', 'zzz');
  await setup.click('#next');
  ok(await setup.eval(`document.querySelector('#mp-msg').textContent.includes('一致')`), '2 回の入力が違うとエラー');

  const MP = 'correct-horse-battery-staple-7391!';
  await setup.type('#mp1', MP);
  await setup.type('#mp2', MP);
  await sleep(300);
  await setup.screenshot(path.join(shots, '02-setup-mp.png'));
  await setup.click('#next'); // → 4
  await setup.type('#hint', 'テスト用のヒント');
  await setup.click('#next'); // 作成
  await waitFor(() => setup.eval(`document.querySelector('.step.active')?.dataset.step === '5'`), 20000, '拡張の導入案内');
  ok(fs.existsSync(path.join(dataDir, 'main', 'vault.hdr')), 'vault.hdr が作られた');
  await setup.screenshot(path.join(shots, '03-setup-ext.png'));
  await setup.click('#next'); // → 6
  await setup.click('#next'); // 完了 → エディタ

  // ---------------------------------------------------------- エディタ
  const ed = await page((t) => t.url.includes('editor.html'));
  await waitFor(() => ed.eval(`!!document.querySelector('#list') && document.querySelector('#list-count').textContent.length > 0`), 10000, 'エディタ表示');
  ok(await ed.eval(`!document.querySelector('#lock-overlay')`), 'セットアップ直後はロック解除済み');

  // 新規ログイン
  await ed.click('#b-new');
  await ed.eval(`[...document.querySelectorAll('.ctxmenu button')].find(b => b.textContent === 'ログイン').click()`);
  await waitFor(() => ed.eval(`!!document.querySelector('#f-name')`), 5000, '編集フォーム');
  await ed.type('#f-name', 'GitHub');
  await ed.type('input[aria-label="URL"]', 'https://github.com/login');
  // フィールド表の値（ユーザー ID とパスワード）
  await ed.eval(`(() => { const rows = document.querySelectorAll('.fields-table tbody tr'); rows[0].querySelectorAll('input')[2].focus(); })()`);
  await ed.send('Input.insertText', { text: 'octocat' });
  await ed.eval(`document.querySelectorAll('.fields-table tbody tr')[1].querySelector('input.mono').focus()`);
  await ed.send('Input.insertText', { text: 'p@ssw0rd-TEST' });
  await sleep(200);

  // フィールドの表: 生成ボタンがない・名前と ID は狭く、値は広い・長いパスワードが欄に収まる・最小幅でも横にはみ出さない
  ok(await ed.eval(`![...document.querySelectorAll('.fields-table button')].some((b) => b.textContent === '⚙')`), 'フィールドの表のパスワード行に、⚙（パスワードを生成）ボタンがない');
  ok(await ed.eval(`[...document.querySelectorAll('.fields-table tbody tr')[1].querySelectorAll('.pwcell button')].map((b) => b.textContent).join('') === '👁⧉'`), '表示（👁）とコピー（⧉）のボタンは残っている');
  const widths = () => ed.eval(`(() => { const r = document.querySelectorAll('.fields-table tbody tr')[1]; const w = (e) => e.getBoundingClientRect().width; return { name: w(r.querySelectorAll('input')[0]), id: w(r.querySelectorAll('input')[1]), value: w(r.querySelector('input.mono')) }; })()`);
  const roomy = async (label) => { const w = await widths(); ok(w.value > w.name && w.value > w.id && w.name <= 130 && w.id <= 130, `名前・ID は狭い固定幅（130px 以下）で、値の欄のほうが広い（${label}: 名前 ${Math.round(w.name)} / ID ${Math.round(w.id)} / 値 ${Math.round(w.value)}）`); };
  await roomy('通常の幅');
  const LONG = 'Zq7#mK2$vLp9!wRz-8TnQe4Xc5Bd6A';
  await ed.eval(`document.querySelectorAll('.fields-table tbody tr')[1].querySelector('input.mono').select()`);
  await ed.send('Input.insertText', { text: LONG });
  await ed.eval(`document.querySelectorAll('.fields-table tbody tr')[1].querySelectorAll('button')[0].click()`); // 👁 で表示
  const fits = (label) => ed.eval(`(() => { const i = document.querySelectorAll('.fields-table tbody tr')[1].querySelector('input.mono'); const d = document.querySelector('#detail'); const t = document.querySelector('.fields-table'); return { type: i.type, input: i.scrollWidth <= i.clientWidth, detail: d.scrollWidth <= d.clientWidth, table: t.scrollWidth <= t.clientWidth }; })()`).then((r) => ok(r.type === 'text' && r.input && r.detail && r.table, `30 文字のパスワードを表示しても、欄からはみ出さず、横スクロールも出ない（${label}: ${JSON.stringify(r)}）`));
  await fits('通常の幅');
  await ed.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  await roomy('最小幅 900');
  await fits('最小幅 900');
  await ed.screenshot(path.join(shots, '04b-editor-fields-min.png'));
  await ed.send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);
  await ed.eval(`document.querySelectorAll('.fields-table tbody tr')[1].querySelector('input.mono').select()`);
  await ed.send('Input.insertText', { text: 'p@ssw0rd-TEST' });
  await ed.eval(`document.querySelectorAll('.fields-table tbody tr')[1].querySelectorAll('button')[0].click()`); // 👁 で隠す
  await ed.screenshot(path.join(shots, '04-editor-new-login.png'));
  ok(await ed.eval(`!document.querySelector('#f-save').disabled`), '変更があると [保存] が有効になる');
  await ed.click('#f-save');
  await waitFor(() => ed.eval(`document.querySelectorAll('.rowitem').length === 1`), 8000, '一覧に 1 件');
  ok(await ed.eval(`document.querySelector('.rowitem .name').textContent === 'GitHub'`), '保存したログインが一覧に出る');
  await sleep(300);
  await ed.screenshot(path.join(shots, '05-editor-saved.png'));

  // メモ・プロフィールの追加
  await ed.click('#b-new');
  await ed.eval(`[...document.querySelectorAll('.ctxmenu button')].find(b => b.textContent === 'メモ').click()`);
  await waitFor(() => ed.eval(`!!document.querySelector('#f-name')`));
  await ed.type('#f-name', 'ひみつのメモ');
  await ed.eval(`document.querySelector('textarea').focus()`);
  await ed.send('Input.insertText', { text: '本文です\n2行目' });
  await ed.click('#f-save');
  await waitFor(() => ed.eval(`document.querySelectorAll('.rowitem').length === 2`), 8000, 'メモ追加');

  await ed.click('#b-new');
  await ed.eval(`[...document.querySelectorAll('.ctxmenu button')].find(b => b.textContent === 'プロフィール').click()`);
  await waitFor(() => ed.eval(`!!document.querySelector('.idgrid')`), 8000, 'プロフィールフォーム');
  await ed.type('#f-name', '自宅');
  await ed.type('.idgrid input[aria-label="姓"]', '山田');
  await ed.type('.idgrid input[aria-label="名"]', '太郎');
  await ed.type('.idgrid input[aria-label="メールアドレス"]', 'taro@example.jp');
  await sleep(200);
  await ed.screenshot(path.join(shots, '06-editor-identity.png'));
  await ed.click('#f-save');
  await waitFor(() => ed.eval(`document.querySelectorAll('.rowitem').length === 3`), 8000, 'プロフィール追加');

  // 検索
  await ed.type('#q', 'git');
  await waitFor(() => ed.eval(`document.querySelectorAll('.rowitem').length === 1`), 3000, '検索で絞り込み');
  ok(true, '検索で絞り込める');
  await ed.type('#q', '');
  await waitFor(() => ed.eval(`document.querySelectorAll('.rowitem').length === 3`), 3000);

  // 削除 → ゴミ箱 → 元に戻す（Ctrl+Z の代わりにボタン）
  await ed.eval(`document.querySelectorAll('.rowitem')[0].click()`);
  await sleep(300);
  await ed.click('#b-delete');
  await waitFor(() => ed.eval(`document.querySelectorAll('.rowitem').length === 2`), 5000, '削除');
  await ed.click('#b-undo');
  await waitFor(() => ed.eval(`document.querySelectorAll('.rowitem').length === 3`), 5000, 'Undo');
  ok(true, '削除 → Undo で戻る');

  // 完全削除は確認ダイアログが出る
  await ed.eval(`document.querySelectorAll('.rowitem')[0].click()`);
  await sleep(300);
  await ed.click('#b-delete');
  await waitFor(() => ed.eval(`document.querySelectorAll('.rowitem').length === 2`));
  await ed.eval(`[...document.querySelectorAll('#views li')].find(l => l.textContent.startsWith('ゴミ箱')).click()`);
  await waitFor(() => ed.eval(`document.querySelectorAll('.rowitem').length === 1`), 5000, 'ゴミ箱表示');
  await ed.eval(`document.querySelector('.rowitem').click()`);
  await waitFor(() => ed.eval(`!![...document.querySelectorAll('#detail button')].find(b => b.textContent.startsWith('完全に削除'))`), 5000);
  await ed.eval(`[...document.querySelectorAll('#detail button')].find(b => b.textContent.startsWith('完全に削除')).click()`);
  await waitFor(() => ed.eval(`!!document.querySelector('dialog[open]')`), 3000, '確認ダイアログ');
  ok(await ed.eval(`document.querySelector('dialog[open]').textContent.includes('取り消せません')`), '完全削除の前に確認ダイアログが出る');
  await ed.screenshot(path.join(shots, '07-purge-confirm.png'));
  await ed.eval(`document.querySelector('dialog[open] #dlg-cancel').click()`);
  await sleep(300);
  ok(await ed.eval(`document.querySelectorAll('.rowitem').length === 1`), 'キャンセルすると削除されない');

  // ロック → オーバーレイ → 誤ったパスワード → 正しいパスワード
  await ed.eval(`rpc('lock')`);
  await waitFor(() => ed.eval(`!!document.querySelector('#lock-overlay')`), 5000, 'ロックのオーバーレイ');
  await ed.screenshot(path.join(shots, '08-locked.png'));
  await ed.type('#lg-pw', 'wrong-password');
  await ed.press('Enter', 'Enter', 13);
  await waitFor(() => ed.eval(`document.querySelector('#lock-overlay .msg.error') && !document.querySelector('#lock-overlay .msg.error').classList.contains('hidden')`), 5000, 'エラー表示');
  ok(await ed.eval(`document.querySelector('#lock-overlay .msg.error').textContent.includes('違います')`), '誤った MP は「違います」と表示');
  await ed.type('#lg-pw', MP);
  await ed.press('Enter', 'Enter', 13);
  await waitFor(() => ed.eval(`!document.querySelector('#lock-overlay')`), 8000, '再ログイン');
  ok(true, '正しい MP で再ログインできる');

  // フォルダの移動: ドラッグ＆ドロップ、右クリックのダイアログ、ルートへのドロップ、元に戻す、拒否
  {
    await ed.eval(`(async () => { for (const p of ['/A', '/B', '/A/Sub']) await rpc('createFolder', { path: p });
      await rpc('saveItem', { mode: 'new', item: { type: 1, name: 'InSub', folder: '/A/Sub', url: 'https://insub.example.com', fields: [] } }); })()`);
    const folders = () => ed.eval(`rpc('listFolders')`);
    const node = (name) => `[...document.querySelectorAll('#tree li')].find((l) => l.children[1] && l.children[1].textContent === ${JSON.stringify(name)})`;
    const drag = (srcName, dstSel) => ed.eval(`(() => { const s = ${node(srcName)}; const d = ${dstSel}; const dt = new DataTransfer();
      s.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      d.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      d.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      s.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); })()`);
    await waitFor(() => ed.eval(`!!(${node('Sub')})`), 5000, 'フォルダツリーの更新');
    // ドラッグ中のハイライト: 落とせる先は can-drop、自分自身・子孫・今の親は no-drop
    const marks = await ed.eval(`(() => { const s = ${node('Sub')}; s.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
      const r = { b: (${node('B')}).className, sub: s.className, root: document.querySelector('#folders-title').className, a: (${node('A')}).className };
      s.dispatchEvent(new DragEvent('dragend', { bubbles: true })); return r; })()`);
    ok(marks.b.includes('can-drop') && marks.sub.includes('no-drop') && marks.a.includes('no-drop') && marks.root.includes('can-drop'), `ドラッグ中、落とせる先を強調し、自分自身・今の親には禁止表示（${JSON.stringify(marks)}）`);
    ok(await ed.eval(`![...document.querySelectorAll('#tree li')].some((l) => /can-drop|no-drop/.test(l.className))`), 'ドラッグが終わると強調は消える');
    await drag('Sub', node('B'));
    await waitFor(() => ed.eval(`S.folder === '/B/Sub'`), 5000, '移動したフォルダが選択される');
    ok(await ed.eval(`document.querySelector('#tree li[aria-selected=true]').dataset.path === '/B/Sub'`), '移動したフォルダが選択状態になり、移動先（/B）の下に見えている');
    await waitFor(async () => (await folders()).includes('/B/Sub'), 5000, 'ドラッグでフォルダを移動');
    ok(!(await folders()).includes('/A/Sub'), 'ドラッグ＆ドロップでフォルダを別のフォルダへ移せる（/A/Sub → /B/Sub）');
    const moved = (await ed.eval(`rpc('listEntries')`)).find((e) => e.name === 'InSub');
    ok(moved.folder === '/B/Sub', '配下のアイテムも付け替わる');
    await ed.click('#b-undo');
    await waitFor(async () => (await folders()).includes('/A/Sub'), 5000, 'フォルダ移動の Undo');
    ok(!(await folders()).includes('/B/Sub'), 'フォルダの移動も元に戻せる');
    await ed.click('#b-redo');
    await waitFor(async () => (await folders()).includes('/B/Sub'), 5000, 'フォルダ移動の Redo');
    // 右クリック →「移動...」→ ダイアログで移動先を選ぶ（B を A の中へ）
    await ed.eval(`(${node('B')}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 200 }))`);
    await waitFor(() => ed.eval(`!![...document.querySelectorAll('.ctxmenu button')].find((b) => b.textContent === '移動...')`), 3000, '右クリックメニュー');
    await ed.eval(`[...document.querySelectorAll('.ctxmenu button')].find((b) => b.textContent === '移動...').click()`);
    await waitFor(() => ed.eval(`!!document.querySelector('dialog[open] select')`), 3000, '移動先ダイアログ');
    ok(await ed.eval(`![...document.querySelectorAll('dialog[open] option')].some((o) => o.value === '/B' || o.value.startsWith('/B/'))`), '移動先の一覧に、自分自身とその子孫は出ない');
    await ed.eval(`(() => { const s = document.querySelector('dialog[open] select'); s.value = '/A'; })()`);
    await ed.eval(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === '移動').click()`);
    await waitFor(async () => (await folders()).includes('/A/B/Sub'), 5000, 'ダイアログでフォルダを移動');
    ok(true, '右クリックの「移動...」ダイアログでフォルダを移せる（/B → /A/B）');
    // ルート（「フォルダ」見出し）へドロップすると最上位へ
    await waitFor(() => ed.eval(`(${node('B')}).dataset.path === '/A/B'`), 5000, 'ツリーの再描画');
    await drag('B', "document.querySelector('#folders-title')");
    await waitFor(async () => (await folders()).includes('/B/Sub') && !(await folders()).includes('/A/B'), 5000, 'ルートへ移動');
    ok(true, '見出しへドロップすると最上位へ移る');
    // 自分の子孫への移動は拒否される
    await drag('B', node('Sub'));
    await sleep(600);
    ok((await folders()).includes('/B') && !(await folders()).some((f) => f.startsWith('/B/Sub/B')), '子孫への移動は拒否される');
    // 未選択でフォルダを選んでいるとき、ツールバーの「移動」でフォルダを移す
    await ed.eval(`(${node('B')}).click()`);
    await sleep(300);
    await ed.eval(`document.querySelectorAll('.rowitem').length`);
    await ed.eval(`(() => { document.querySelector('#list').focus(); })()`);
    await ed.eval(`(() => { const e = { ctrlKey: false }; })()`);
    const selCleared = await ed.eval(`(() => { return typeof S !== 'undefined' && S.sel.size === 0; })()`);
    await ed.click('#b-move');
    await waitFor(() => ed.eval(`!!document.querySelector('dialog[open] select')`), 3000, 'ツールバーの移動');
    ok(selCleared, '項目が未選択でフォルダを選ぶと、ツールバーの「移動」でフォルダ用ダイアログが開く');
    await ed.eval(`(() => { document.querySelector('dialog[open] select').value = '/A'; [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === '移動').click(); })()`);
    await waitFor(async () => (await folders()).includes('/A/B/Sub'), 5000, 'ツールバーで移動');
    ok(true, 'ツールバーの「移動」でフォルダを移せる');
    await ed.eval(`rpc('deleteFolder', { path: '/A' })`);
    await ed.eval(`document.querySelector('#views li').click()`);
  }

  // Windows Hello: 対話的な確認（PIN・生体認証）は自動化できないため、状態の取得と未登録時のエラーまでを確認する
  const hs = await ed.eval(`rpc('helloStatus')`);
  ok(typeof hs.supported === 'boolean' && hs.enrolled === false && hs.enabled === false, `Windows Hello の状態を取得できる（対応: ${hs.supported}）`);
  await ed.eval(`rpc('lock')`);
  await waitFor(() => ed.eval(`!!document.querySelector('#lock-overlay')`));
  const hu = await ed.eval(`rpc('helloUnlock').then(() => 'ok', (e) => e.message)`);
  ok(hu.includes('登録されていません'), '未登録のときは Windows Hello で解除できない（エラーメッセージ）');
  ok(await ed.eval(`!document.querySelector('#lock-overlay button[type=button]')`), '未登録なら、ロック画面に Hello のボタンは出ない');
  await ed.type('#lg-pw', MP);
  await ed.press('Enter', 'Enter', 13);
  await waitFor(() => ed.eval(`!document.querySelector('#lock-overlay')`), 8000);

  // 5 回連続の失敗で待ち時間
  await ed.eval(`rpc('lock')`);
  await waitFor(() => ed.eval(`!!document.querySelector('#lock-overlay')`));
  let rate = false;
  for (let i = 0; i < 6; i++) {
    const r = await ed.eval(`rpc('unlock', {password: 'bad${i}'}).then(() => 'ok', e => e.code)`);
    if (r === 'RATE_LIMITED') rate = true;
  }
  ok(rate, '5 回続けて失敗すると RATE_LIMITED（待ち時間）になる');
  const r = await ed.eval(`rpc('unlock', {password: ${JSON.stringify(MP)}}).then(() => 'ok', e => e.code)`);
  ok(r === 'RATE_LIMITED', '待ち時間中は正しい MP でも拒否される');
  ed.close(); setup.close();
} catch (e) {
  failed++;
  console.log('ERROR', e.stack || e);
} finally {
  console.log('--- アプリのログ ---\n' + app.log.join('').slice(-1500));
  killTree(app.child);
  console.log(`スクリーンショット: ${shots}`);
  console.log(failed ? `${failed} 件失敗` : 'すべて成功');
  process.exit(failed ? 1 : 0);
}
