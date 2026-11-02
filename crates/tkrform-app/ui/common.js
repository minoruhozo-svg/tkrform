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
