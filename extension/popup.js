'use strict';
// ツールバーのポップアップ（§8.5）。

const TABS = [['login', 'Ext_Tab_Logins'], ['site', 'Ext_Tab_Site'], ['identity', 'Ext_Tab_Identities'], ['note', 'Ext_Tab_Notes']];
const TYPES = { login: [1], identity: [5, 6], note: [7] };
const BADGE = { 1: 'L', 2: 'B', 5: 'ID', 6: 'C', 7: 'N' };

let tab = 'login';
let state = { connected: false, locked: true };
let activeTab = null;
let seq = 0;
let genMounted = false;
let genOpen = false; // 「パスワード生成」の画面を出している
// 「ログイン」タブの表示: frequent（よく使う）/ abc（フォルダを上にした一覧）。選んだものは保存し、次に開いたときも出す。
// 保存した選択がないとき（初回）は、よく使うログインがあれば frequent、なければ abc。
const LOGIN_VIEW_KEY = 'tkrform.popupLoginView';
const FREQUENT_MAX = 50;
let loginView = null;
try { const v = localStorage.getItem(LOGIN_VIEW_KEY); if (v === 'frequent' || v === 'abc') loginView = v; } catch (_) { /* 無視 */ }
// タブごとに開いているフォルダ（ログイン・ブックマーク・プロフィール・メモ）。次に開いたときも同じフォルダから表示する
let folderOf = {};
try { folderOf = JSON.parse(localStorage.getItem('tkrform.popupFolders') || '{}') || {}; } catch (_) { folderOf = {}; }
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
const baseName = (p) => p.split('/').filter(Boolean).pop() || '';

function show(view) {
  for (const v of ['off', 'locked', 'main']) $('#v-' + v).classList.toggle('hidden', v !== view);
}

async function refresh() {
  try { state = await bg({ t: 'state' }); } catch (_) { state = { connected: false, locked: true }; }
  render();
}

// ロック中に開いたら、ボタンを押さなくても Windows Hello で解除を始める（ポップアップごとに 1 回だけ。
// キャンセル・失敗の直後の再開始は bg.js が止める）。確認画面にフォーカスが移るとポップアップは閉じるが、要求はアプリと bg.js で続く。
let helloAutoTried = false;
async function autoHello() {
  if (helloAutoTried || !state.helloAvailable) return;
  helloAutoTried = true;
  let r;
  try { r = await bg({ t: 'helloAuto' }); } catch (_) { return; }
  if (!r || !r.started) return;
  $('#hello-btn').disabled = true;
  flash(t('Ext_Hello_Waiting'));
  if (r.error) { $('#unlock-err').textContent = r.error; $('#unlock-err').classList.remove('hidden'); $('#mp').focus(); }
  else await refresh();
  $('#hello-btn').disabled = false;
}

function render() {
  const st = $('#status');
  if (!state.connected) {
    show('off');
    $('#off-msg').textContent = t('Ext_NotConnected') + ' ' + (state.error || '');
    st.textContent = '';
    return;
  }
  if (state.locked) {
    show('locked');
    st.textContent = t('Ext_Locked');
    $('#hello-btn').classList.toggle('hidden', !state.helloAvailable);
    $('#hello-or').classList.toggle('hidden', !state.helloAvailable);
    setTimeout(() => $('#mp').focus(), 30);
    autoHello();
    return;
  }
  st.textContent = '';
  show('main');
  loadList();
}

function actionBtn(text, title, fn) {
  return el('button', { type: 'button', class: 'icon', text, title, 'aria-label': title, onclick: async (e) => { e.stopPropagation(); try { await fn(); } catch (er) { flash(errText(er)); } } });
}

/** 一時メッセージ（「コピーしました」など）。見出しの下の細い帯に、3 秒間出す。 */
let flashTimer = null;
function flash(text) {
  const f = $('#flash');
  f.textContent = text;
  f.classList.toggle('hidden', !text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => f.classList.add('hidden'), 3000);
}

function rowFor(e, onSite, showFolder) {
  const isLogin = e.type === 1;
  let sub = isLogin ? [e.user, hostOf(e.url)].filter(Boolean).join('  ') : e.type === 2 ? e.url : '';
  if (showFolder && e.folder && e.folder !== '/') sub = [sub, '📁 ' + e.folder.replace(/^\//, '')].filter(Boolean).join('  ');
  const acts = el('div', { class: 'actions' });
  if (isLogin) {
    acts.append(
      actionBtn('▶', t('Ext_Act_Login'), async () => { await doFill(e, null, onSite); }), // null: 項目の「記入後に送信する」に従う（チェックなしなら、記入だけ）
      // 「このサイト」でも「ログイン」でも、今開いているページに記入する（送信しない）。一致しないページには記入しない
      actionBtn('✎', onSite ? t('Ext_Act_Fill') : t('Ext_Act_FillMatch'), async () => { await fillHere(e); }),
      actionBtn('👤', t('Ext_Act_CopyUser'), async () => { await rpc('copyItem', { id: e.id, field: 'user' }); flash(t('Common_Copied', '')); }),
      actionBtn('🔑', t('Ext_Act_CopyPassword'), async () => { await rpc('copyItem', { id: e.id, field: 'password' }); flash(t('Common_Copied', '')); }),
    );
    if (e.hasTotp) acts.append(actionBtn('⏱', t('Ext_Act_CopyTotp'), async () => { await rpc('copyItem', { id: e.id, field: 'totp' }); flash(t('Common_Copied', '')); }));
  } else if (e.type === 2) {
    acts.append(actionBtn('↗', t('Ext_Act_Open'), async () => { chrome.tabs.create({ url: /^https?:/i.test(e.url) ? e.url : 'https://' + e.url }); window.close(); }));
  } else if (e.type === 5 || e.type === 6) {
    acts.append(actionBtn('✎', t('Ext_Act_Fill'), async () => { await bg({ t: 'fillIdentityTab', id: e.id }); window.close(); }));
  }
  acts.append(actionBtn('⚙', t('Ext_Act_Edit'), async () => { await rpc('openEditor', { id: e.id }); window.close(); }));
  const li = el('li', { tabIndex: 0, ondblclick: () => primary(e, onSite) },
    el('span', { class: 'badge b' + e.type, text: BADGE[e.type] || 'L' }),
    el('div', { class: 'grow' }, el('div', { class: 'name', text: e.name }), el('div', { class: 'meta', text: sub })),
    acts);
  li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') primary(e, onSite); });
  return li;
}

function primary(e, onSite) {
  if (e.type === 1) doFill(e, null, onSite).catch((er) => flash(errText(er)));
  else if (e.type === 2) { chrome.tabs.create({ url: /^https?:/i.test(e.url) ? e.url : 'https://' + e.url }); window.close(); }
  else if (e.type === 5 || e.type === 6) bg({ t: 'fillIdentityTab', id: e.id }).then(() => window.close());
  else rpc('openEditor', { id: e.id }).then(() => window.close());
}

/** 今アクティブなタブのページに記入する。保存した URL と一致しないページでは記入せず、「開いて記入」を選べるようにする。 */
async function fillHere(e) {
  const r = await bg({ t: 'fillTab', id: e.id, submit: false });
  if (r && r.filled) { window.close(); return; }
  if (r && r.code === 'URL_MISMATCH') { showMismatch(e); return; }
  throw { message: t('Ext_Err_NoForm') };
}

function showMismatch(e) {
  const host = hostOf(e.url) || e.url;
  const box = $('#mismatch');
  box.replaceChildren(el('span', { text: t('Ext_Err_PageMismatch', host) }), ' ',
    el('button', { type: 'button', text: t('Ext_Act_GoFill'), onclick: async () => { try { await doFill(e, false, false); } catch (er) { flash(errText(er)); } } }));
  box.classList.remove('hidden');
}

async function doFill(e, submit, onSite) {
  if (onSite) {
    const r = await bg({ t: 'fillTab', id: e.id, submit });
    if (r && r.filled) { window.close(); return; }
    if (!r || !r.filled) throw { message: t('Ext_Err_NoForm') };
  } else {
    const url = /^https?:/i.test(e.url) ? e.url : 'https://' + e.url;
    await bg({ t: 'goFill', id: e.id, url, submit });
    window.close();
  }
}

function openFolder(path) {
  folderOf[tab] = path;
  try { localStorage.setItem('tkrform.popupFolders', JSON.stringify(folderOf)); } catch (_) { /* 無視 */ }
  loadList();
  $('#list-wrap').scrollTop = 0;
}

function folderRow(path, count, up) {
  const li = el('li', { class: 'folder' + (up ? ' up' : ''), tabIndex: 0, onclick: () => openFolder(path) },
    el('span', { class: 'badge bf', text: up ? '↑' : '📁' }),
    el('div', { class: 'grow' },
      el('div', { class: 'name', text: up ? t('Ext_Folder_Up') : baseName(path) }),
      up ? el('div', { class: 'meta', text: '📁 ' + up.replace(/^\//, '') }) : null),
    up ? null : el('span', { class: 'count', text: String(count) }));
  li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openFolder(path); });
  return li;
}

/** よく使うログイン: お気に入り、または使用回数 1 以上。並びはアプリ側（お気に入り → 使用の点数の高い順 → 最近使った順）のまま、最大 50 件。 */
function hotRows(rows) {
  return rows.filter((r) => r.type === 1 && (r.favorite || (r.useCount || 0) >= 1)).slice(0, FREQUENT_MAX);
}

/** 「よく使う」の表示: フォルダは出さず、行にフォルダ名を小さく添える。該当がなければ案内を出す。 */
function frequentView(hot) {
  if (!hot.length) return [el('li', { class: 'empty', text: t('Ext_Frequent_Empty') })];
  return hot.map((r) => rowFor(r, false, true));
}

function syncSeg() {
  $('#seg-frequent').setAttribute('aria-selected', String(loginView === 'frequent'));
  $('#seg-abc').setAttribute('aria-selected', String(loginView === 'abc'));
}

/** 検索語がないとき: 現在のフォルダの「上へ」・サブフォルダ（件数つき）・項目（名前順）を並べる。 */
function folderView(rows) {
  let cur = folderOf[tab] || '/';
  const norm = (f) => f || '/';
  const build = () => {
    const prefix = cur === '/' ? '/' : cur + '/';
    const kids = new Map();
    const here = [];
    for (const r of rows) {
      const f = norm(r.folder);
      if (f === cur) { here.push(r); continue; }
      if (!f.startsWith(prefix)) continue;
      const child = prefix + f.slice(prefix.length).split('/')[0];
      kids.set(child, (kids.get(child) || 0) + 1);
    }
    return { kids, here };
  };
  let { kids, here } = build();
  if (cur !== '/' && !kids.size && !here.length) { cur = '/'; folderOf[tab] = '/'; ({ kids, here } = build()); } // フォルダが消えた・空になった
  const out = [];
  if (cur !== '/') out.push(folderRow(cur.slice(0, cur.lastIndexOf('/')) || '/', 0, cur));
  [...kids].sort((a, b) => collator.compare(baseName(a[0]), baseName(b[0]))).forEach(([p, n]) => out.push(folderRow(p, n)));
  here.sort((a, b) => collator.compare(a.name, b.name)).forEach((r) => out.push(rowFor(r, false)));
  if (!out.length) out.push(el('li', { class: 'empty', text: t('Ext_NoItems') }));
  return out;
}

const hostOf = (u) => { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u).host; } catch (_) { return u || ''; } };

async function loadList() {
  $('#mismatch').classList.add('hidden');
  $('#login-seg').classList.toggle('hidden', tab !== 'login' || genOpen);
  const my = ++seq;
  const q = $('#q').value;
  const ul = $('#list');
  // 「パスワード生成」の画面を出している間は、一覧・検索・タブを隠す
  $('#gen-view').classList.toggle('hidden', !genOpen);
  for (const sel of ['#list-wrap', '#tabs']) $(sel).classList.toggle('hidden', genOpen);
  $('#q').parentElement.classList.toggle('hidden', genOpen);
  if (genOpen) {
    $('#site-bar').classList.add('hidden');
    if (!genMounted) { mountGenerator($('#gen')); genMounted = true; }
    return;
  }
  try {
    let rows = [];
    let onSite = false;
    // 「フォームの入力内容を保存」は、「ログイン」と「このサイト」のタブで、アクティブなタブが http(s) のページのときだけ出す
    $('#site-bar').classList.add('hidden');
    if (tab === 'login' || tab === 'site') {
      if (!activeTab) [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (my !== seq) return;
      $('#site-bar').classList.toggle('hidden', !(activeTab && /^https?:/i.test(activeTab.url || '')));
    }
    if (tab === 'site') {
      onSite = true;
      const url = activeTab && activeTab.url;
      if (url && /^https?:/i.test(url)) {
        const m = await rpc('match', { url });
        rows = [...m.logins.map((l) => ({ ...l, type: 1, url })), ...m.identities];
        if (q) rows = rows.filter((r) => (r.name + ' ' + (r.user || '')).toLowerCase().includes(q.toLowerCase()));
      }
    } else {
      rows = await searchAll(q, TYPES[tab]);
      if (my !== seq) return;
      // 検索語がなければフォルダ階層で、あれば全フォルダから一覧で（フォルダ名を添える）
      if (!q.trim()) {
        if (tab === 'login') {
          const hot = hotRows(rows);
          if (loginView === null) loginView = hot.length ? 'frequent' : 'abc'; // 初回（保存した選択なし）
          syncSeg();
          if (loginView === 'frequent') { ul.replaceChildren(...frequentView(hot)); return; }
        }
        ul.replaceChildren(...folderView(rows)); // ABC: 上のフォルダへ → サブフォルダ（名前順）→ ログイン（名前順）。フォルダが上
        return;
      }
      if (tab === 'login') syncSeg();
    }
    if (my !== seq) return;
    ul.replaceChildren(...(rows.length ? rows.map((r) => rowFor(r, onSite, !onSite)) : [el('li', { class: 'empty', text: tab === 'site' ? t('Ext_NoMatches') : t('Ext_NoItems') })]));
  } catch (e) {
    if (e.code === 'LOCKED') { state.locked = true; render(); return; }
    ul.replaceChildren(el('li', { class: 'empty', text: errText(e) }));
  }
}

// ------------------------------------------------------------------ 歯車メニュー・バージョン情報

function menuItems() {
  const main = state.connected && !state.locked;
  const items = [
    { id: 'home', label: t('Ext_StartPage'), run: () => { chrome.tabs.create({ url: chrome.runtime.getURL('start.html') }); window.close(); } },
  ];
  if (main) items.push({ id: 'gen', label: t('Ext_Menu_PassGen'), run: () => { genOpen = true; loadList(); } });
  items.push({ id: 'options', label: t('Ext_Settings'), run: () => { chrome.runtime.openOptionsPage(); window.close(); } });
  if (state.connected) items.push({ id: 'edit', label: t('Ext_Menu_Edit'), run: async () => { await rpc('openEditor', {}).catch(() => {}); window.close(); } });
  if (main) items.push({ id: 'lock', label: t('Ext_Lock'), run: async () => { await rpc('lock').catch(() => {}); await refresh(); } });
  items.push({ id: 'about', label: t('Ext_Menu_About'), run: () => showAbout() });
  return items;
}

function closeMenu(focusBtn) {
  $('#menu').classList.add('hidden');
  $('#menu-btn').setAttribute('aria-expanded', 'false');
  if (focusBtn) $('#menu-btn').focus();
}

function openMenu() {
  const menu = $('#menu');
  menu.replaceChildren(...menuItems().map((it) => el('button', { type: 'button', role: 'menuitem', id: 'menu-' + it.id, text: it.label, onclick: async () => { closeMenu(); await it.run(); } })));
  menu.classList.remove('hidden');
  $('#menu-btn').setAttribute('aria-expanded', 'true');
  menu.querySelector('button').focus();
}

function setupMenu() {
  const btn = $('#menu-btn');
  btn.setAttribute('aria-label', t('Ext_Menu_Button'));
  btn.title = t('Ext_Menu_Button');
  btn.addEventListener('click', (e) => { e.stopPropagation(); if ($('#menu').classList.contains('hidden')) openMenu(); else closeMenu(); });
  document.addEventListener('click', (e) => { if (!$('#menu').classList.contains('hidden') && !e.target.closest('#menu')) closeMenu(); });
  document.addEventListener('keydown', (e) => {
    if ($('#menu').classList.contains('hidden')) return;
    const items = [...$('#menu').querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); items[i].click(); }
  });
  $('#about-close').addEventListener('click', () => $('#about').classList.add('hidden'));
  $('#about').addEventListener('click', (e) => { if (e.target === $('#about')) $('#about').classList.add('hidden'); });
  $('#about').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); $('#about').classList.add('hidden'); } });
  $('#about-link').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: 'https://tkrs.jp/' }); });
}

function showAbout() {
  const ver = state.version || chrome.runtime.getManifest().version;
  $('#about-ver').textContent = t('Ext_About_Version', ver);
  $('#about').classList.remove('hidden');
  $('#about-close').focus();
}

(async () => {
  applyI18n();
  TABS.forEach(([id, key]) => {
    const b = el('button', { role: 'tab', 'aria-selected': String(id === tab), text: t(key), onclick: () => { tab = id; $$('#tabs button').forEach((x, i) => x.setAttribute('aria-selected', String(TABS[i][0] === id))); loadList(); } });
    $('#tabs').append(b);
  });
  $('#q').addEventListener('input', () => loadList());
  $('#reconnect').addEventListener('click', async () => { try { await bg({ t: 'reconnect' }); } catch (_) { /* 無視 */ } setTimeout(refresh, 800); });
  const doUnlock = async () => {
    $('#unlock').disabled = true;
    try {
      await rpc('unlock', { password: $('#mp').value });
      $('#mp').value = '';
      $('#unlock-err').classList.add('hidden');
      await refresh();
    } catch (e) {
      $('#unlock-err').textContent = errText(e); $('#unlock-err').classList.remove('hidden');
      $('#mp').select();
    }
    $('#unlock').disabled = false;
  };
  $('#unlock').addEventListener('click', doUnlock);
  // Windows Hello で解除。失敗・キャンセルのときはエラーを出し、マスターパスワードの入力もそのまま使える
  $('#hello-btn').addEventListener('click', async () => {
    $('#hello-btn').disabled = true;
    $('#unlock-err').classList.add('hidden');
    flash(t('Ext_Hello_Waiting'));
    try { await bg({ t: 'helloUnlock' }); await refresh(); }
    catch (e) { $('#unlock-err').textContent = errText(e); $('#unlock-err').classList.remove('hidden'); $('#mp').focus(); }
    $('#hello-btn').disabled = false;
  });
  $('#mp').addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
  // ポップアップの中では右クリックメニューを出さない（検索欄・マスターパスワード欄など、入力欄ではコピー・貼り付けのために出す）
  document.addEventListener('contextmenu', (ev) => {
    const tg = ev.target;
    if (!(tg instanceof Element && tg.closest('input, textarea, [contenteditable="true"]'))) ev.preventDefault();
  });
  $('#b-saveform').title = t('Ext_Popup_SaveForm_Tip');
  $('#b-saveform').addEventListener('click', async () => {
    try {
      if (!activeTab) [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await bg({ t: 'saveFormInTab', tabId: activeTab.id });
      window.close(); // 保存ダイアログはページ側に出る
    } catch (e) { flash(errText(e)); }
  });
  setupMenu();
  $('#gen-back').addEventListener('click', () => { genOpen = false; loadList(); });
  for (const [id, view] of [['seg-frequent', 'frequent'], ['seg-abc', 'abc']]) {
    $('#' + id).addEventListener('click', () => {
      loginView = view;
      try { localStorage.setItem(LOGIN_VIEW_KEY, view); } catch (_) { /* 無視 */ }
      loadList();
    });
  }
  // bg からの状態通知（state を含む）だけを受け取る。他のページが bg へ送る問い合わせ { t: 'state' } も
  // ここに届くため、取り違えると state が undefined になり、例外が問い合わせ元へエラーとして返ってしまう。
  chrome.runtime.onMessage.addListener((m) => { if (m && m.t === 'state' && m.state) { state = m.state; render(); } });
  await refresh();
  if (!state.locked && state.connected) setTimeout(() => $('#q').focus(), 30);
})();
