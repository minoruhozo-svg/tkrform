'use strict';
// エディタ（§10.2）: 左にフォルダツリーと種別フィルタ、中央にアイテム一覧、右に詳細と編集。

const ROW_H = 46;
const VIEWS = [['all', 'View_All'], ['login', 'View_Logins'], ['identity', 'View_Identities'], ['note', 'View_Notes'], ['fav', 'View_Favorites'], ['trash', 'View_Trash']];

const S = {
  entries: [], byId: new Map(), folders: [],
  view: 'all', folder: null, q: '', sort: 'name',
  sel: new Set(), anchor: -1, rows: [],
  cur: null, orig: '', isNew: false, dirty: false, savedTotpKey: '',
  undo: [], redo: [], clip: null, dragIds: null, dragFolder: null,
};

const joinFolder = (parent, name) => (parent === '/' || !parent ? '/' + name : parent.replace(/\/$/, '') + '/' + name);
const inFolder = (path, base) => path === base || path.startsWith(base.replace(/\/$/, '') + '/');
const hostOf = (u) => { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u).host; } catch (_) { return u; } };

// ------------------------------------------------------------------ 読み込み

async function reload() {
  const [entries, folders] = await Promise.all([rpc('listEntries'), rpc('listFolders')]);
  S.entries = entries;
  S.byId = new Map(entries.map((e) => [e.id, e]));
  S.folders = folders;
  for (const id of [...S.sel]) if (!S.byId.has(id)) S.sel.delete(id);
  renderViews(); renderTree(); renderList();
}

// 「よく使う」の点数（tkrform-core の popularity_score と同じ式: 半減期 14 日で減衰）。点数のない項目（取り込んだ項目など）は、使用回数を最後の使用日時の時点の点数とみなす
const POPULARITY_HALF_LIFE_DAYS = 14;
function popularity(e, now) {
  const at = e.scoreAt || (e.useCount ? e.lastUsed : null);
  const base = e.scoreAt ? (e.useScore || 0) : (e.useCount || 0);
  if (!base) return 0;
  const t = at ? Date.parse(at) : NaN;
  if (Number.isNaN(t)) return base;
  return base * 0.5 ** (Math.max(0, now - t) / 86400000 / POPULARITY_HALF_LIFE_DAYS);
}

function filtered() {
  const q = S.q.trim().toLowerCase();
  const inTrash = S.view === 'trash';
  let a = S.entries.filter((e) => e.type !== TYPE_FOLDER && (inTrash ? e.deleted : !e.deleted));
  switch (S.view) {
    case 'login': a = a.filter((e) => e.type === TYPE_LOGIN); break;
    case 'identity': a = a.filter((e) => e.type === TYPE_IDENTITY || e.type === TYPE_CONTACT); break;
    case 'note': a = a.filter((e) => e.type === TYPE_NOTE); break;
    case 'fav': a = a.filter((e) => e.favorite); break;
    default: break;
  }
  if (S.folder) a = a.filter((e) => inFolder(e.folder, S.folder));
  if (q) a = a.filter((e) => e.name.toLowerCase().includes(q) || (e.user || '').toLowerCase().includes(q) || (e.url || '').toLowerCase().includes(q));
  const cmpName = (x, y) => x.name.localeCompare(y.name, 'ja');
  if (S.sort === 'modified') a.sort((x, y) => (y.modified || '').localeCompare(x.modified || ''));
  else if (S.sort === 'usage') {
    // 点数は、並べる前に項目ごとに 1 回だけ計算する（日時の解析を、比較のたびにしない）
    const now = Date.now();
    const score = new Map(a.map((e) => [e, popularity(e, now)]));
    a.sort((x, y) => (y.favorite - x.favorite) || (score.get(y) - score.get(x)) || ((y.lastUsed || '').localeCompare(x.lastUsed || '')) || cmpName(x, y));
  }
  else a.sort(cmpName);
  return a;
}

// ------------------------------------------------------------------ 左ペイン

function renderViews() {
  const ul = $('#views');
  ul.replaceChildren();
  const live = S.entries.filter((e) => !e.deleted && e.type !== TYPE_FOLDER);
  const count = {
    all: live.length, login: live.filter((e) => e.type === TYPE_LOGIN).length,
    identity: live.filter((e) => e.type === TYPE_IDENTITY || e.type === TYPE_CONTACT).length, note: live.filter((e) => e.type === TYPE_NOTE).length,
    fav: live.filter((e) => e.favorite).length, trash: S.entries.filter((e) => e.deleted && e.type !== TYPE_FOLDER).length,
  };
  for (const [id, key] of VIEWS) {
    ul.append(el('li', { role: 'option', 'aria-selected': String(S.view === id && !S.folder), onclick: () => setView(id, null) },
      el('span', { text: t(key) }), el('span', { class: 'count', text: count[id] })));
  }
}

// フォルダ `src` を `dst`（'/' はルート）の中へ落とせるか。自分自身・子孫・今の親（動かない）は不可
function canDropFolder(src, dst) {
  if (dst === src || inFolder(dst, src)) return false;
  const parent = src.slice(0, src.lastIndexOf('/')) || '/';
  return dst !== parent;
}

// ドラッグ中: 落とせる先を強調し、落とせない先（自分自身・子孫）を薄く「禁止」表示にする
function markDropTargets() {
  const src = S.dragFolder;
  $$('#tree li[data-path]').forEach((li) => li.classList.add(canDropFolder(src, li.dataset.path) ? 'can-drop' : 'no-drop'));
  $('#folders-title').classList.add(canDropFolder(src, '/') ? 'can-drop' : 'no-drop');
}
function clearDropMarks() {
  $$('#tree li, #folders-title').forEach((n) => n.classList.remove('can-drop', 'no-drop', 'drop'));
}

function renderTree() {
  const ul = $('#tree');
  ul.replaceChildren();
  const live = S.entries.filter((e) => !e.deleted && e.type !== TYPE_FOLDER);
  for (const path of S.folders) {
    const depth = path.split('/').filter(Boolean).length - 1;
    const name = path.split('/').pop();
    const n = live.filter((e) => inFolder(e.folder, path)).length;
    const li = el('li', {
      role: 'treeitem', 'aria-selected': String(S.folder === path), style: `padding-left:${14 + depth * 14}px`,
      onclick: () => setView('all', path),
      oncontextmenu: (ev) => { ev.preventDefault(); folderMenu(ev, path); },
      draggable: true, dataset: { path },
      ondragstart: (ev) => { S.dragFolder = path; S.dragIds = null; ev.dataTransfer.setData('text/plain', 'tkrform-folder'); ev.dataTransfer.effectAllowed = 'move'; markDropTargets(); },
      ondragend: () => { S.dragFolder = null; clearDropMarks(); },
      ondragover: (ev) => {
        if (S.dragFolder && !canDropFolder(S.dragFolder, path)) { ev.dataTransfer.dropEffect = 'none'; return; } // 自分自身・子孫の上では落とせない
        if (S.dragIds || S.dragFolder) { ev.preventDefault(); li.classList.add('drop'); }
      },
      ondragleave: () => li.classList.remove('drop'),
      ondrop: (ev) => {
        ev.preventDefault(); li.classList.remove('drop'); clearDropMarks();
        if (S.dragFolder && !canDropFolder(S.dragFolder, path)) { S.dragFolder = null; return; }
        if (S.dragFolder) moveFolder(S.dragFolder, path);
        else if (S.dragIds) moveItems([...S.dragIds], path);
        S.dragIds = null; S.dragFolder = null;
      },
    }, el('span', { text: '📁' }), el('span', { text: name }), el('span', { class: 'count', text: n }));
    ul.append(li);
  }
  if (!S.folders.length) ul.append(el('li', { class: 'sub', text: t('Editor_NoFolders') }));
}

async function setView(view, folder) {
  if (!(await confirmDiscard())) return;
  S.view = view; S.folder = folder; S.sel.clear(); S.anchor = -1;
  $('#list').scrollTop = 0;
  renderViews(); renderTree(); renderList(); showEmpty();
}

function folderMenu(ev, path) {
  showMenu(ev.clientX, ev.clientY, [
    { label: t('Folder_NewSub'), onclick: () => newFolder(path) },
    { label: t('Cmd_Rename'), onclick: () => renameFolder(path) },
    { label: t('Folder_Move'), onclick: () => folderMoveDialog(path) },
    { sep: true },
    { label: t('Folder_Delete'), onclick: () => deleteFolder(path) },
  ]);
}

// ------------------------------------------------------------------ 中央ペイン（仮想スクロール）

function renderList() {
  S.rows = filtered();
  $('#spacer').style.height = S.rows.length * ROW_H + 'px';
  $('#list-count').textContent = t('Editor_Count', S.rows.length);
  $('#trash-bar').classList.toggle('hidden', S.view !== 'trash');
  paintRows();
}

function paintRows() {
  const list = $('#list'), sp = $('#spacer');
  const start = Math.max(0, Math.floor(list.scrollTop / ROW_H) - 4);
  const end = Math.min(S.rows.length, start + Math.ceil(list.clientHeight / ROW_H) + 9);
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const e = S.rows[i];
    const sub = e.type === TYPE_LOGIN ? [e.user, hostOf(e.url)].filter(Boolean).join('  ') : e.type === TYPE_BOOKMARK ? e.url : '';
    const row = el('div', {
      class: 'rowitem', role: 'option', 'aria-selected': String(S.sel.has(e.id)), style: `top:${i * ROW_H}px`, draggable: true,
      onclick: (ev) => clickRow(ev, i),
      ondblclick: () => activateRow(e),
      oncontextmenu: (ev) => { ev.preventDefault(); rowMenu(ev, i); },
      ondragstart: (ev) => {
        // 注意: ここで行を作り直す（paintRows）と、ドラッグ元の要素が消えてドラッグが取り消される
        if (!S.sel.has(e.id)) { S.sel = new Set([e.id]); ev.currentTarget.setAttribute('aria-selected', 'true'); }
        S.dragIds = new Set(S.sel); ev.dataTransfer.setData('text/plain', 'tkrform'); ev.dataTransfer.effectAllowed = 'move'; },
      ondragend: () => { S.dragIds = null; },
    },
      el('span', { class: 'badge t' + e.type + (e.corrupt ? ' bad' : ''), text: e.corrupt ? '!' : t('Badge_' + e.type) }),
      el('div', { class: 'grow' }, el('div', { class: 'name', text: e.name }), el('div', { class: 'meta', text: sub })),
      e.corrupt ? el('span', { class: 'tag-bad', text: t('Item_Corrupt') }) : null,
      e.hasPasskey ? el('span', { class: 'star', text: '🔑', title: t('Pk_Badge'), 'aria-label': t('Pk_Badge') }) : null,
      e.favorite ? el('span', { class: 'star', text: '★', 'aria-label': t('Item_Favorite') }) : null);
    frag.append(row);
  }
  Array.from(sp.children).forEach((c) => c.remove());
  sp.append(frag);
}

async function clickRow(ev, i) {
  const e = S.rows[i];
  if (!(await confirmDiscard())) return;
  if (ev.shiftKey && S.anchor >= 0) {
    const [a, b] = [Math.min(S.anchor, i), Math.max(S.anchor, i)];
    S.sel = new Set(S.rows.slice(a, b + 1).map((x) => x.id));
  } else if (ev.ctrlKey || ev.metaKey) {
    if (S.sel.has(e.id)) S.sel.delete(e.id); else S.sel.add(e.id);
    S.anchor = i;
  } else {
    S.sel = new Set([e.id]); S.anchor = i;
  }
  paintRows();
  await selectionChanged();
}

async function selectionChanged() {
  if (S.sel.size === 1) await loadItem([...S.sel][0]);
  else if (S.sel.size > 1) showMulti();
  else showEmpty();
}

function activateRow(e) {
  if (e.type === TYPE_LOGIN) fillLogin([e.id], 'tab', 'item');
  else if (e.type === TYPE_BOOKMARK) fillLogin([e.id], 'go');
  else if (e.type === TYPE_APP) rpc('fillApp', { id: e.id }).then((r) => toast(t('App_Filled', r.filled))).catch(showError);
}

function rowMenu(ev, i) {
  const e = S.rows[i];
  if (!S.sel.has(e.id)) { S.sel = new Set([e.id]); S.anchor = i; paintRows(); selectionChanged(); }
  const ids = [...S.sel];
  const one = ids.length === 1;
  const isLogin = one && e.type === TYPE_LOGIN;
  const hasUrl = one && (e.type === TYPE_LOGIN || e.type === TYPE_BOOKMARK);
  if (S.view === 'trash') {
    showMenu(ev.clientX, ev.clientY, [
      { label: t('Trash_Restore'), onclick: () => restoreItems(ids) },
      { label: t('Trash_Purge'), onclick: () => purgeItems(ids) },
    ]);
    return;
  }
  showMenu(ev.clientX, ev.clientY, [
    { label: t('Menu_FillApp'), disabled: !(one && e.type === TYPE_APP), onclick: () => activateRow(e) },
    { label: t('Menu_Login'), disabled: !isLogin, onclick: () => fillLogin(ids, 'tab', 'item') },
    { label: t('Menu_LoginCurrent'), disabled: !isLogin, onclick: () => fillLogin(ids, 'current', 'item') },
    { label: t('Menu_LoginWindow'), disabled: !isLogin, onclick: () => fillLogin(ids, 'window', 'item') },
    { label: t('Menu_GoFill'), disabled: !isLogin, onclick: () => fillLogin(ids, 'tab', false) },
    { label: t('Menu_Go'), disabled: !hasUrl, onclick: () => fillLogin(ids, 'go') },
    { label: t('Menu_BatchLogin'), disabled: ids.length < 2, onclick: () => batchLogin(ids) },
    { sep: true },
    { label: t('Menu_CopyUrl'), disabled: !hasUrl, onclick: () => copyPlain(e.url) },
    { label: t('Cmd_Duplicate'), disabled: !one, onclick: () => duplicateItem(ids[0]) },
    { label: t('Cmd_Rename'), disabled: !one, onclick: renameSelected },
    { label: t('Cmd_Move'), onclick: () => moveDialog(ids) },
    { label: e.favorite ? t('Menu_Unfavorite') : t('Menu_Favorite'), onclick: () => toggleFavorite(ids, !e.favorite) },
    { sep: true },
    { label: t('Cmd_Print'), onclick: () => printDialog(ids) },
    { label: t('Cmd_Delete'), onclick: () => deleteItems(ids) },
  ]);
}

// ------------------------------------------------------------------ 右ペイン

function showEmpty() {
  S.cur = null; S.dirty = false; S.isNew = false;
  $('#detail').replaceChildren(el('div', { class: 'empty', text: t('Editor_SelectItem') }));
}

function showMulti() {
  S.cur = null; S.dirty = false;
  const ids = [...S.sel];
  const logins = ids.filter((id) => (S.byId.get(id) || {}).type === TYPE_LOGIN);
  $('#detail').replaceChildren(el('div', { class: 'form' },
    el('h1', { text: t('Editor_MultiSelected', ids.length) }),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'primary', text: t('Menu_BatchLogin'), disabled: logins.length < 1, onclick: () => batchLogin(ids) }),
      el('button', { type: 'button', text: t('Cmd_Move'), onclick: () => moveDialog(ids) }),
      el('button', { type: 'button', text: t('Cmd_Print'), onclick: () => printDialog(ids) }),
      el('button', { type: 'button', class: 'danger', text: S.view === 'trash' ? t('Trash_Purge') : t('Cmd_Delete'), onclick: () => (S.view === 'trash' ? purgeItems(ids) : deleteItems(ids)) }))));
}

function showCorrupt(e) {
  S.cur = null; S.dirty = false;
  $('#detail').replaceChildren(el('div', { class: 'form' },
    el('h1', { text: t('Item_Corrupt') }),
    el('div', { class: 'msg error', text: t('Item_CorruptBody') }),
    el('div', { class: 'sub selectable', text: 'ID: ' + e.id }),
    el('div', null, el('button', { type: 'button', class: 'danger', text: t('Trash_Purge'), onclick: () => purgeItems([e.id]) }))));
}

async function loadItem(id) {
  const e = S.byId.get(id);
  if (!e) { showEmpty(); return; }
  if (e.corrupt) { showCorrupt(e); return; }
  if (e.deleted) { showTrashDetail(e); return; }
  try {
    const item = await rpc('getItem', { id });
    S.cur = item; S.orig = JSON.stringify(item); S.isNew = false; S.dirty = false; S.savedTotpKey = item.totpKey || '';
    await showForm();
  } catch (er) {
    if (/破損|corrupt/i.test(er.message)) { e.corrupt = true; renderList(); showCorrupt(e); } else showError(er);
  }
}

function showTrashDetail(e) {
  S.cur = null; S.dirty = false;
  $('#detail').replaceChildren(el('div', { class: 'form' },
    el('h1', { text: e.name }),
    el('div', { class: 'msg warn', text: t('Trash_ItemNote', fmtDate(e.deletedAt)) }),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'primary', text: t('Trash_Restore'), onclick: () => restoreItems([e.id]) }),
      el('button', { type: 'button', class: 'danger', text: t('Trash_Purge'), onclick: () => purgeItems([e.id]) }))));
}

async function showForm() {
  const ctx = {
    isNew: S.isNew, savedTotpKey: S.savedTotpKey,
    changed: () => { S.dirty = S.isNew || JSON.stringify(S.cur) !== S.orig; updateDirtyUi(); },
    onSave: saveCur,
    // パスキーを削除したあと: 保管庫の最新の一覧に差し替える（編集中のほかの変更は残す）
    passkeysChanged: async () => {
      const fresh = await rpc('getItem', { id: S.cur.id });
      S.cur.passkeys = fresh.passkeys || [];
      const o = JSON.parse(S.orig); o.passkeys = S.cur.passkeys; S.orig = JSON.stringify(o);
      await reload(); paintRows();
      await showForm();
    },
    onRevert: async () => { if (S.isNew) { showEmpty(); } else { S.dirty = false; await loadItem(S.cur.id); } },
  };
  await renderForm($('#detail'), S.cur, ctx);
  updateDirtyUi();
}

function updateDirtyUi() {
  const s = $('#f-save'), r = $('#f-revert');
  if (s) s.disabled = !S.dirty;
  if (r) r.disabled = !S.dirty && !S.isNew;
}

async function confirmDiscard() {
  if (!S.dirty) return true;
  const ok = await dialog.confirm(t('Editor_DiscardConfirm'), { danger: true, okLabel: t('Editor_Discard') });
  if (ok) S.dirty = false;
  return ok;
}

// ------------------------------------------------------------------ 保存・Undo

function pushUndo(op) { S.undo.push(op); S.redo = []; if (S.undo.length > 100) S.undo.shift(); updateUndoUi(); }
function updateUndoUi() { $('#b-undo').disabled = !S.undo.length; $('#b-redo').disabled = !S.redo.length; }

async function saveCur() {
  const item = S.cur;
  if (!item || !S.dirty) return;
  if (!(item.name || '').trim()) { toast(t('Err_NameEmpty'), 'error'); return; }
  try {
    let id;
    if (S.isNew) {
      const r = await rpc('saveItem', { item, mode: 'new' });
      id = r.id;
      pushUndo({ kind: 'save', before: null, id, after: await rpc('getItem', { id }) });
    } else {
      const before = JSON.parse(S.orig);
      await rpc('saveItem', { item, mode: 'update', replace: true });
      id = item.id;
      pushUndo({ kind: 'save', before, id, after: await rpc('getItem', { id }) });
    }
    S.dirty = false;
    await reload();
    S.sel = new Set([id]);
    const idx = S.rows.findIndex((r) => r.id === id);
    S.anchor = idx;
    scrollToIndex(idx);
    paintRows();
    await loadItem(id);
    toast(t('Editor_Saved'));
  } catch (e) { showError(e); }
}

function scrollToIndex(i) {
  if (i < 0) return;
  const list = $('#list');
  const top = i * ROW_H;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (top + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_H - list.clientHeight;
}

async function replaceItem(obj) { await rpc('saveItem', { item: obj, mode: 'update', replace: true }); }

async function applyOp(op, forward) {
  switch (op.kind) {
    case 'save':
      if (forward) { if (!op.before) await rpc('restoreItem', { id: op.id }); await replaceItem(op.after); }
      else if (op.before) await replaceItem(op.before);
      else await rpc('deleteItem', { id: op.id });
      break;
    case 'delete':
      for (const id of op.ids) await rpc(forward ? 'deleteItem' : 'restoreItem', { id });
      break;
    case 'dup':
      for (const id of op.ids) await rpc(forward ? 'restoreItem' : 'deleteItem', { id });
      break;
    case 'movefolder':
      if (forward) await rpc('moveFolder', { path: op.path, to: op.to });
      else await rpc('moveFolder', { path: op.now, to: op.parent });
      break;
    case 'move':
      if (forward) await rpc('moveItems', { ids: op.moves.map((m) => m.id), folder: op.to });
      else {
        const by = new Map();
        for (const m of op.moves) { if (!by.has(m.from)) by.set(m.from, []); by.get(m.from).push(m.id); }
        for (const [from, ids] of by) await rpc('moveItems', { ids, folder: from });
      }
      break;
    default: break;
  }
}

async function undo() {
  if (!(await confirmDiscard())) return;
  const op = S.undo.pop();
  if (!op) return;
  try { await applyOp(op, false); S.redo.push(op); await afterOp(); } catch (e) { showError(e); }
  updateUndoUi();
}

async function redo() {
  if (!(await confirmDiscard())) return;
  const op = S.redo.pop();
  if (!op) return;
  try { await applyOp(op, true); S.undo.push(op); await afterOp(); } catch (e) { showError(e); }
  updateUndoUi();
}

async function afterOp() {
  await reload();
  if (S.sel.size === 1) await loadItem([...S.sel][0]); else showEmpty();
}

// ------------------------------------------------------------------ 操作

function selectedIds() { return [...S.sel]; }

async function newItem(type) {
  if (!(await confirmDiscard())) return;
  const folder = S.folder || '/';
  const base = { type, name: '', folder, favorite: false };
  if (type === TYPE_LOGIN) Object.assign(base, { url: '', fields: [{ name: 'username', id: '', value: '', kind: 'text', role: 'user' }, { name: 'password', id: '', value: '', kind: 'password', role: 'password' }] });
  if (type === TYPE_IDENTITY || type === TYPE_CONTACT) Object.assign(base, { country: 'JP', groups: [] });
  if (type === TYPE_NOTE) Object.assign(base, { text: '' });
  if (type === TYPE_APP) Object.assign(base, { exePath: '', windowTitle: '', fields: [] });
  S.cur = base; S.isNew = true; S.dirty = true; S.orig = ''; S.savedTotpKey = '';
  S.sel.clear(); paintRows();
  await showForm();
}

async function newFolder(parent) {
  const base = parent || S.folder || '/';
  const name = await dialog.prompt(t('Folder_NamePrompt'), '', { title: t('Cmd_NewFolder') });
  if (!name || !name.trim()) return;
  try {
    await rpc('createFolder', { path: joinFolder(base, name.trim()) });
    await reload();
  } catch (e) { showError(e); }
}

async function renameFolder(path) {
  const cur = path.split('/').pop();
  const name = await dialog.prompt(t('Folder_NamePrompt'), cur, { title: t('Cmd_Rename') });
  if (!name || !name.trim() || name === cur) return;
  try {
    const r = await rpc('renameFolder', { path, name: name.trim() });
    if (S.folder && inFolder(S.folder, path)) S.folder = r.path + S.folder.slice(path.length);
    await reload();
  } catch (e) { showError(e); }
}

async function deleteFolder(path) {
  const ids = S.entries.filter((e) => !e.deleted && (e.type === TYPE_FOLDER ? inFolder(joinFolder(e.folder, e.name), path) : inFolder(e.folder, path))).map((e) => e.id);
  const n = ids.filter((id) => S.byId.get(id).type !== TYPE_FOLDER).length;
  if (!(await dialog.confirm(t('Folder_DeleteConfirm', path, n), { danger: true, okLabel: t('Folder_Delete') }))) return;
  try {
    await rpc('deleteFolder', { path });
    pushUndo({ kind: 'delete', ids });
    if (S.folder && inFolder(S.folder, path)) S.folder = null;
    await reload(); showEmpty();
    toast(t('Editor_Trashed', n));
  } catch (e) { showError(e); }
}

async function deleteItems(ids) {
  if (!ids.length) return;
  if (S.view === 'trash') { purgeItems(ids); return; }
  if (!(await confirmDiscard())) return;
  try {
    for (const id of ids) await rpc('deleteItem', { id });
    pushUndo({ kind: 'delete', ids });
    S.sel.clear();
    await reload(); showEmpty();
    toast(t('Editor_Trashed', ids.length));
  } catch (e) { showError(e); }
}

async function restoreItems(ids) {
  try {
    for (const id of ids) await rpc('restoreItem', { id });
    pushUndo({ kind: 'dup', ids });
    S.sel.clear(); await reload(); showEmpty();
    toast(t('Trash_Restored', ids.length));
  } catch (e) { showError(e); }
}

// 完全削除は必ず確認ダイアログを経る（§10.2）
async function purgeItems(ids) {
  const names = ids.slice(0, 5).map((id) => (S.byId.get(id) || { name: id }).name).join('、') + (ids.length > 5 ? '…' : '');
  const ok = await dialog.confirm(t('Trash_PurgeConfirm', ids.length, names), { danger: true, okLabel: t('Trash_Purge') });
  if (!ok) return;
  try {
    await rpc('purgeItem', { ids });
    S.sel.clear(); await reload(); showEmpty();
    toast(t('Trash_Purged', ids.length));
  } catch (e) { showError(e); }
}

async function emptyTrash() {
  const ids = S.entries.filter((e) => e.deleted).map((e) => e.id);
  if (!ids.length) return;
  await purgeItems(ids);
}

async function duplicateItem(id) {
  try {
    const r = await rpc('duplicateItem', { id });
    pushUndo({ kind: 'dup', ids: [r.id] });
    await reload();
    S.sel = new Set([r.id]);
    S.anchor = S.rows.findIndex((x) => x.id === r.id);
    scrollToIndex(S.anchor); paintRows();
    await loadItem(r.id);
  } catch (e) { showError(e); }
}

async function moveItems(ids, folder) {
  const moves = ids.map((id) => ({ id, from: (S.byId.get(id) || {}).folder || '/' }));
  try {
    await rpc('moveItems', { ids, folder });
    pushUndo({ kind: 'move', moves, to: folder });
    await reload();
    if (S.sel.size === 1) await loadItem([...S.sel][0]);
  } catch (e) { showError(e); }
}

// フォルダを別のフォルダの中へ（to='/' でルート）。元に戻せる
async function moveFolder(path, to) {
  if (!(await confirmDiscard())) return;
  const parent = path.slice(0, path.lastIndexOf('/')) || '/';
  try {
    const r = await rpc('moveFolder', { path, to });
    if (r.path !== path) {
      pushUndo({ kind: 'movefolder', path, to, now: r.path, parent });
      toast(t('Folder_Moved'));
    }
    // 移動したフォルダを選択状態にする（ツリーは常に全部展開しているので、移動先も開いて見える）
    S.view = 'all'; S.folder = r.path; S.sel.clear(); S.anchor = -1;
    await reload();
    showEmpty();
    const li = $$('#tree li[data-path]').find((x) => x.dataset.path === r.path);
    if (li) li.scrollIntoView({ block: 'nearest' });
  } catch (e) { showError(e); }
}

async function folderMoveDialog(path) {
  const name = path.split('/').pop();
  const target = await openDialog((f, close) => {
    const sel = el('select', { 'aria-label': t('Cmd_Move') });
    sel.append(el('option', { value: '/', text: t('Folder_Root') }));
    for (const p of S.folders) if (!inFolder(p, path)) sel.append(el('option', { value: p, text: p }));
    f.append(el('div', { class: 'title', text: t('Folder_MoveTitle', name) }), sel,
      el('div', { class: 'actions' },
        el('button', { type: 'button', text: t('Common_Cancel'), onclick: () => close(null) }),
        el('button', { type: 'submit', class: 'primary', text: t('Cmd_Move'), onclick: (e) => { e.preventDefault(); close(sel.value); } })));
  });
  if (target !== null) await moveFolder(path, target);
}

async function moveDialog(ids) {
  const target = await openDialog((f, close) => {
    const sel = el('select', { 'aria-label': t('Cmd_Move') });
    sel.append(el('option', { value: '/', text: t('Folder_Root') }));
    for (const p of S.folders) sel.append(el('option', { value: p, text: p }));
    sel.append(el('option', { value: '\u0000new', text: t('Folder_NewOption') }));
    f.append(el('div', { class: 'title', text: t('Move_Title', ids.length) }), sel,
      el('div', { class: 'actions' },
        el('button', { type: 'button', text: t('Common_Cancel'), onclick: () => close(null) }),
        el('button', { type: 'submit', class: 'primary', text: t('Cmd_Move'), onclick: (e) => { e.preventDefault(); close(sel.value); } })));
  });
  if (target === null) return;
  let folder = target;
  if (target === '\u0000new') {
    const name = await dialog.prompt(t('Folder_NamePrompt'), '');
    if (!name || !name.trim()) return;
    folder = joinFolder('/', name.trim());
  }
  await moveItems(ids, folder);
}

async function toggleFavorite(ids, fav) {
  try {
    for (const id of ids) {
      const it = await rpc('getItem', { id });
      it.favorite = fav;
      await rpc('saveItem', { item: it, mode: 'update', replace: true });
    }
    await reload();
    if (S.sel.size === 1 && !S.dirty) await loadItem([...S.sel][0]);
  } catch (e) { showError(e); }
}

function renameSelected() {
  const n = $('#f-name');
  if (n) { n.focus(); n.select(); }
}

async function fillLogin(ids, mode, submit) {
  try {
    if (mode === 'go') await rpc('fillLogin', { id: ids[0], mode: 'go' });
    // 'item': 項目の「記入後に送信する」の設定に従う（送信するのは、チェックが入っているときだけ）
    else await rpc('fillLogin', { id: ids[0], mode, submit: submit === 'item' ? null : submit === true });
    if (mode !== 'current' && mode !== 'go') toast(t('Editor_LoginStarted'));
  } catch (e) { showError(e); }
}

async function batchLogin(ids) {
  const n = ids.filter((id) => (S.byId.get(id) || {}).type === TYPE_LOGIN).length;
  if (n > 8 && !(await dialog.confirm(t('Batch_Confirm', n), { okLabel: t('Menu_BatchLogin') }))) return;
  try { await rpc('batchLogin', { ids }); } catch (e) { showError(e); }
}

// コピー・切り取り・貼り付け（アイテム単位。フォルダ間の移動に使う）
function clipSet(mode) {
  if (!S.sel.size) return;
  S.clip = { mode, ids: [...S.sel] };
  toast(t(mode === 'copy' ? 'Clip_Copied' : 'Clip_Cut', S.sel.size));
}

async function clipPaste() {
  if (!S.clip || !S.clip.ids.length) return;
  const folder = S.folder || '/';
  if (S.clip.mode === 'cut') {
    await moveItems(S.clip.ids, folder);
    S.clip = null;
    return;
  }
  try {
    const created = [];
    for (const id of S.clip.ids) {
      const r = await rpc('duplicateItem', { id });
      created.push(r.id);
    }
    await rpc('moveItems', { ids: created, folder });
    pushUndo({ kind: 'dup', ids: created });
    await reload();
    toast(t('Clip_Pasted', created.length));
  } catch (e) { showError(e); }
}

// ------------------------------------------------------------------ メニュー

let openMenu = null;
function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }

function showMenu(x, y, items) {
  closeMenu();
  const m = el('div', { class: 'ctxmenu', role: 'menu' });
  for (const it of items) {
    if (it.sep) { m.append(el('hr')); continue; }
    m.append(el('button', { type: 'button', role: 'menuitem', text: it.label, disabled: !!it.disabled, onclick: () => { closeMenu(); it.onclick(); } }));
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  openMenu = m;
  const first = $('button:not(:disabled)', m);
  if (first) first.focus();
}

function menuBelow(btn, items) {
  const r = btn.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, items);
}

document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// ------------------------------------------------------------------ キーボード

function typing(e) { return e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement; }

document.addEventListener('keydown', async (e) => {
  if (document.querySelector('dialog[open]') || $('#lock-overlay')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); saveCur(); return; }
  if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
  if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); newItem(TYPE_LOGIN); return; }
  if (typing(e)) return;
  if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); clipSet('copy'); }
  else if (ctrl && e.key.toLowerCase() === 'x') { e.preventDefault(); clipSet('cut'); }
  else if (ctrl && e.key.toLowerCase() === 'v') { e.preventDefault(); clipPaste(); }
  else if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); S.sel = new Set(S.rows.map((r) => r.id)); paintRows(); selectionChanged(); }
  else if (e.key === 'Delete') { e.preventDefault(); deleteItems(selectedIds()); }
  else if (e.key === 'F2') { e.preventDefault(); renameSelected(); }
  else if (e.key === 'Enter' && S.sel.size === 1) { activateRow(S.byId.get([...S.sel][0])); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const cur = S.rows.findIndex((r) => S.sel.has(r.id));
    const next = Math.max(0, Math.min(S.rows.length - 1, (cur < 0 ? -1 : cur) + (e.key === 'ArrowDown' ? 1 : -1)));
    if (!S.rows[next] || !(await confirmDiscard())) return;
    S.sel = new Set([S.rows[next].id]); S.anchor = next;
    scrollToIndex(next); paintRows(); selectionChanged();
  }
});

// ------------------------------------------------------------------ 初期化

(async () => {
  await initI18n();
  await LockGuard.init(async () => { await reload(); });
  // 自動バックアップが失敗していたら（保存先に書けないなど）知らせる。黙って既定の場所に切り替えることはしない
  rpc('backupStatus').then((st) => { if (st && st.lastError) toast(t('Backup_LastError', st.lastError), 'error'); }).catch(() => {});

  $('#b-new').addEventListener('click', (e) => menuBelow(e.currentTarget, [
    { label: t('Type_Login'), onclick: () => newItem(TYPE_LOGIN) },
    { label: t('Type_Identity'), onclick: () => newItem(TYPE_IDENTITY) },
    { label: t('Type_Contact'), onclick: () => newItem(TYPE_CONTACT) },
    { label: t('Type_Note'), onclick: () => newItem(TYPE_NOTE) },
    { label: t('Type_AppLogin'), onclick: () => newItem(TYPE_APP) },
  ]));
  $('#b-newfolder').addEventListener('click', () => newFolder());
  $('#b-dup').addEventListener('click', () => { if (S.sel.size === 1) duplicateItem([...S.sel][0]); });
  $('#b-rename').addEventListener('click', () => { if (S.sel.size === 1 || S.cur) renameSelected(); else if (S.folder) renameFolder(S.folder); });
  $('#b-move').addEventListener('click', () => { if (S.sel.size) moveDialog(selectedIds()); else if (S.folder) folderMoveDialog(S.folder); });
  // 見出し「フォルダ」へドロップすると最上位へ移る
  const ft = $('#folders-title');
  ft.addEventListener('dragover', (ev) => {
    if (S.dragFolder && !canDropFolder(S.dragFolder, '/')) { ev.dataTransfer.dropEffect = 'none'; return; }
    if (S.dragFolder || S.dragIds) { ev.preventDefault(); ft.classList.add('drop'); }
  });
  ft.addEventListener('dragleave', () => ft.classList.remove('drop'));
  ft.addEventListener('drop', (ev) => {
    ev.preventDefault(); ft.classList.remove('drop'); clearDropMarks();
    if (S.dragFolder && !canDropFolder(S.dragFolder, '/')) { S.dragFolder = null; return; }
    if (S.dragFolder) moveFolder(S.dragFolder, '/'); else if (S.dragIds) moveItems([...S.dragIds], '/');
    S.dragIds = null; S.dragFolder = null;
  });
  $('#b-delete').addEventListener('click', () => {
    if (S.sel.size) deleteItems(selectedIds());
    else if (S.folder) deleteFolder(S.folder);
  });
  $('#b-print').addEventListener('click', () => printDialog(S.sel.size ? selectedIds() : S.rows.map((r) => r.id)));
  $('#b-undo').addEventListener('click', undo);
  $('#b-redo').addEventListener('click', redo);
  $('#b-empty-trash').addEventListener('click', emptyTrash);
  $('#b-more').addEventListener('click', (e) => menuBelow(e.currentTarget, [
    { label: t('Cmd_Import'), onclick: importDialog },
    { label: t('Cmd_Export'), onclick: exportDialog },
    { sep: true },
    { label: t('Cmd_Security'), onclick: () => rpc('openWindow', { name: 'security' }) },
    { label: t('Cmd_Generator'), onclick: () => rpc('openWindow', { name: 'passgen' }) },
    { label: t('Cmd_Settings'), onclick: () => rpc('openWindow', { name: 'settings' }) },
    { label: t('Cmd_ExtHelp'), onclick: () => rpc('openWindow', { name: 'exthelp' }) },
    { sep: true },
    { label: t('Cmd_Lock'), onclick: () => rpc('lock') },
  ]));

  let qTimer = null;
  $('#q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = $('#q').value; renderList(); }, 120); });
  $('#sort').addEventListener('change', () => { S.sort = $('#sort').value; try { localStorage.setItem('tkrform.sort', S.sort); } catch (_) { /* 無視 */ } renderList(); });
  try { const s = localStorage.getItem('tkrform.sort'); if (s) { S.sort = s; $('#sort').value = s; } } catch (_) { /* 無視 */ }
  $('#list').addEventListener('scroll', paintRows);
  window.addEventListener('resize', paintRows);
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

  await TAURI.event.listen('vault-changed', async () => { await reload(); });
  await TAURI.event.listen('select-item', async (ev) => { await selectById(ev.payload.id); });

  updateUndoUi();
  showEmpty();
  const st = await rpc('status');
  if (!st.locked) {
    await reload();
    const id = new URLSearchParams(location.search).get('id');
    if (id) await selectById(id);
  }
})();

async function selectById(id) {
  const e = S.byId.get(id);
  if (!e) return;
  if (!(await confirmDiscard())) return;
  if (e.deleted) S.view = 'trash'; else if (S.view === 'trash') S.view = 'all';
  S.folder = null; S.q = ''; $('#q').value = '';
  renderViews(); renderTree(); renderList();
  S.sel = new Set([id]);
  S.anchor = S.rows.findIndex((r) => r.id === id);
  scrollToIndex(S.anchor); paintRows();
  await loadItem(id);
}
