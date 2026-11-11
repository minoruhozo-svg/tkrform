// マニュアル用の画面画像と、番号つきの枠の位置・凡例を作る（`MANUAL_SHOTS_DIR=docs/manual/img node tools/e2e/ext.mjs` から呼ばれる）。
// 画像は MANUAL_SHOTS_DIR/<名前>.png、枠と凡例は MANUAL_SHOTS_DIR/boxes.json に出す。
// docs/manual/annotate.py が boxes.json を読んで、番号つきの赤い枠を書き込み、docs/manual の HTML が凡例を使う。
// 枠の位置は、画面の要素（セレクタ）から取る。画面の見た目が変わっても、撮り直すだけで追従する。

export async function run(c) {
  const { pipe, ui, APP_PORT, waitTarget, Cdp, openTab, closeTab, EXT_ID, swc, sleep, waitFor, fs, path, outDir, ed, se, stg } = c;
  fs.mkdirSync(outDir, { recursive: true });
  const spec = {};
  const light = (p) => p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }).catch(() => {});
  const size = (p, w, h) => p.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });

  /** boxes: [[セレクタ, 番号の位置（'r' 'l' 't' 'b' 'tl'）], ...]。凡例は、番号の順。 */
  async function take(page, name, boxes, legend) {
    await sleep(700);
    await page.screenshot(path.join(outDir, name + '.png'));
    const sels = boxes.map((b) => b[0]);
    const rects = JSON.parse(await page.eval(`JSON.stringify(${JSON.stringify(sels)}.map((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; }))`));
    const out = [];
    rects.forEach((r, i) => { if (r) out.push([r, out.length + 1, boxes[i][1]]); else console.log(`  （枠なし: ${name} ${sels[i]}）`); });
    spec[name] = { boxes: out, legend };
    console.log('撮影: ' + name);
  }

  // ---- 項目（プロフィール・メモ・ごみ箱）を足す
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const idn = await pipe.ok('saveItem', { mode: 'new', item: { type: 5, name: '自宅（サンプル）', folder: '/', favorite: false, country: 'JP', groups: [
    { group: 'Person', instances: [{ name: '既定', fields: { LastName: '山田', FirstName: '太郎', LastNameKana: 'ヤマダ', FirstNameKana: 'タロウ', Email: 'taro.example@example.com', CellPhone: '090-0000-0000' }, customMatches: {} }] },
    { group: 'Address', instances: [{ name: '自宅', fields: { ZipOrPostCode: '100-0000', StateOrProvince: '東京都', City: '千代田区', AddressLine1: 'サンプル町 1-2-3' }, customMatches: {} }] },
  ] } });
  const memo = await pipe.ok('saveItem', { mode: 'new', item: { type: 7, name: 'サンプルのメモ', folder: '/', favorite: false, text: 'Wi-Fi の名前: example-home\nパスワード: （ここに書くと、暗号化して保存されます）\n\n契約番号: 0000-0000' } });
  const trash = await pipe.ok('saveItem', { mode: 'new', item: { type: 1, name: '昔のサイト（削除済み）', folder: '/', url: 'https://old.example.org/login', favorite: false, fields: [{ name: 'username', id: '', value: 'taro', kind: 'text', role: 'user' }, { name: 'password', id: '', value: 'Old-Pass-0000!', kind: 'password', role: 'password' }] } });
  await pipe.ok('deleteItem', { id: trash.id });
  void now;

  // ---------------------------------------------------------------- エディタ
  await size(ed, 1200, 720); await light(ed);
  await ed.eval(`document.querySelector('#rail-vault').click()`).catch(() => {});
  await waitFor(() => ed.eval(`document.querySelectorAll('.rowitem').length >= 8`), 15000, 'エディタの一覧');
  const pick = (name) => ed.eval(`[...document.querySelectorAll('.rowitem')].find((r) => r.querySelector('.name').textContent === ${JSON.stringify(name)}).click()`);
  await pick('Example Mail');
  await waitFor(() => ed.eval(`!!document.querySelector('.view .vname')`), 8000, '表示の画面');
  await take(ed, 'app-editor', [['#toolbar', [690, 24]], ['#left', [175, 560]], ['#middle', [440, 690]], ['.vhead', 'r'], ['.vrows', [1100, 460]], ['#v-edit', 'b'], ['#rail', [36, 400]]], [
    '操作ボタン。「新規」が主な操作で、ほかは複製・名前変更・移動・削除・印刷・元に戻す・やり直し・検索・その他',
    '種類とフォルダで絞り込み',
    '項目の一覧（頭文字の四角の色は、名前から決まります）',
    '名前・お気に入り・フォルダ',
    'ユーザー ID・パスワード・URL・TOTP。表示とコピーのボタンがあります',
    '「編集」を押すと、編集のフォームに替わります',
    '左端の切り替え（保管庫・安全性・生成・設定・ロック）',
  ]);
  // 編集のフォーム
  await ed.eval(`document.querySelector('#v-edit').click()`);
  await waitFor(() => ed.eval(`!!document.querySelector('#f-name')`), 5000, '編集のフォーム');
  await take(ed, 'app-editor-form', [['#f-name', 'r'], ['.fields-table', 'b'], ['#adv', 'b'], ['#f-save', 't']], [
    '名前・フォルダ・お気に入り',
    '記入する入力欄の一覧（フィールド）',
    '「詳細設定」（照合 URL・送信の設定・多段ログインなど）。ふだんは閉じています',
    '変更したら「保存」。保存すると、表示の画面に戻ります',
  ]);
  await ed.eval(`document.querySelector('#f-revert').click()`).catch(() => {});
  // プロフィール
  await pick('自宅（サンプル）');
  await waitFor(() => ed.eval(`!!document.querySelector('.group-tabs')`), 8000, 'プロフィール');
  await take(ed, 'app-editor-profile', [['#detail .two', 'l'], ['#detail select[aria-label]', 'l'], ['.group-tabs', 'l'], ['.idgrid', 'l']], [
    '名前・フォルダ',
    '国を選びます',
    'グループ（個人・会社・住所・カードなど）のタブ',
    '各欄に入力します（＋で、別の住所やカードを追加できます）',
  ]);
  // メモ
  await pick('サンプルのメモ');
  await waitFor(() => ed.eval(`!!document.querySelector('#detail textarea')`), 8000, 'メモ');
  await take(ed, 'app-memo', [['#f-name', 'l'], ['#detail .check', 'r'], ['#detail textarea', 'b'], ['#f-save', 't']], [
    'メモの名前',
    '等幅フォントで表示（表やキーをそろえて見たいとき）',
    '本文。暗号化して保存されます',
    '変更したら「保存」',
  ]);
  // ごみ箱
  await ed.eval(`[...document.querySelectorAll('#views li')].find((l) => l.textContent.startsWith('ゴミ箱')).click()`);
  await waitFor(() => ed.eval(`document.querySelectorAll('.rowitem').length > 0`), 8000, 'ごみ箱');
  await ed.eval(`document.querySelector('.rowitem').click()`);
  await waitFor(() => ed.eval(`[...document.querySelectorAll('#detail button')].some((b) => b.textContent.startsWith('完全に削除'))`), 8000, 'ごみ箱の項目');
  await take(ed, 'app-trash', [['#views li[aria-selected=true]', 'r'], ['#b-empty-trash', 'b'], ['#detail .primary', 'b'], ['#detail .danger', 'b']], [
    '「ゴミ箱」を選びます',
    'ごみ箱を空にする（元に戻せません）',
    '元の場所に戻す',
    'この項目だけ完全に削除する（元に戻せません）',
  ]);
  await ed.eval(`document.querySelector('#views li').click()`);

  // ---------------------------------------------------------------- セキュリティセンター
  await size(se, 1100, 800); await light(se);
  await se.eval(`document.querySelector('#tab-reused').click()`);
  await take(se, 'app-security', [['.top', 'b'], ['#rescan', 'b'], ['#tabs', 'b'], ['#panel-reused .grp', 'l'], ['#panel-reused li .pill', 'r'], ['#panel-reused li button.primary', 'r']], [
    '総合のスコア（0〜100）と、あと何件変えると 100 点になるか',
    'もう一度調べる',
    '問題の種類ごとの件数の箱。押すと、その種類に絞り込みます',
    '該当するログイン（頭文字・名前・ID とサイト）',
    '理由（「Example Game ほか 1 件と同じ」「強度 38 ビット」「2 年前から変更なし」など）',
    '「パスワードを変える」で、保管庫の画面でその項目を編集の状態で開きます。「サイトを開く」で、そのサイトを開けます',
  ]);

  // ---------------------------------------------------------------- 設定
  await size(stg, 1100, 800); await light(stg);
  await take(stg, 'app-settings', [['#tabs', 'r'], ['.grp', 'b'], ['#upd-check', 'b'], ['#autosave-note', 't']], [
    '設定の種類（左の一覧）',
    '見出しつきの枠（起動と表示・更新など）。行ごとに説明があり、オン・オフはスイッチ、選ぶものは右の欄',
    'バージョンの表示と「今すぐ確認」（更新の枠の中）',
    '変更は、その場で保存されます（「保存」ボタンはありません）',
  ]);
  await stg.eval(`document.querySelector('#tabs button[data-id=security]').click()`);
  await take(stg, 'app-settings-security', [['.pane.active .grp', 'b'], ['.pane.active .row button', 'b'], ['.pane.active .card', 'b']], [
    '自動でロックする条件と時間',
    'マスターパスワードの変更',
    'Windows Hello の有効化',
  ]);
  await stg.eval(`document.querySelector('#tabs button[data-id=backup]').click()`);
  await pipe.ok('backupNow').catch(() => {});
  await sleep(800);
  await take(stg, 'app-settings-backup', [['#bk-dir', 'b'], ['.pane.active .row:nth-of-type(3) button:nth-child(1)', 'b']], [
    'バックアップの保存先フォルダ',
    '今すぐバックアップ・全初期化・フォルダを指定して復元・整合性を確認',
  ]);
  await take(stg, 'app-backup-list', [['#backups', 'r']], ['バックアップのファイル（作成した日時と大きさ）。「復元」でこのバックアップに戻します']);

  // ---------------------------------------------------------------- 拡張のポップアップ
  const popup = async (fn) => {
    const pop = await openTab(`chrome-extension://${EXT_ID}/popup.html`);
    await size(pop, 380, 600); await light(pop);
    await waitFor(() => pop.eval(`!document.querySelector('#v-main').classList.contains('hidden') && document.querySelectorAll('#list li').length >= 3`), 15000, 'ポップアップ');
    await pop.eval(`activeTab = { id: 0, url: 'https://mail.example.com/login' }; loadList();`);
    await waitFor(() => pop.eval(`!document.querySelector('#here').classList.contains('hidden')`), 8000, '「このサイト」の枠');
    await fn(pop);
    await closeTab(pop);
  };
  await popup(async (pop) => {
    await pop.eval(`document.querySelector('#seg-frequent').click()`);
    await sleep(400);
    await take(pop, 'ext-popup-frequent', [['#menu-btn', 'l'], ['#q', 'b'], ['#here', 'l'], ['.tabrow', [362, 262]], ['#list li', [362, 292]], ['#dock', [362, 538]]], [
      '歯車メニュー',
      '検索欄',
      '「このサイト」。開いているページに合うログインが、いちばん上に出ます（合うログインがないときは、枠ごと出ません）。色つきの「記入」を 1 回押せば済みます',
      'タブ（ログイン・プロフィール・メモ）と、右端の「よく使う」「ABC」の切り替え',
      'ログインの行。ふだんは何も出ず、マウスを乗せる（またはキーボードでフォーカスする）と操作ボタンが出ます',
      '下の操作のバー（パスワード生成・ページを保存・ロック・設定）',
    ]);
    await pop.eval(`document.querySelector('#seg-abc').click()`);
    await sleep(500);
    await take(pop, 'ext-popup-abc', [['#seg-abc', 'l'], ['#list li.folder', 'b'], ['#list li:not(.folder)', 'b']], [
      '「ABC」を選んだ状態',
      'フォルダ。押すと中に入ります（右の数字は件数）',
      'フォルダに入っていないログイン',
    ]);
    await pop.eval(`document.querySelector('#seg-frequent').click()`);
    await sleep(500);
    // 行の操作ボタン（マウスを乗せた状態）
    await pop.eval(`(() => { const s = document.createElement('style'); s.textContent = '#list li:nth-child(2) .actions { display: flex !important; }'; document.head.append(s); })()`);
    await take(pop, 'ext-popup-hover', [1, 2, 3, 4, 5].map((i) => [`#list li:nth-child(2) .actions button:nth-child(${i})`, 'b']), [
      'ログイン（保存した URL を開いて記入し、送信します）', '記入（今開いているページに記入します）', 'ID をコピー', 'パスワードをコピー', 'エディタで開く',
    ]);
    await pop.eval(`document.querySelector('#menu-btn').click()`);
    await take(pop, 'ext-popup-menu', [['#menu-btn', 'l'], ['#menu', 'l']], ['歯車アイコンを押すと', 'メニューが開きます']);
    await pop.eval(`document.querySelector('#menu-btn').click()`);
    await take(pop, 'ext-popup-saveform', [['#b-saveform', 't']], ['Web ページを開いているときに、下の操作のバーに出ます']);
  });

  // ---------------------------------------------------------------- ホーム
  const home = await openTab(`chrome-extension://${EXT_ID}/start.html`);
  await size(home, 1000, 640); await light(home);
  await waitFor(() => home.eval(`document.querySelectorAll('.tile').length >= 8`), 15000, 'ホーム');
  await take(home, 'ext-home', [['#q', 'l'], ['#grid h2.sec', 'r'], ['#grid .tile', 'b']], ['検索欄', '見出し（「よく使う」と「すべてのログイン」）', 'ログインのタイル。押すと、そのサイトを開いて記入します（頭文字の四角の色は、エディタ・ポップアップと同じです）']);
  await closeTab(home);

  fs.writeFileSync(path.join(outDir, 'boxes.json'), JSON.stringify(spec, null, 1));
  void Cdp; void APP_PORT; void waitTarget; void swc; void ui; void idn; void memo;
}
