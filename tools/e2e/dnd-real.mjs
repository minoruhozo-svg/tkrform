// エディタのドラッグ＆ドロップを、合成イベントではなく「マウス操作 → ブラウザが作るドラッグ」で確認する。
// CDP の Input.setInterceptDrags で、mousePressed → mouseMoved（複数回）の結果として発生したドラッグを受け取り、
// Input.dispatchDragEvent（dragEnter / dragOver / drop）でドロップする。
//   node tools/e2e/dnd-real.mjs
import { Cdp, startApp, killTree, waitTarget, waitFor, tmpDir, sleep } from './lib.mjs';

const PORT = 9361;
const dataDir = tmpDir('tk-dnd-');
const app = startApp({ dataDir, cdpPort: PORT, env: { TKRFORM_PIPE_SUFFIX: 'e2ednd' } });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failed++; };
const MP = 'dnd-real-correct-horse-battery-2727';

try {
  const t = await waitTarget(PORT, (x) => x.url.includes('setup.html'));
  const setup = await Cdp.connect(t.webSocketDebuggerUrl);
  await waitFor(() => setup.eval(`typeof rpc === 'function'`), 10000);
  await setup.eval(`rpc('setup', { mp: ${JSON.stringify(MP)}, hint: '', iterations: 100000 })`);
  await setup.eval(`(async () => { for (const p of ['/Src', '/Dst', '/Src/Child']) await rpc('createFolder', { path: p });
    await rpc('saveItem', { mode: 'new', item: { type: 1, name: 'MovableItem', folder: '/Src', url: 'https://movable.example.com', fields: [] } }); })()`);
  await setup.eval(`rpc('openWindow', { name: 'editor' })`);
  const et = await waitTarget(PORT, (x) => x.url.includes('editor.html'));
  const ed = await Cdp.connect(et.webSocketDebuggerUrl);
  await waitFor(() => ed.eval(`document.querySelectorAll('#tree li[data-path]').length === 3`), 10000, 'フォルダツリー');
  await ed.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  const folders = () => ed.eval(`rpc('listFolders')`);

  const center = (sel) => ed.eval(`(() => { const e = ${sel}; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const folderLi = (p) => `document.querySelector('#tree li[data-path="${p}"]')`;

  /** 実マウスに近い操作: 押す → 少しずつ動かす →（ブラウザがドラッグを開始）→ 目的の位置で離す */
  async function mouseDrag(srcSel, dstSel) {
    const a = await center(srcSel);
    let intercepted = null;
    const before = ed.events.length;
    await ed.send('Input.setInterceptDrags', { enabled: true });
    await ed.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
    await ed.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 });
    const b = await center(dstSel);
    for (let i = 1; i <= 8; i++) {
      await ed.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(a.x + ((b.x - a.x) * i) / 8) + 3, y: Math.round(a.y + ((b.y - a.y) * i) / 8) + 3, button: 'left', buttons: 1 });
      await sleep(30);
      intercepted = ed.events.slice(before).find((e) => e.method === 'Input.dragIntercepted');
      if (intercepted) break;
    }
    if (!intercepted) { await ed.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left' }); await ed.send('Input.setInterceptDrags', { enabled: false }); return null; }
    const data = intercepted.params.data;
    const to = await center(dstSel);
    const res = {};
    res.mark = await ed.eval(`document.querySelectorAll('#tree .can-drop, #folders-title.can-drop').length > 0`); // ドラッグ開始で強調が出ている
    await ed.send('Input.dispatchDragEvent', { type: 'dragEnter', x: to.x, y: to.y, data });
    await ed.send('Input.dispatchDragEvent', { type: 'dragOver', x: to.x, y: to.y, data });
    await ed.send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data });
    await ed.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left' });
    await ed.send('Input.setInterceptDrags', { enabled: false });
    await sleep(500);
    return res;
  }

  // フォルダ → フォルダ
  const r1 = await mouseDrag(folderLi('/Src/Child'), folderLi('/Dst'));
  ok(r1 !== null, 'マウスのドラッグでブラウザがドラッグを開始する（フォルダ）');
  await waitFor(async () => (await folders()).includes('/Dst/Child'), 5000, 'フォルダの移動').catch(() => {});
  ok((await folders()).includes('/Dst/Child'), 'フォルダをマウスでドラッグして別のフォルダへ移せる（/Src/Child → /Dst/Child）');

  // フォルダ → 「フォルダ」見出し（ルート）
  const r2 = await mouseDrag(folderLi('/Dst/Child'), `document.querySelector('#folders-title')`);
  await sleep(500);
  ok((await folders()).includes('/Child') && r2 !== null, '「フォルダ」見出しへドロップすると最上位へ移る（/Dst/Child → /Child）');

  // 自分の子孫の上へは落とせない
  const r3 = await mouseDrag(folderLi('/Src'), folderLi('/Src/Child')).catch(() => null);
  ok((await folders()).includes('/Src') && !(await folders()).some((f) => f.startsWith('/Src/Child/Src')), '子孫の上にはドロップしても何も起きない');

  // 項目 → フォルダ
  await ed.eval(`(() => { const li = [...document.querySelectorAll('#list .rowitem')]; return li.length; })()`);
  await ed.eval(`document.querySelector('#tree li[data-path="/Src"]').click()`);
  await waitFor(() => ed.eval(`document.querySelectorAll('#list .rowitem').length === 1`), 5000, '一覧');
  const r4 = await mouseDrag(`document.querySelector('#list .rowitem')`, folderLi('/Dst'));
  await sleep(500);
  const mv = (await ed.eval(`rpc('listEntries')`)).find((e) => e.name === 'MovableItem');
  ok(r4 !== null && mv.folder === '/Dst', `項目（一覧の行）をマウスでフォルダへドラッグして移せる（${mv.folder}）`);
  ed.close(); setup.close();
} catch (e) {
  failed++;
  console.log('ERROR', e.stack || e);
} finally {
  killTree(app.child);
  console.log(failed ? `${failed} 件失敗` : 'すべて成功');
  process.exit(failed ? 1 : 0);
}
