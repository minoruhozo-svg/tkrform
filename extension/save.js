'use strict';
// 保存ダイアログ（§8.4）。ページ右上に iframe で出る。パスワードはこのページには渡らず、bg が保持する。

const token = new URLSearchParams(location.search).get('token');
let data = null;
let existing = []; // 保管庫のログイン（名前の重複の確認用）: { name, folder }

const isUpdate = () => !!(data && data.check && data.check.action === 'update');
const asNewChecked = () => $('#as-new').checked;
const takenName = (name, folder) => existing.some((e) => e.name.toLowerCase() === name.toLowerCase() && (e.folder || '/') === (folder || '/'));

/** 同じフォルダに同じ名前があれば、「(2)」「(3)」...を付けて重複を避ける。 */
function uniqueName(base, folder) {
  if (!takenName(base, folder)) return base;
  for (let i = 2; i < 1000; i++) if (!takenName(`${base} (${i})`, folder)) return `${base} (${i})`;
  return base;
}

/** 更新 ↔ 新しいログインとして保存の切り替え: 名前の欄とボタンの表示を合わせる。 */
function syncAsNew() {
  const asNew = asNewChecked();
  $('#name').disabled = isUpdate() && !asNew;
  $('#folder').disabled = isUpdate() && !asNew;
  $('#save').textContent = isUpdate() && !asNew ? t('Ext_Save_Update') : t('Common_Save');
  if (isUpdate()) {
    if (asNew) {
      // 新しい名前の入力用に切り替える（既定はサイトのドメイン。同名があれば「(2)」などを付ける）。全体を選択してフォーカスする
      $('#folder').value = $('#folder').value || '/';
      $('#name').value = uniqueName(data.defaultName, $('#folder').value);
      $('#name').focus(); $('#name').select();
    } else {
      $('#name').value = data.check.name; // チェックを外したら、既存の名前に戻す
      $('#folder').value = '/';
    }
  }
  showErr('');
}

const closeSelf = () => {
  bg({ t: 'closeSave' }).catch(() => {});
  try { parent.postMessage({ t: 'close' }, '*'); } catch (_) { /* 無視 */ }
};

function fitHeight() {
  try { parent.postMessage({ t: 'resize', height: document.documentElement.scrollHeight + 4 }, '*'); } catch (_) { /* 無視 */ }
}

function showErr(text) {
  const e = $('#err');
  e.textContent = text;
  e.classList.toggle('hidden', !text);
  fitHeight();
}

async function load() {
  try {
    data = await bg({ t: 'getSaveData', token });
  } catch (_) { closeSelf(); return; }
  const update = data.check && data.check.action === 'update';
  // フォルダの一覧と既存の名前を先に読んでから、フォームを見せる（見せたあとで中身や高さが変わると、押した位置がずれる）
  let folders = [];
  if (!data.locked) {
    try { folders = await rpc('listFolders'); } catch (_) { /* 無視 */ }
    try { existing = (await searchAll('', [1])).map((e) => ({ name: e.name, folder: e.folder })); } catch (_) { existing = []; }
  }
  const titleKey = update ? 'Ext_Save_TitleUpdate' : data.kind === 'signup' ? 'Ext_Save_TitleSignup' : data.kind === 'change' ? 'Ext_Save_TitleChange' : 'Ext_Save_Title';
  $('#title').textContent = t(titleKey);
  const host = (() => { try { return new URL(data.url).host; } catch (_) { return data.url; } })();
  $('#who').textContent = (data.user ? data.user + ' @ ' : '') + host;
  $('#locked').classList.toggle('hidden', !data.locked);
  $('#form').classList.toggle('hidden', data.locked);
  $('#btns').classList.toggle('hidden', data.locked);
  $('#save').textContent = update ? t('Ext_Save_Update') : t('Common_Save');
  if (!data.locked) {
    $('#name').value = update ? data.check.name : data.defaultName;
    $('#name').disabled = update;
    $('#as-new-row').classList.toggle('hidden', !update);
    $('#folder').disabled = update;
    $('#folder').replaceChildren(el('option', { value: '/', text: t('Ext_Save_Root') }), ...folders.map((f) => el('option', { value: f, text: f })));
    if (!update) $('#name').value = uniqueName(data.defaultName, '/');
  }
  fitHeight();
}

(async () => {
  applyI18n();
  $('#unlock').addEventListener('click', async () => {
    try { await rpc('unlock', { password: $('#mp').value }); $('#mp').value = ''; showErr(''); await load(); }
    catch (e) { showErr(errText(e)); }
  });
  // ロック中の画面でも、保存を取りやめられる（保持しているパスワードも破棄する）
  $('#cancel-locked').addEventListener('click', async () => { await bg({ t: 'dropSave', token }).catch(() => {}); closeSelf(); });
  $('#mp').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#unlock').click(); });
  $('#save').addEventListener('click', async () => {
    $('#save').disabled = true;
    try {
      const asNew = $('#as-new').checked;
      const mode = asNew ? 'new' : (data.check && data.check.action === 'update' ? 'update' : 'new');
      const name = $('#name').value.trim();
      const folder = $('#folder').value || '/';
      // 新しいログインとして保存するときは、名前が空・同じフォルダで重複していたら保存しない
      if (mode === 'new') {
        if (!name) { showErr(t('Ext_Save_NameEmpty')); $('#save').disabled = false; $('#name').focus(); return; }
        if (takenName(name, folder)) { showErr(t('Ext_Save_NameDup')); $('#save').disabled = false; $('#name').focus(); $('#name').select(); return; }
      }
      await bg({ t: 'doSave', token, name: name || data.defaultName, folder, mode });
      closeSelf();
    } catch (e) { showErr(errText(e)); $('#save').disabled = false; }
  });
  $('#as-new').addEventListener('change', syncAsNew);
  $('#folder').addEventListener('change', () => { if (!isUpdate() || asNewChecked()) showErr(''); });
  $('#skip').addEventListener('click', async () => { await bg({ t: 'dropSave', token }).catch(() => {}); closeSelf(); });
  $('#never').addEventListener('click', async () => { await bg({ t: 'neverHere', token }).catch(() => {}); closeSelf(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSelf(); });
  await load();
  if (data && !data.locked) $('#save').focus(); else $('#mp').focus();
})();
