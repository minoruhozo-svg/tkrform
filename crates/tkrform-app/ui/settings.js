'use strict';
// 設定画面（§16）。保存すると preferences.json に書かれ、自動起動・ホットキー・トレイへ反映される。

const OPT = {
  fillMode: [['off', 'Pref_opt_fill_off'], ['suggest', 'Pref_opt_fill_suggest'], ['auto', 'Pref_opt_fill_auto']],
  fillTarget: [['both', 'Pref_opt_target_both'], ['logins', 'Pref_opt_target_logins'], ['identities', 'Pref_opt_target_identities']],
  saveMode: [['off', 'Pref_opt_save_off'], ['suggest', 'Pref_opt_save_suggest'], ['auto', 'Pref_opt_save_auto']],
  sortOrder: [['auto', 'Pref_opt_sort_auto'], ['count', 'Pref_opt_sort_count'], ['recent', 'Pref_opt_sort_recent']],
  language: [['ja', '日本語'], ['en', 'English']],
  autolock: [[1, 'Pref_opt_min_1'], [5, 'Pref_opt_min_5'], [15, 'Pref_opt_min_15'], [30, 'Pref_opt_min_30'], [60, 'Pref_opt_min_60'], [240, 'Pref_opt_min_240'], [0, 'Pref_opt_unlimited']],
  iterations: [[100000, '100,000'], [300000, '300,000'], [600000, '600,000'], [1000000, '1,000,000'], [2000000, '2,000,000'], [5000000, '5,000,000']],
};

// type: bool | select | number | text | lines(配列を 1 行ずつ) | groups(同等ドメイン: 1 行 1 グループ、カンマ区切り)
const TABS = [
  ['general', [
    ['general.language', 'select', OPT.language],
    ['general.startWithWindows', 'bool'],
    ['general.sortOrder', 'select', OPT.sortOrder],
    ['general.checkUpdates', 'bool'],
    ['general.updateUrl', 'text'],
  ]],
  ['autofill', [
    ['autofill.mode', 'select', OPT.fillMode],
    ['autofill.target', 'select', OPT.fillTarget],
    ['autofill.onlyOnPasswordPages', 'bool'],
    ['autofill.minIdentityFields', 'number', [1, 20]],
    ['autofill.includeContacts', 'bool'],
    ['autofill.basicAuth', 'bool'],
    ['autofill.inlineMenu', 'bool'],
    ['autofill.passkeys', 'bool'],
    ['autofill.passkeyExclude', 'lines'],
  ]],
  ['autosave', [
    ['autosave.mode', 'select', OPT.saveMode],
    ['autosave.forceDialog', 'bool'],
    ['autosave.excludeUrls', 'lines'],
  ]],
  ['apps', [
    ['apps.linkApps', 'bool'],
    ['apps.ignoredApps', 'lines'],
    ['apps.allowExec', 'bool'],
  ]],
  ['security', [
    ['security.autoLockMinutes', 'select', OPT.autolock],
    ['security.lockOnSessionLock', 'bool'],
    ['security.lockOnScreensaver', 'bool'],
    ['security.lockOnSuspend', 'bool'],
    ['security.lockOnBrowsersClosed', 'bool'],
    ['security.rememberMp', 'bool'],
    ['security.iterations', 'select', OPT.iterations],
    ['security.clipboardClearSecs', 'number', [0, 600]],
  ]],
  ['sync', []],
  ['domains', [['equivDomains', 'groups']]],
  ['hotkeys', [
    ['hotkeys.search', 'text'],
    ['hotkeys.saveApp', 'text'],
    ['hotkeys.lock', 'text'],
  ]],
  ['backup', [
    ['backup.auto', 'bool'],
    ['backup.generations', 'number', [1, 100]],
  ]],
];

let prefs = {};
const inputs = new Map();

const getp = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setp(o, path, v) {
  const ks = path.split('.');
  const last = ks.pop();
  ks.reduce((a, k) => (a[k] = a[k] || {}), o)[last] = v;
}

function buildField([path, type, extra, disabled]) {
  const key = 'Pref_' + path.replace(/\./g, '_');
  const label = t(key);
  let input;
  if (type === 'bool') {
    input = el('input', { type: 'checkbox', checked: !!getp(prefs, path), disabled: !!disabled });
    inputs.set(path, { input, type });
    return el('label', { class: 'check' }, input, el('span', { text: label }));
  }
  if (type === 'select') {
    input = el('select', { disabled: !!disabled });
    for (const [v, k] of extra) input.append(el('option', { value: String(v), text: /^[A-Z]/.test(String(k)) ? t(k) : k }));
    input.value = String(getp(prefs, path));
    inputs.set(path, { input, type, num: typeof extra[0][0] === 'number' });
  } else if (type === 'number') {
    input = el('input', { type: 'number', min: extra[0], max: extra[1], value: getp(prefs, path) });
    inputs.set(path, { input, type });
  } else if (type === 'text') {
    input = el('input', { type: 'text', value: getp(prefs, path) || '', disabled: !!disabled, class: path.startsWith('hotkeys') ? 'hotkey' : '' });
    inputs.set(path, { input, type });
  } else if (type === 'lines') {
    input = el('textarea', { rows: 5, value: (getp(prefs, path) || []).join('\n') });
    inputs.set(path, { input, type });
  } else if (type === 'groups') {
    input = el('textarea', { rows: 8, value: (getp(prefs, path) || []).map((g) => g.join(', ')).join('\n') });
    inputs.set(path, { input, type });
  }
  const hint = t(key + '_Hint');
  return el('label', { class: 'field' }, el('span', { text: label }), input,
    hint !== key + '_Hint' ? el('span', { class: 'sub', text: hint }) : null);
}

function collect() {
  const out = JSON.parse(JSON.stringify(prefs));
  for (const [path, { input, type, num }] of inputs) {
    let v;
    if (type === 'bool') v = input.checked;
    else if (type === 'number') v = Number(input.value);
    else if (type === 'select') v = num ? Number(input.value) : input.value;
    else if (type === 'lines') v = input.value.split('\n').map((s) => s.trim()).filter(Boolean);
    else if (type === 'groups') v = input.value.split('\n').map((l) => l.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)).filter((g) => g.length >= 2);
    else v = input.value.trim();
    setp(out, path, v);
  }
  return out;
}

async function changeMp() {
  await openDialog((f, close) => {
    const old = el('input', { type: 'password', autocomplete: 'off', 'aria-label': t('MP_Old') });
    const n1 = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': t('MP_New') });
    const n2 = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': t('MP_Confirm') });
    const meter = meterEl();
    const bits = el('div', { class: 'sub' });
    attachStrength(n1, meter, bits);
    const err = el('div', { class: 'msg error hidden', role: 'alert' });
    const field = (k, i) => el('label', { class: 'field' }, el('span', { text: t(k) }), i);
    f.append(el('div', { class: 'title', text: t('MP_Change') }), field('MP_Old', old), field('MP_New', n1), meter, bits, field('MP_Confirm', n2), err,
      el('div', { class: 'actions' },
        el('button', { type: 'button', text: t('Common_Cancel'), onclick: () => close(null) }),
        el('button', {
          type: 'submit', class: 'primary', text: t('MP_Change'),
          onclick: async (e) => {
            e.preventDefault();
            err.classList.add('hidden');
            if (!n1.value || n1.value !== n2.value) { err.textContent = t('Setup_MP_Mismatch'); err.classList.remove('hidden'); return; }
            try { await rpc('changeMp', { old: old.value, new: n1.value }); close(true); toast(t('MP_Changed')); }
            catch (er) { err.textContent = er.message; err.classList.remove('hidden'); }
          },
        })));
  });
}

/** 保存先の欄・直近の失敗・以前の保存先に残っているバックアップの表示を更新する。 */
async function refreshBackupDir() {
  const box = $('#bk-dir');
  if (!box) return;
  const st = await rpc('backupStatus');
  box.value = st.dir;
  $('#bk-dir-reset').disabled = st.isDefault;
  const notes = $('#bk-notes');
  notes.replaceChildren();
  if (st.lastError) notes.append(el('div', { class: 'msg error', role: 'alert', text: t('Backup_LastError', st.lastError) }));
  for (const p of st.previous) notes.append(el('div', { class: 'msg warn', text: t('Backup_Previous', p.count, p.dir) }));
}

async function changeBackupDir(dir) {
  try { await rpc('backupSetDir', { dir }); toast(t('Backup_DirChanged')); } catch (e) { showError(e); }
  await refreshBackupDir();
  await refreshBackups();
}

/** 全初期化: すべて消えることを注意し、マスターパスワードを入力させてから実行する。 */
async function factoryReset() {
  const ok = await dialog.confirm(t('Reset_Warn'), { danger: true, title: t('Reset_Title'), okLabel: t('Reset_Next') });
  if (!ok) return;
  // 続けるには、マスターパスワードの入力が必要（誤りなら、何も消さずに入力し直し）
  const pw = await dialog.reauth(t('Reset_Reauth'));
  if (pw === null) return;
  try {
    await rpc('factoryReset', { password: pw });
  } catch (e) { showError(e); }
}

let pickedBackups = []; // 「フォルダを指定して復元」で選んだフォルダのバックアップ（復元の一覧に追加で出す）

async function pickBackupFolder() {
  const d = await pickFolder(t('Backup_RestorePickTitle'));
  if (!d) return;
  try {
    const found = await rpc('listBackupsIn', { dir: d });
    if (!found.length) { await dialog.alert(t('Backup_RestoreNone', d)); return; }
    pickedBackups = found;
    await refreshBackups();
  } catch (e) { showError(e); }
}

async function refreshBackups() {
  const ul = $('#backups');
  if (!ul) return;
  ul.replaceChildren();
  const list = [...(await rpc('listBackups')), ...pickedBackups];
  if (!list.length) ul.append(el('li', { class: 'sub', text: t('Backup_None') }));
  for (const b of list) {
    const locKey = { default: 'Backup_Loc_Default', previous: 'Backup_Loc_Previous', picked: 'Backup_Loc_Picked' }[b.location];
    const where = b.location === 'current' ? '' : `  [${t(locKey)}: ${b.dir}]`;
    ul.append(el('li', null, el('span', { class: 'grow mono', text: `${b.name}  (${Math.ceil(b.size / 1024)} KB)${where}` }),
      el('button', {
        type: 'button', text: t('Backup_Restore'),
        onclick: async () => {
          const ok = await dialog.confirm(t('Backup_RestoreConfirm', b.name), { danger: true, okLabel: t('Backup_Restore') });
          if (!ok) return;
          try { await rpc('restoreBackup', { path: b.path }); toast(t('Backup_Restored')); } catch (e) { showError(e); }
        },
      })));
  }
}

(async () => {
  await initI18n();
  await LockGuard.init(() => location.reload());
  prefs = await rpc('getPrefs');
  const tabs = $('#tabs'), panes = $('#panes');
  function select(id) {
    $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === id)));
    $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.id === id));
  }
  TABS.forEach(([id, fields], i) => {
    const tab = el('button', { role: 'tab', 'aria-selected': i === 0 ? 'true' : 'false', text: t('Pref_Tab_' + id), onclick: () => select(id) });
    tab.dataset.id = id;
    tabs.append(tab);
    const pane = el('section', { class: 'pane' + (i === 0 ? ' active' : ''), role: 'tabpanel' });
    pane.dataset.id = id;
    if (id === 'sync') buildSyncPane(pane);
    if (id === 'general') pane.append(el('div', { class: 'row' }, el('button', { type: 'button', id: 'upd-check', text: t('Upd_Check'), onclick: checkUpdates }), el('span', { id: 'upd-msg', class: 'sub' })));
    fields.forEach((f) => pane.append(buildField(f)));
    if (id === 'security') {
      pane.append(el('div', { class: 'sub', text: t('Pref_Reauth_Note') }));
      pane.append(el('div', { class: 'row' }, el('button', { type: 'button', text: t('MP_Change'), onclick: changeMp })));
      buildHelloPane(pane);
    }
    if (id === 'backup') {
      // 保存先フォルダ（変更は専用のコマンドで確認してから反映される。「保存」ボタンの対象ではない）
      pane.append(el('div', { class: 'col' },
        el('span', { class: 'sub', text: t('Backup_Dir') }),
        el('div', { class: 'row' },
          el('input', { type: 'text', id: 'bk-dir', class: 'grow mono', readonly: 'readonly', 'aria-label': t('Backup_Dir') }),
          el('button', {
            type: 'button', id: 'bk-dir-change', text: t('Backup_DirChange'),
            onclick: async () => { const d = await pickFolder(t('Backup_DirPick')); if (d) await changeBackupDir(d); },
          }),
          el('button', { type: 'button', id: 'bk-dir-reset', text: t('Backup_DirReset'), onclick: () => changeBackupDir('') })),
        el('div', { id: 'bk-notes', class: 'col' })));
      pane.append(el('div', { class: 'row' },
        el('button', {
          type: 'button', text: t('Backup_Now'),
          onclick: async () => {
            try { const r = await rpc('backupNow'); toast(t('Backup_Done', r.path)); refreshBackups(); } catch (e) { showError(e); }
          },
        }),
        el('button', { type: 'button', id: 'factory-reset', class: 'danger', text: t('Reset_Button'), onclick: factoryReset }),
        el('button', { type: 'button', id: 'bk-restore-folder', text: t('Backup_RestoreFromFolder'), onclick: pickBackupFolder }),
        el('button', {
          type: 'button', text: t('Backup_Check'),
          onclick: async () => {
            try { const r = await rpc('checkIntegrity'); await dialog.alert(r.corrupt.length ? t('Backup_CheckBad', r.corrupt.length) : t('Backup_CheckOk')); } catch (e) { showError(e); }
          },
        })));
      pane.append(el('h2', { text: t('Backup_List') }), el('ul', { id: 'backups' }));
    }
    panes.append(pane);
  });
  refreshBackupDir();
  refreshBackups();

  $('#save').addEventListener('click', async () => {
    const next = collect();
    try {
      await rpc('setPrefs', { prefs: next });
      const langChanged = next.general.language !== prefs.general.language;
      prefs = next;
      $('#saved').textContent = t('Pref_Saved') + (langChanged ? ' ' + t('Pref_RestartNote') : '');
    } catch (e) { showError(e); }
  });
})();

// ------------------------------------------------------------------ 同期（§15）

async function buildSyncPane(pane) {
  const status = el('div', { class: 'msg', role: 'status' });
  const url = el('input', { type: 'text', placeholder: 'https://example.com/tkrform/sync.php' });
  const email = el('input', { type: 'text', autocomplete: 'off' });
  const pw = el('input', { type: 'password', autocomplete: 'off' });
  const fields = el('div', { class: 'col' },
    el('label', { class: 'field' }, el('span', { text: t('Sync_Url') }), url),
    el('label', { class: 'field' }, el('span', { text: t('Sync_Email') }), email),
    el('label', { class: 'field' }, el('span', { text: t('Sync_Password') }), pw),
    el('div', { class: 'sub', text: t('Sync_Https_Note') }));
  const run = (fn) => async () => { try { await fn(); } catch (e) { showError(e); } await refresh(); };
  const connect = (mode) => run(async () => {
    await rpc('syncConnect', { mode, url: url.value.trim(), email: email.value.trim(), password: pw.value });
    pw.value = '';
    toast(t('Sync_Connected'));
  });
  const reg = el('button', { type: 'button', text: t('Sync_Register'), onclick: connect('register') });
  const login = el('button', { type: 'button', class: 'primary', text: t('Sync_Login'), onclick: connect('login') });
  const now = el('button', { type: 'button', id: 'sync-now', text: t('Sync_Now'), onclick: run(async () => { const r = await rpc('syncNow'); toast(t('Sync_Report', r.pulled, r.pushed, r.conflictsKept)); }) });
  const off = el('button', { type: 'button', class: 'danger', text: t('Sync_Disconnect'), onclick: run(async () => {
    if (!(await dialog.confirm(t('Sync_DisconnectConfirm'), { danger: true, okLabel: t('Sync_Disconnect') }))) return;
    await rpc('syncDisconnect');
  }) });
  const actions = el('div', { class: 'row' });
  pane.append(status, fields, actions);
  async function refresh() {
    const st = await rpc('syncStatus');
    url.value = url.value || st.serverUrl || '';
    email.value = email.value || st.email || '';
    const on = st.enabled && st.loggedIn;
    status.className = 'msg ' + (st.lastError ? 'warn' : on ? 'ok' : '');
    status.textContent = !on ? t('Sync_Status_Off') : st.lastError ? t('Sync_Status_Error', st.lastError) : st.lastOk ? t('Sync_Status_Ok', fmtDate(st.lastOk)) : t('Sync_Status_On');
    actions.replaceChildren(...(on ? [now, off] : []), ...(on && !st.needsLogin ? [] : [reg, login]));
    fields.classList.toggle('hidden', on && !st.needsLogin);
  }
  await TAURI.event.listen('sync-done', refresh);
  await refresh();
}

// ------------------------------------------------------------------ Windows Hello（§6.3）

async function buildHelloPane(pane) {
  const box = el('div', { class: 'col card' });
  pane.append(box);
  async function refresh() {
    const st = await rpc('helloStatus');
    const msg = el('div', { class: 'sub', text: !st.supported ? t('Hello_Unsupported') : st.enabled ? t('Hello_On') : t('Hello_Off') });
    const btns = el('div', { class: 'row' });
    if (st.registeredButDisabled) {
      // 登録は残っているが無効: 利用者の確認（Windows Hello）を通して、有効に戻せる
      msg.textContent = t('Hello_RegisteredDisabled');
      btns.append(el('button', { type: 'button', id: 'hello-reenable', class: 'primary', text: t('Hello_Reenable'), onclick: async (ev) => {
        ev.target.disabled = true;
        try { await rpc('helloReenable'); prefs = await rpc('getPrefs'); toast(t('Hello_Enabled')); } catch (e) { showError(e); }
        refresh();
      } }));
    }
    if (st.enabled) {
      btns.append(el('button', { type: 'button', class: 'danger', text: t('Hello_Disable'), onclick: async () => {
        if (!(await dialog.confirm(t('Hello_DisableConfirm'), { danger: true, okLabel: t('Hello_Disable') }))) return;
        try { await rpc('helloDisable'); prefs = await rpc('getPrefs'); } catch (e) { showError(e); }
        refresh();
      } }));
    } else if (st.supported) {
      btns.append(el('button', { type: 'button', id: 'hello-enable', text: t('Hello_Enable'), onclick: async (ev) => {
        ev.target.disabled = true;
        try { await rpc('helloEnable'); prefs = await rpc('getPrefs'); toast(t('Hello_Enabled')); } catch (e) { showError(e); }
        refresh();
      } }));
    }
    box.replaceChildren(el('b', { text: t('Hello_Title') }), msg, el('div', { class: 'sub', text: t('Hello_Note') }), btns);
  }
  refresh();
}

async function checkUpdates() {
  const msg = $('#upd-msg');
  msg.textContent = '';
  try {
    const r = await rpc('updateCheck');
    if (!r.available) { msg.textContent = t('Upd_Latest', r.current); return; }
    msg.textContent = t('Upd_Available', r.version);
    if (await dialog.confirm(t('Upd_Confirm', r.version, r.notes || ''), { okLabel: t('Upd_Install') })) await rpc('updateInstall');
  } catch (e) { msg.textContent = e.message; }
}
