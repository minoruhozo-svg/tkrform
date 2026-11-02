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
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k in n && k !== 'list' && k !== 'form') n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

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
