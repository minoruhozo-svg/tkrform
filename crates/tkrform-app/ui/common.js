'use strict';
// tkrform 画面の共通処理: Tauri 呼び出し、文言、ダイアログ、トースト、ロック画面。

const TAURI = window.__TAURI__;

function normalizeErr(e) {
  if (e && typeof e === 'object' && e.code) return e;
  return { code: 'INTERNAL', message: typeof e === 'string' ? e : (e && e.message) || String(e) };
}

async function rpc(cmd, args) {
  try {
    return await TAURI.core.invoke('rpc', { cmd, args: args || {} });
  } catch (e) {
    throw normalizeErr(e);
  }
}

async function invoke(name, args) {
  try {
    return await TAURI.core.invoke(name, args || {});
  } catch (e) {
    throw normalizeErr(e);
  }
}

// ------------------------------------------------------------------ 文言

let LOC = {};

function t(key, ...args) {
  let s = LOC[key];
  if (s === undefined) s = key;
  args.forEach((a, i) => { s = s.split('%' + (i + 1)).join(String(a)); });
  return s;
}

function applyI18n(root) {
  root = root || document;
  root.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach((n) => { n.placeholder = t(n.dataset.i18nPh); });
  root.querySelectorAll('[data-i18n-title]').forEach((n) => { n.title = t(n.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-aria]').forEach((n) => { n.setAttribute('aria-label', t(n.dataset.i18nAria)); });
}

async function initI18n() {
  try {
    LOC = JSON.parse(await TAURI.core.invoke('get_locale', { lang: null }));
  } catch (_) {
    LOC = {};
  }
  document.documentElement.lang = LOC['Lang_Code'] || 'ja';
  applyI18n();
}

// ------------------------------------------------------------------ DOM

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'icon') n.append(icon(v));
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k in n && k !== 'list' && k !== 'form') n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

// ---- UI の部品: 線のアイコンと、項目の頭文字（アバター）。
// アプリ（ui/common.js）と拡張（ext.js）で、この区間は同じ内容にする（tools/check-uikit.mjs が一致を検査する）。
const ICON_PATHS = {
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  gen: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01" stroke-width="2.6"/>',
  set: '<path d="M4 7h9M19 7h1M4 17h3M13 17h7"/><circle cx="16" cy="7" r="2.5"/><circle cx="10" cy="17" r="2.5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
  open: '<path d="M14 5h5v5M19 5l-8 8M11 7H6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-5"/>',
  star: '<path d="M12 4l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.5-.8z"/>',
  folder: '<path d="M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  more: '<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="2.8"/>',
  edit: '<path d="M4 20h4l10-10-4-4L4 16zM13 7l4 4"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  fill: '<path d="M4 12h11M11 8l4 4-4 4M20 5v14"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-5 8-5s6.5 1 8 5"/>',
  note: '<path d="M6 4h9l4 4v12H6zM14 4v5h5M9 13h7M9 16.5h5"/>',
  save: '<path d="M12 4v10M8 10l4 4 4-4M5 19h14"/>',
  all: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  down: '<path d="M7 10l5 5 5-5"/>',
  right: '<path d="M10 7l5 5-5 5"/>',
  up: '<path d="M7 14l5-5 5 5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  undo: '<path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
};

/** 線のアイコン（1 種類の太さ）。色は文字色（currentColor）。 */
function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ic ic-' + name);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICON_PATHS[name] || '';
  return s;
}

/** 項目名から決まる色の番号（1〜6）。同じ名前なら、どの画面でも同じ色。 */
function avatarColor(name) {
  let n = 0;
  for (const c of String(name || '').trim().toLowerCase()) n = (n * 31 + c.codePointAt(0)) >>> 0;
  return (n % 6) + 1;
}

/** 項目の頭文字の四角（アバター）。ログインなどは名前の先頭の 1 文字、プロフィール・連絡先・メモは線のアイコン、フォルダは線のフォルダ。 */
function avatar(name, type, size) {
  const kind = { 5: 'user', 6: 'user', 7: 'note', 8: 'folder' }[type];
  const n = document.createElement('span');
  n.className = 'av c' + avatarColor(name) + (size ? ' ' + size : '') + (kind ? ' ic-av' : '');
  if (kind) n.append(icon(kind));
  else n.textContent = ([...String(name || '').trim()][0] || '?').toUpperCase();
  return n;
}
// ---- UI の部品ここまで

/** data-icon を持つ要素に、線のアイコンを入れる（HTML に直接書くボタン用）。 */
function applyIcons(root) {
  (root || document).querySelectorAll('[data-icon]').forEach((n) => { n.replaceChildren(icon(n.dataset.icon)); });
}
document.addEventListener('DOMContentLoaded', () => applyIcons());

// ------------------------------------------------------------------ 左端の切り替え（保管庫・安全性・生成・設定・ロック）

/** 大きな画面（エディタ・セキュリティセンター・設定）の左端に、切り替えのバーを出す。押すと、同じウィンドウの中で画面が替わる。
 *  編集中の変更があるときは、画面ごとに `window.beforeLeave`（捨ててよいかを確かめる関数）で止められる。 */
function mountRail(active) {
  const go = (page) => async () => {
    if (window.beforeLeave && !(await window.beforeLeave())) return;
    location.href = page;
  };
  const item = (id, ico, key, run) => el('button', { type: 'button', class: 'railbtn flat' + (id === active ? ' on' : ''), id: 'rail-' + id, 'aria-current': id === active ? 'page' : null, onclick: run },
    icon(ico), el('span', { text: t(key) }));
  const rail = el('nav', { id: 'rail', 'aria-label': t('Rail_Label') },
    el('div', { class: 'raillogo', 'aria-hidden': 'true' }, icon('key')),
    item('vault', 'all', 'Rail_Vault', go('editor.html')),
    item('security', 'shield', 'Rail_Security', go('security.html')),
    item('gen', 'gen', 'Rail_Generator', () => rpc('openWindow', { name: 'passgen' }).catch(showError)),
    el('span', { class: 'railsp' }),
    item('settings', 'set', 'Rail_Settings', go('settings.html')),
    item('lock', 'lock', 'Rail_Lock', () => rpc('lock').catch(showError)));
  document.body.prepend(rail);
  document.body.classList.add('has-rail');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ------------------------------------------------------------------ ダイアログ（<dialog>）

function openDialog(build, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const dlg = el('dialog', { class: 'tk' + (opts.wide ? ' wide' : ''), 'aria-label': opts.title || '' });
    const form = el('form', { method: 'dialog' });
    dlg.append(form);
    let result = null;
    const close = (v) => { result = v; dlg.close(); };
    build(form, close);
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.addEventListener('cancel', () => { result = null; });
    document.body.append(dlg);
    dlg.showModal();
    const first = opts.focus ? $(opts.focus, dlg) : $('input,textarea,select', dlg);
    if (first) first.focus(); else { const b = $('button.primary', dlg) || $('button', dlg); if (b) b.focus(); }
  });
}

const dialog = {
  alert(message, title) {
    return openDialog((f, close) => {
      f.append(el('div', { class: 'title', text: title || t('Common_Notice') }), el('div', { class: 'body', text: message }),
        el('div', { class: 'actions' }, el('button', { type: 'button', class: 'primary', text: t('Common_OK'), onclick: () => close(true) })));
    });
  },
  // 破壊的な操作では danger を付け、既定のフォーカスは「キャンセル」側に置く
  confirm(message, opts) {
    opts = opts || {};
    return openDialog((f, close) => {
      const ok = el('button', { type: 'button', class: opts.danger ? 'danger' : 'primary', text: opts.okLabel || t('Common_OK'), onclick: () => close(true) });
      const cancel = el('button', { type: 'button', id: 'dlg-cancel', text: t('Common_Cancel'), onclick: () => close(false) });
      f.append(el('div', { class: 'title', text: opts.title || t('Common_Confirm') }), el('div', { class: 'body', text: message }),
        el('div', { class: 'actions' }, cancel, ok));
    }, { focus: opts.danger ? '#dlg-cancel' : 'button.primary' }).then((v) => v === true);
  },
  prompt(label, value, opts) {
    opts = opts || {};
    return openDialog((f, close) => {
      const input = el('input', { type: opts.password ? 'password' : 'text', value: value || '', 'aria-label': label });
      f.append(el('div', { class: 'title', text: opts.title || label }), opts.title ? el('div', { text: label }) : null, input,
        el('div', { class: 'actions' },
          el('button', { type: 'button', text: t('Common_Cancel'), onclick: () => close(null) }),
          el('button', { type: 'submit', class: 'primary', text: t('Common_OK'), onclick: (e) => { e.preventDefault(); close(input.value); } })));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); close(input.value); } });
    });
  },
  // マスターパスワードの再入力（エクスポート・印刷の前）
  async reauth(message) {
    for (;;) {
      const pw = await dialog.prompt(message || t('Reauth_Message'), '', { password: true, title: t('Reauth_Title') });
      if (pw === null) return null;
      try {
        const r = await rpc('verifyMp', { password: pw });
        if (r.ok) return pw;
        await dialog.alert(t('Err_BadPassword'));
      } catch (e) {
        await dialog.alert(e.message);
      }
    }
  },
};

function toast(message, kind) {
  let box = $('#toasts');
  if (!box) { box = el('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const n = el('div', { class: 'toast' + (kind === 'error' ? ' error' : ''), text: message });
  box.append(n);
  setTimeout(() => n.remove(), kind === 'error' ? 6000 : 3000);
}

function showError(e) {
  const err = normalizeErr(e);
  toast(err.message, 'error');
}

// ------------------------------------------------------------------ クリップボード

async function copySecret(text, label) {
  try {
    await invoke('copy_secret', { text, secret: true });
    toast(t('Common_Copied', label || ''));
  } catch (e) { showError(e); }
}

async function copyPlain(text) {
  try {
    await invoke('copy_secret', { text, secret: false });
    toast(t('Common_Copied', ''));
  } catch (e) { showError(e); }
}

// ------------------------------------------------------------------ 強度メーター

function attachStrength(input, meter, label) {
  let seq = 0;
  const update = async () => {
    const my = ++seq;
    const v = input.value;
    if (!v) { meter.className = 'meter'; meter.firstElementChild.style.width = '0'; if (label) label.textContent = ''; return; }
    const r = await rpc('strength', { password: v });
    if (my !== seq) return;
    meter.className = 'meter ' + (r.class === 'weak' ? '' : r.class);
    meter.firstElementChild.style.width = Math.min(100, (r.bits / 128) * 100) + '%';
    if (label) label.textContent = t('Strength_Bits', Math.round(r.bits));
  };
  input.addEventListener('input', update);
  return update;
}

function meterEl() { return el('div', { class: 'meter', role: 'img' }, el('i')); }

// ------------------------------------------------------------------ ロック画面のオーバーレイ

const LockGuard = {
  overlay: null,
  async init(onUnlocked) {
    const st = await rpc('status');
    this.hint = st.hint || '';
    this.hello = !!st.hello;
    if (st.locked) this.show(onUnlocked);
    await TAURI.event.listen('vault-state', (ev) => {
      if (ev.payload.locked) this.show(onUnlocked);
      else { this.hide(); if (onUnlocked) onUnlocked(); }
    });
    return !st.locked;
  },
  show(onUnlocked) {
    if (this.overlay) return;
    const input = el('input', { type: 'password', id: 'lg-pw', autocomplete: 'off', 'aria-label': t('Login_Password') });
    const err = el('div', { class: 'msg error hidden', role: 'alert' });
    const hint = el('div', { class: 'sub' });
    const btn = el('button', { class: 'primary', type: 'submit', text: t('Login_Button') });
    const submit = async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        await rpc('unlock', { password: input.value });
        input.value = '';
      } catch (er) {
        err.textContent = er.message; err.classList.remove('hidden');
        if (this.hint) { hint.textContent = t('Login_HintLabel', this.hint); }
        input.select();
      }
      btn.disabled = false;
    };
    this.overlay = el('div', { id: 'lock-overlay' },
      el('form', { class: 'card', onsubmit: submit },
        el('div', { class: 'brand', text: t('App_Name') }),
        el('div', { class: 'sub', text: t('Lock_Message') }),
        input, err, hint,
        el('div', { class: 'row' }, this.hello ? el('button', { type: 'button', text: t('Hello_Unlock'), onclick: async (e) => {
          e.target.disabled = true;
          try { await rpc('helloUnlock'); } catch (er) { err.textContent = er.message; err.classList.remove('hidden'); }
          e.target.disabled = false;
        } }) : null, el('div', { class: 'grow' }), btn)));
    document.body.append(this.overlay);
    input.focus();
  },
  hide() {
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
  },
};

// ------------------------------------------------------------------ ファイル選択

async function pickOpen(title, name, exts) { return invoke('pick_open', { title, name, exts }); }
async function pickFolder(title) { return invoke('pick_folder', { title }); }
async function pickSave(title, fileName, name, exts) { return invoke('pick_save', { title, fileName, name, exts }); }

document.addEventListener('contextmenu', (e) => {
  // 入力欄以外では WebView 既定のメニューを出さない
  if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault();
});
