'use strict';
// 拡張ページ（ポップアップ・設定・保存ダイアログ・生成パネル・ホーム）の共通処理。

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs) || key;

function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'icon') n.append(icon(v));
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k in n && k !== 'list' && k !== 'form') n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
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

function applyI18n(root) {
  (root || document).querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  (root || document).querySelectorAll('[data-i18n-ph]').forEach((n) => { n.placeholder = t(n.dataset.i18nPh); });
  (root || document).querySelectorAll('[data-i18n-title]').forEach((n) => { n.title = t(n.dataset.i18nTitle); n.setAttribute('aria-label', n.title); });
}

/** bg へ依頼する。失敗は { code, message } を throw。 */
function bg(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (r) => {
        if (chrome.runtime.lastError || !r) return reject({ code: 'NOT_CONNECTED', message: (chrome.runtime.lastError && chrome.runtime.lastError.message) || t('Ext_NotConnected') });
        if (r.ok) resolve(r.data); else reject(r.error);
      });
    } catch (e) { reject({ code: 'GONE', message: String(e) }); }
  });
}

const rpc = (cmd, args) => bg({ t: 'rpc', cmd, args: args || {} });

/** 検索結果を、すべて読み足して返す（1 回の応答は 500 件ずつ。保管庫の件数に上限をつけない）。 */
async function searchAll(q, types) {
  const out = [];
  const seen = new Set();
  const PAGE = 500;
  for (;;) {
    const part = await rpc('search', { q, types, limit: PAGE, offset: out.length });
    const fresh = part.filter((r) => !seen.has(r.id));
    fresh.forEach((r) => seen.add(r.id));
    out.push(...fresh);
    if (part.length < PAGE || !fresh.length) return out; // 新しいものが来なければ終わる（古いアプリが offset を無視しても、止まる）
  }
}

function errText(e) {
  if (e && e.code === 'NOT_CONNECTED') return t('Ext_NotConnected');
  return (e && e.message) || t('Ext_Err_Generic');
}

function meterEl() { return el('div', { class: 'meter' }, el('i')); }

/** パスワード生成 UI。onUse を渡すと「使う」ボタンを出す。 */
function mountGenerator(host, onUse, onClose, compact) {
  let opts = { mode: 'random', length: 16, upper: true, lower: true, digits: true, symbols: true, symbolChars: '!@#$%^&*', requireEach: true, words: 4, separator: '-', capitalize: true, addNumber: true };
  const KEY = 'tkrform.ext.gen';
  chrome.storage.local.get(KEY).then((s) => { if (s[KEY]) { opts = { ...opts, ...s[KEY] }; sync(); gen(); } }).catch(() => {});
  const out = el('input', { type: 'text', readOnly: true, class: 'mono', 'aria-label': t('PassGen_Output') });
  const meter = meterEl();
  const bits = el('div', { class: 'sub' });
  const len = el('input', { type: 'number', min: 4, max: 128, style: 'width:72px' });
  const phrase = el('input', { type: 'checkbox' });
  // 使う記号（サイトによっては使えない記号があるため、自分で指定できる）
  const symChars = el('input', { type: 'text', class: 'mono', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('PassGen_SymbolChars') });
  const chk = (k, label) => { const c = el('input', { type: 'checkbox' }); c.dataset.k = k; return el('label', { class: 'check' }, c, el('span', { text: t(label) })); };
  const boxes = [chk('upper', 'PassGen_Upper'), chk('lower', 'PassGen_Lower'), chk('digits', 'PassGen_Digits'), chk('symbols', 'PassGen_Symbols')];
  let current = '';
  function sync() {
    len.value = opts.length; phrase.checked = opts.mode === 'passphrase';
    boxes.forEach((b) => { const c = b.querySelector('input'); c.checked = !!opts[c.dataset.k]; c.disabled = opts.mode === 'passphrase'; });
    len.disabled = opts.mode === 'passphrase';
    if (document.activeElement !== symChars) symChars.value = opts.symbolChars;
    symChars.disabled = opts.mode === 'passphrase' || !opts.symbols;
  }
  async function gen() {
    opts.length = Math.max(4, Math.min(128, Number(len.value) || 16));
    opts.mode = phrase.checked ? 'passphrase' : 'random';
    boxes.forEach((b) => { const c = b.querySelector('input'); opts[c.dataset.k] = c.checked; });
    opts.symbolChars = symChars.value;
    chrome.storage.local.set({ [KEY]: opts }).catch(() => {});
    sync();
    try {
      const g = await bg({ t: 'generate', options: opts });
      current = g.password; out.value = g.password;
      meter.className = 'meter ' + (g.class === 'weak' ? '' : g.class);
      meter.firstElementChild.style.width = Math.min(100, (g.bits / 128) * 100) + '%';
      bits.textContent = t('Strength_Bits', Math.round(g.bits));
    } catch (e) { out.value = ''; bits.textContent = errText(e); }
  }
  [len, phrase, symChars, ...boxes.map((b) => b.querySelector('input'))].forEach((i) => i.addEventListener('input', gen));
  const copy = el('button', { type: 'button', text: t('PassGen_Copy'), onclick: async () => {
    if (!current) return;
    try { await rpc('copyText', { text: current }); bits.textContent = t('Common_Copied', ''); } catch (e) { bits.textContent = errText(e); }
  } });
  const settings = [
    el('div', { class: 'row' }, el('label', { class: 'field' }, el('span', { text: t('PassGen_Length') }), len), el('label', { class: 'check', style: 'margin-top:14px' }, phrase, el('span', { text: t('PassGen_Mode_Passphrase') }))),
    el('div', { class: 'row', style: 'flex-wrap:wrap' }, ...boxes),
    el('label', { class: 'field' }, el('span', { text: t('PassGen_SymbolChars') }), symChars)];
  if (compact) {
    // ページ上のパネル用の小さい表示: パスワード・強度・ボタンだけ。設定は「詳細設定」で開く（既定は閉じる）
    meter.style.height = '4px';
    const details = el('div', { class: 'col hidden', id: 'gen-details' }, ...settings);
    const more = el('button', { type: 'button', class: 'flat', id: 'gen-more', 'aria-expanded': 'false', 'aria-controls': 'gen-details', style: 'padding:0 4px;font-size:12px', text: t('PassGen_Details'), onclick: () => {
      const open = details.classList.contains('hidden');
      details.classList.toggle('hidden', !open);
      more.setAttribute('aria-expanded', String(open));
      more.textContent = t(open ? 'PassGen_DetailsClose' : 'PassGen_Details');
    } });
    const acts = el('div', { class: 'row' });
    if (onUse) acts.append(el('button', { type: 'button', class: 'primary', id: 'gen-use', text: t('Common_Use'), onclick: () => current && onUse(current) }));
    acts.append(copy, el('button', { type: 'button', id: 'gen-regen', text: '\u21bb ' + t('PassGen_Generate'), onclick: gen }));
    bits.style.margin = '0';
    host.append(out, meter, acts, el('div', { class: 'row', style: 'justify-content:space-between' }, more, bits), details);
    sync(); gen();
    return;
  }
  const actions = el('div', { class: 'row' }, el('button', { type: 'button', class: 'primary', text: t('PassGen_Generate'), onclick: gen }), copy);
  if (onUse) actions.append(el('button', { type: 'button', text: t('Common_Use'), onclick: () => current && onUse(current) }));
  if (onClose) actions.append(el('button', { type: 'button', class: 'flat', text: t('Common_Close'), onclick: onClose }));
  host.append(out, meter, bits, ...settings, actions);
  sync(); gen();
}
