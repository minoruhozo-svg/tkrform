// tkrform content script（全フレーム）。フォームの検出、記入、送信の検知（自動保存）、インラインメニュー（Shadow DOM）。
// MV3 のコンテンツスクリプトは ES Module にできないため、IIFE 1 ファイルにまとめている。
(() => {
  'use strict';
  if (window.__tkrformContent) return;
  window.__tkrformContent = true;

  const T = (key, ...subs) => chrome.i18n.getMessage(key, subs) || key;
  const IS_TOP = window.top === window;
  const EXT_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');

  // ---------------------------------------------------------------- bg との通信

  let dead = false;
  function send(m) {
    return new Promise((resolve) => {
      if (dead) return resolve({ ok: false, error: { code: 'GONE', message: '' } });
      try {
        chrome.runtime.sendMessage(m, (r) => {
          if (chrome.runtime.lastError || !r) return resolve({ ok: false, error: { code: 'NOT_CONNECTED', message: (chrome.runtime.lastError && chrome.runtime.lastError.message) || '' } });
          resolve(r);
        });
      } catch (_) {
        dead = true; // 拡張が再読み込みされた
        resolve({ ok: false, error: { code: 'GONE', message: '' } });
      }
    });
  }

  const S = { connected: false, locked: true, prefs: null, at: 0, matches: null, matchAt: 0 };

  let stateInflight = null;
  // 同時に呼ばれても問い合わせは 1 回にまとめ、未接続の結果はキャッシュしない
  function refreshState(force) {
    if (!force && S.connected && Date.now() - S.at < 3000) return Promise.resolve(S);
    if (stateInflight) return stateInflight;
    stateInflight = (async () => {
      let r = await send({ t: 'state' });
      // サービスワーカーの起動直後や再接続中は失敗・未接続で返ることがある。少し待って再確認する
      for (let i = 0; i < 3 && (!r.ok || !r.data.connected); i++) {
        await new Promise((res) => setTimeout(res, 600));
        r = await send({ t: 'state' });
      }
      S.at = Date.now();
      if (r.ok) {
        S.connected = r.data.connected; S.locked = r.data.locked; S.hello = !!r.data.helloAvailable;
        if (r.data.prefs) S.prefs = r.data.prefs;
        if (S.locked) S.matches = null;
      } else { S.connected = false; }
      return S;
    })().finally(() => { stateInflight = null; });
    return stateInflight;
  }

  async function getMatches(force) {
    if (!force && S.matches && Date.now() - S.matchAt < 5000) return S.matches;
    const r = await send({ t: 'match' });
    S.matches = r.ok ? r.data : null;
    S.matchAt = Date.now();
    return S.matches;
  }

  const prefs = () => S.prefs || { autofill: { mode: 'suggest', target: 'both', onlyOnPasswordPages: true, minIdentityFields: 3, inlineMenu: true }, autosave: { mode: 'suggest', forceDialog: true, excludeUrls: [] } };

  // ---------------------------------------------------------------- DOM ユーティリティ

  function isVisible(e) {
    if (!e || !e.isConnected) return false;
    const r = e.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    const s = getComputedStyle(e);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity) > 0.05;
  }

  function nativeSet(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value); // React などが値の変更を検知できるよう、ネイティブの setter を使う
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
  }

  const txtOf = (e) => [e.name, e.id, e.placeholder, e.getAttribute('aria-label'), e.getAttribute('autocomplete'), labelText(e)].filter(Boolean).join(' ');

  function labelText(e) {
    try {
      if (e.labels && e.labels.length) return Array.from(e.labels).map((l) => l.textContent).join(' ').trim().slice(0, 80);
      const lb = e.getAttribute('aria-labelledby');
      if (lb) { const n = document.getElementById(lb); if (n) return n.textContent.trim().slice(0, 80); }
    } catch (_) { /* 無視 */ }
    return '';
  }

  const TEXT_TYPES = new Set(['text', 'email', 'tel', 'search', 'url', 'number', '']);
  const USER_RE = /user|login|e-?mail|account|acct|member|uid|identifier|ユーザ|ログイン|メール|アカウント|会員|ID/i;
  // ユーザー ID の候補にする入力欄の種類（select・radio・checkbox・number・search などは候補にしない）
  const USER_TYPES = new Set(['text', 'email', 'tel', '']);
  const NOT_USER_RE = /search|検索|zip|postal|郵便|phone|電話|domain|ドメイン|tld|suffix|captcha|otp|token/i;

  function usable(i) { return !i.disabled && !i.readOnly && isVisible(i); }

  // ---------------------------------------------------------------- フォームの検出（§8.3）

  /** { container, form, user, pws:[...], otp } の配列を返す */
  function scanForms() {
    const out = [];
    const pwAll = Array.from(document.querySelectorAll('input[type=password]')).filter(usable);
    const seen = new Set();
    for (const pw of pwAll) {
      const container = containerOf(pw);
      if (seen.has(container)) continue;
      seen.add(container);
      const pws = pwAll.filter((p) => container.contains(p));
      out.push({ container, form: pw.form || container.closest('form'), user: findUser(container, pws[0]), pws, otp: null });
    }
    // ユーザー ID だけのページ（多段ログインの 1 ページ目）
    if (!out.length) {
      const cand = Array.from(document.querySelectorAll('input')).filter((i) => TEXT_TYPES.has((i.type || '').toLowerCase()) && usable(i))
        .filter((i) => /username|email/.test(i.autocomplete || '') || i.type === 'email' || (USER_RE.test(txtOf(i)) && !/search|検索|query|zip|postal/i.test(txtOf(i))));
      if (cand.length === 1 || (cand.length > 1 && cand[0].form && cand.every((c) => c.form === cand[0].form))) {
        out.push({ container: cand[0].form || cand[0].parentElement, form: cand[0].form, user: cand[0], pws: [], otp: null });
      }
    }
    return out;
  }

  function containerOf(pw) {
    if (pw.form) return pw.form;
    let n = pw.parentElement;
    for (let depth = 0; n && n !== document.body && depth < 6; depth++, n = n.parentElement) {
      const inputs = n.querySelectorAll('input:not([type=hidden])');
      if (inputs.length >= 2) return n;
    }
    return pw.parentElement || document.body;
  }

  function findUser(container, firstPw) {
    const inputs = Array.from(container.querySelectorAll('input')).filter((i) => USER_TYPES.has((i.type || '').toLowerCase()) && usable(i));
    const before = firstPw ? inputs.filter((i) => i.compareDocumentPosition(firstPw) & Node.DOCUMENT_POSITION_FOLLOWING) : inputs;
    // autocomplete=username → 名前（name / id）の手がかり → それ以外はパスワード欄に最も近い（直前の）テキスト欄
    const scored = (before.length ? before : inputs).map((i) => {
      let s = 0;
      if (/username|email/.test(i.autocomplete || '')) s += 5;
      if (i.type === 'email') s += 3;
      if (USER_RE.test([i.name, i.id].filter(Boolean).join(' '))) s += 3;
      else if (USER_RE.test(txtOf(i))) s += 2;
      if (NOT_USER_RE.test(txtOf(i))) s -= 4;
      return [i, s];
    });
    if (!scored.length) return null;
    const best = scored.reduce((a, b) => (b[1] > a[1] || (b[1] === a[1] && before.length) ? b : a));
    return best[0];
  }

  const OTP_RE = /one-time-code|otp|2fa|totp|mfa|verification|auth.?code|security.?code|認証コード|確認コード|ワンタイム/i;
  function findOtpFields() {
    return Array.from(document.querySelectorAll('input')).filter((i) => TEXT_TYPES.has((i.type || '').toLowerCase()) || i.type === 'password')
      .filter((i) => usable(i) && (i.autocomplete === 'one-time-code' || (OTP_RE.test(txtOf(i)) && (i.maxLength === -1 || i.maxLength <= 8) && !/zip|postal|card|cc-/i.test(txtOf(i)))));
  }

  // ---------------------------------------------------------------- 記入

  function setFieldValue(el, f) {
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      if (el.type === 'radio') {
        const group = Array.from(document.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`));
        const target = group.find((r) => r.value === f.value) || (f.value === 'on' ? el : null);
        if (target && !target.checked) target.click();
        return;
      }
      const want = ['on', 'true', '1', 'yes'].includes(String(f.value).toLowerCase());
      if (el.checked !== want) el.click();
      return;
    }
    if (el instanceof HTMLSelectElement) {
      const opt = Array.from(el.options).find((o) => o.value === f.value) || Array.from(el.options).find((o) => o.text.trim() === f.value);
      if (opt) { el.value = opt.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      return;
    }
    nativeSet(el, f.value);
  }

  function findFieldEl(f, form, used) {
    const scope = form.container || document;
    const q = (sel, root) => { try { return root.querySelector(sel); } catch (_) { return null; } };
    let el = null;
    if (f.id) el = q('#' + CSS.escape(f.id), scope) || document.getElementById(f.id);
    if (!el && f.name) el = q(`[name="${CSS.escape(f.name)}"]`, scope);
    if (!el || used.has(el)) {
      el = null;
      if (f.role === 'user') el = form.user;
      else if (f.role === 'password') el = form.pws[0];
      else if (f.role === 'newPassword') el = form.pws[1] || form.pws[0];
      else if (f.role === 'otp') el = form.otp || findOtpFields()[0];
    }
    return el && !used.has(el) ? el : null;
  }

  /** 保存されたフィールドを記入する。見えない欄には書かない（隠しフィールドへの流出を防ぐ）。 */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 見えるようになるのを、少し待つ（ラジオの選択で、別の欄の表示が切り替わるサイト向け）。見えなければ、書かない。 */
  async function waitUsable(f, form, used, relaxed) {
    for (let i = 0; i < 8; i++) {
      const el = findFieldEl(f, form, used);
      if (el && (relaxed || usable(el))) return el; // チェックボックス・ラジオは、見た目を変えた部品のことがあるので、見えるかは問わない
      await sleep(100);
    }
    return null;
  }

  /** 保存されたフィールドを、保存した順（画面の順）にすべて記入する。見えない欄には書かない（隠しフィールドへの流出を防ぐ）。 */
  async function fillFields(form, fields) {
    const used = new Set();
    let n = 0;
    for (const f of fields) {
      const selectLike = f.kind === 'checkbox' || f.kind === 'radio' || f.kind === 'select';
      if (!selectLike && f.value === '') continue;
      const el = await waitUsable(f, form, used, f.kind === 'checkbox' || f.kind === 'radio');
      if (!el) continue;
      setFieldValue(el, f);
      used.add(el);
      n++;
      // 選択で別の欄が現れたり消えたりするので、少し待ってから次を入れる
      if (selectLike) await sleep(200);
    }
    return n;
  }

  let lastSubmitAt = 0;
  let fillBusy = false;

  function doSubmit(form) {
    // 同じページで短時間に 2 回送信しない（記入の指示が重なっても、送信は 1 回だけ）
    if (Date.now() - lastSubmitAt < 8000) return;
    lastSubmitAt = Date.now();
    // 利用者が手でログインボタンを押すのと同じ経路（本物のクリック）で送信する。requestSubmit() は、ボタンの click ハンドラを通らず、
    // サイトの scripts が「クリックでも submit でも」送るつくりのとき、二重に送ったり、手順が違ったりすることがある。
    // 入力イベントをサイトが処理する時間も取る（記入の直後に送らない）。
    setTimeout(() => {
      try {
        const scope = form.form || (form.pws[0] && form.pws[0].form) || form.container || document;
        const sel = 'button[type=submit], input[type=submit], input[type=image], button:not([type]), [role=button], a[role=button]';
        const cands = Array.from(scope.querySelectorAll(sel)).filter((b) => isVisible(b) && !b.disabled);
        const label = (b) => [b.textContent, b.value, b.getAttribute('aria-label'), b.getAttribute('alt'), b.title].filter(Boolean).join(' ');
        const loginBtn = cands.find((b) => /ログイン|ログオン|login|log in|sign in|signin/i.test(label(b))) || cands.find((b) => b.matches('button[type=submit], input[type=submit]')) || cands[0];
        if (loginBtn) {
          for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) loginBtn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
          loginBtn.click();
          return;
        }
        const f = form.form || (form.pws[0] && form.pws[0].form);
        if (f && typeof f.requestSubmit === 'function') { f.requestSubmit(); return; }
        const target = form.pws[0] || form.user;
        if (target) target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      } catch (_) { /* 無視 */ }
    }, 200);
  }

  function pickForm() {
    const forms = scanForms();
    if (!forms.length) return null;
    const ae = document.activeElement;
    return forms.find((f) => f.user === ae || f.pws.includes(ae) || (f.container && ae && f.container.contains(ae))) || forms[0];
  }

  async function fillLogin(id, opts = {}) {
    // 記入の最中に、別の経路（自動記入・インラインメニュー・保留中の記入）からの指示が重なっても、二重に記入しない
    if (fillBusy) return { filled: false, reason: 'busy' };
    fillBusy = true;
    try { return await fillLoginInner(id, opts); } finally { fillBusy = false; }
  }

  async function fillLoginInner(id, opts = {}) {
    const form = pickForm();
    if (!form) return { filled: false, reason: 'noform' };
    const r = await send({ t: 'fill', id });
    if (!r.ok) {
      if (!opts.silent && r.error.code !== 'GONE') toast(r.error.code === 'URL_MISMATCH' ? T('Ext_Err_Mismatch') : r.error.message || T('Ext_Err_Generic'));
      return { filled: false, error: r.error };
    }
    const d = r.data;
    form.otp = findOtpFields()[0] || null;
    const n = await fillFields(form, d.fields);
    const submit = opts.submit === null || opts.submit === undefined ? d.submit : opts.submit;
    // 送信するかどうかの判断（ページの DevTools のコンソールで確認できる。パスワードなどは出さない）
    console.debug('[tkrform] 記入 → 送信=' + !!submit + '（指示=' + String(opts.submit) + ' / 項目の設定=' + String(d.submit) + '）');
    if (n > 0 && d.hint) toast(d.hint); // ログイン時に表示するヒント
    if (n > 0 && submit) doSubmit(form);
    return { filled: n > 0, hint: d.hint };
  }

  async function fillTotp(id, target) {
    const r = await send({ t: 'totp', id });
    if (!r.ok) { toast(r.error.message || T('Ext_Err_Generic')); return; }
    const el = target || findOtpFields()[0];
    if (el) nativeSet(el, r.data.code);
  }

  // ---------------------------------------------------------------- プロフィールの記入

  const R = (s) => new RegExp(s, 'i');
  const IDENT_RULES = [
    ['CardNumber', ['cc-number'], R('card.?(num|no)|cc.?num|カード番号')],
    ['CardHolderName', ['cc-name'], R('card.?holder|cc.?name|名義')],
    ['CardValidationCode', ['cc-csc'], R('cvv|cvc|csc|security.?code|セキュリティコード')],
    ['CardExpiresMonth', ['cc-exp-month'], R('exp.*month|有効期限.*月')],
    ['CardExpiresYear', ['cc-exp-year'], R('exp.*year|有効期限.*年')],
    ['CardExpires', ['cc-exp'], R('^(cc-?)?exp(iry|iration)?(date)?$|有効期限')],
    ['CardType', ['cc-type'], R('card.?type|カード種')],
    ['LastNameKana', [], R('(last|family|sei).*(kana|furigana|yomi)|(kana|furigana).*(last|sei)|姓.*(カナ|フリガナ|ふりがな|読み)|セイ|^せい$')],
    ['FirstNameKana', [], R('(first|given|mei).*(kana|furigana|yomi)|(kana|furigana).*(first|mei)|名.*(カナ|フリガナ|ふりがな|読み)|メイ|^めい$')],
    ['LastName', ['family-name'], R('last.?name|family.?name|surname|lname|姓|(^|[^a-z])sei($|[^a-z])')],
    ['FirstName', ['given-name'], R('first.?name|given.?name|forename|fname|(^|[^a-z])mei($|[^a-z])|^名$|名前（名）|名（')],
    ['MiddleName', ['additional-name'], R('middle.?name|ミドル')],
    ['FullName', ['name'], R('full.?name|your.?name|氏名|お名前|^name$')],
    ['Email', ['email'], R('e-?mail|メール')],
    ['Phone', ['tel', 'tel-national'], R('phone|tel|電話|携帯|fax(?!.*no)')],
    ['ZipOrPostCode', ['postal-code'], R('zip|postal|post.?code|郵便|〒')],
    ['StateOrProvince', ['address-level1'], R('prefecture|state|province|都道府県')],
    ['City', ['address-level2'], R('city|town|市区町村|市町村|市区')],
    ['AddressLine2', ['address-line2'], R('address.?(2|two)|addr2|building|apartment|マンション|ビル|建物')],
    ['AddressLine1', ['address-line1', 'street-address'], R('address.?(1|one)?$|addr1?|street|番地|住所')],
    ['Company', ['organization'], R('company|organi[sz]ation|会社|法人|勤務先')],
    ['Position', ['organization-title'], R('job.?title|position|役職')],
    ['Department', [], R('department|部署')],
    ['BirthYear', ['bday-year'], R('birth.*year|year.*birth|生年|誕生.*年')],
    ['BirthMonth', ['bday-month'], R('birth.*month|month.*birth|誕生.*月')],
    ['BirthDay', ['bday-day'], R('birth.*day|day.*birth|誕生.*日')],
    ['Sex', ['sex'], R('gender|sex|性別')],
    ['Website', ['url'], R('website|homepage|web.?site')],
  ];

  function classifyField(el) {
    if (el.tagName === 'INPUT' && ['hidden', 'password', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset', 'range', 'color'].includes(el.type)) return null;
    const ac = (el.getAttribute('autocomplete') || '').split(/\s+/).pop();
    const text = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), labelText(el)].filter(Boolean).join(' ');
    for (const [key, acs, re] of IDENT_RULES) {
      if (ac && acs.includes(ac)) return key;
    }
    if (el.type === 'email') return 'Email';
    if (el.type === 'tel') return 'Phone';
    if (!text) return null;
    for (const [key, , re] of IDENT_RULES) if (re.test(text)) return key;
    return null;
  }

  function scanIdentityFields() {
    const map = new Map();
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (!usable(el) && !(el instanceof HTMLSelectElement && isVisible(el))) continue;
      const key = classifyField(el);
      if (key) map.set(el, key);
    }
    return map;
  }

  function fillIdentityFields(values, map) {
    let n = 0;
    const by = {};
    for (const [el, key] of map) (by[key] = by[key] || []).push(el);
    const put = (el, v) => { if (v === undefined || v === '') return false; setFieldValue(el, { value: String(v), kind: el instanceof HTMLSelectElement ? 'select' : 'text' }); n++; return true; };
    const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
    for (const [key, els] of Object.entries(by)) {
      if (key === 'Phone') {
        const v = values.CellPhone || values.HomePhone || values.WorkPhone || '';
        if (els.length >= 3 && /^(\d{2,4})-?(\d{2,4})-?(\d{3,4})$/.test(v)) { const m = v.match(/^(\d{2,4})-?(\d{2,4})-?(\d{3,4})$/); els.slice(0, 3).forEach((e, i) => put(e, m[i + 1])); }
        else els.forEach((e) => put(e, e.maxLength > 0 && e.maxLength <= 11 ? digits(v) : v));
      } else if (key === 'ZipOrPostCode') {
        const v = values.ZipOrPostCode || '';
        const d = digits(v);
        if (els.length >= 2 && d.length === 7) { put(els[0], d.slice(0, 3)); put(els[1], d.slice(3)); }
        else els.forEach((e) => put(e, e.maxLength > 0 && e.maxLength <= 7 ? d : v));
      } else if (key === 'CardExpires') {
        const mm = String(values.CardExpiresMonth || '').padStart(2, '0'), yy = String(values.CardExpiresYear || '');
        els.forEach((e) => put(e, `${mm}/${yy.length === 4 ? yy.slice(2) : yy}`));
      } else if (key === 'FullName') {
        els.forEach((e) => put(e, values.FullName));
      } else if (key === 'AddressLine1') {
        els.forEach((e) => put(e, values.AddressLine1 || values.StreetName));
      } else if (key === 'Company') {
        els.forEach((e) => put(e, values.Company));
      } else if (key === 'Sex') {
        els.forEach((e) => put(e, values.Sex));
      } else {
        els.forEach((e) => {
          let v = values[key];
          if (e instanceof HTMLSelectElement && /^Birth(Month|Day)$/.test(key) && v) v = String(parseInt(v, 10));
          if (e instanceof HTMLSelectElement && key === 'StateOrProvince' && v) {
            const o = Array.from(e.options).find((op) => op.text.includes(v) || v.includes(op.text.trim()) && op.text.trim());
            if (o) { e.value = o.value; e.dispatchEvent(new Event('change', { bubbles: true })); n++; return; }
          }
          put(e, v);
        });
      }
    }
    return n;
  }

  async function fillIdentity(id, instance, silent) {
    const map = scanIdentityFields();
    const r = await send({ t: 'identity', id, instance });
    if (!r.ok) { if (!silent) toast(r.error.message || T('Ext_Err_Generic')); return 0; }
    const n = fillIdentityFields(r.data.fields, map);
    for (const c of r.data.custom || []) {
      try {
        const re = new RegExp(c.match, 'i');
        for (const el of document.querySelectorAll('input, textarea')) if (usable(el) && re.test(el.name + ' ' + el.id) && !el.value) { nativeSet(el, c.value); }
      } catch (_) { /* 不正な正規表現は無視 */ }
    }
    if (!n && !silent) toast(T('Ext_Err_NoIdentityFields'));
    return n;
  }

  // ---------------------------------------------------------------- Shadow DOM のホストとトースト

  function makeHost() {
    const host = document.createElement('div');
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0;';
    (document.documentElement || document).appendChild(host);
    return { host, root: host.attachShadow({ mode: 'closed' }) };
  }

  let toastHost = null;
  function toast(text) {
    if (!IS_TOP && window.innerWidth < 200) return;
    if (!toastHost) {
      toastHost = makeHost();
      const st = document.createElement('style');
      st.textContent = '.t{position:fixed;right:16px;bottom:16px;max-width:320px;background:#1f2933;color:#fff;font:13px/1.5 "Segoe UI","Yu Gothic UI",sans-serif;padding:9px 14px;border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.3)}';
      toastHost.root.append(st);
    }
    const n = document.createElement('div');
    n.className = 't';
    n.textContent = text;
    toastHost.root.append(n);
    setTimeout(() => n.remove(), 3500);
  }

  // ---------------------------------------------------------------- インラインメニュー（§8.3）

  const BAR_H = 30;
  // 見出しの帯（ドラッグで動かす）と × ボタンの見た目。インラインメニューと生成パネルで共通
  const BAR_CSS = `
    .bar { flex: none; height: ${BAR_H}px; display: flex; align-items: center; justify-content: space-between; padding: 0 4px 0 12px; background: #eaf1f8; color: #1f2933; border-bottom: 1px solid #d8dee4; cursor: move; user-select: none; touch-action: none; font-weight: 600; font-size: 13px; }
    .x { width: 24px; height: 22px; padding: 0; border: none; border-radius: 4px; background: transparent; color: inherit; font: 16px/1 sans-serif; cursor: pointer; }
    .x:hover, .x:focus-visible { background: #d8e6f3; }
    @media (prefers-color-scheme: dark) { .bar { background: #26303b; color: #e8edf2; border-color: #38424d; } .x:hover, .x:focus-visible { background: #38424d; } }
  `;

  /** 見出しの帯。タイトルと × ボタン（Tab で届く）を持つ。 */
  function makeBar(titleText, onClose) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const title = document.createElement('span');
    title.textContent = titleText;
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'x'; x.textContent = '\u00d7';
    x.setAttribute('aria-label', T('Common_Close'));
    x.addEventListener('pointerdown', (e) => e.stopPropagation());
    x.addEventListener('mousedown', (e) => e.preventDefault()); // 入力欄のフォーカスを奪わない
    x.addEventListener('click', (e) => { if (e.isTrusted) onClose(); });
    x.addEventListener('pointerup', (e) => { if (e.isTrusted && e.button === 0) onClose(); }); // click が届かない環境の保険（閉じる処理は何度呼んでも同じ）
    // キーボード（Enter / Space）でも、確実に閉じる
    x.addEventListener('keydown', (e) => { if (e.isTrusted && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); onClose(); } });
    bar.append(title, x);
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    return bar;
  }

  /** 帯をつかんで panel を動かす（画面の外へは出さない）。動かし始めたら onMove() を呼ぶ。 */
  function attachDrag(bar, panel, onMove) {
    let drag = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      onMove();
      const r = panel.getBoundingClientRect();
      panel.style.left = Math.max(0, Math.min(e.clientX - drag.dx, window.innerWidth - r.width)) + 'px';
      panel.style.top = Math.max(0, Math.min(e.clientY - drag.dy, window.innerHeight - r.height)) + 'px';
    });
    const end = (e) => { drag = null; try { bar.releasePointerCapture(e.pointerId); } catch (_) { /* 無視 */ } };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }

  const MENU_CSS = `
    :host { all: initial; }
    .ico { position: fixed; width: 20px; height: 20px; padding: 0; border: none; border-radius: 4px; cursor: pointer; background: #2b8de0 url("${chrome.runtime.getURL('icons/icon16.png')}") center/16px no-repeat; box-shadow: 0 0 0 1px rgba(255,255,255,.8); }
    .ico.off { background-color: #80868e; }
    .ico .n { position: absolute; top: -6px; right: -6px; min-width: 12px; height: 12px; border-radius: 6px; background: #e5594f; color: #fff; font: 700 9px/12px sans-serif; text-align: center; }
    .menu { position: fixed; min-width: 240px; max-width: 360px; display: flex; flex-direction: column; overflow: hidden; background: #fff; color: #1f2933; border: 1px solid #d8dee4; border-radius: 8px; box-shadow: 0 8px 28px rgba(20,40,60,.25); font: 13px/1.4 "Segoe UI","Yu Gothic UI","Meiryo UI",sans-serif; }
    .mbody { padding: 4px; overflow: auto; max-height: 320px; }
    ${BAR_CSS}
    .row { display: flex; flex-direction: column; padding: 6px 10px; border-radius: 5px; cursor: pointer; }
    .row:hover, .row:focus { background: #e6f2fc; outline: none; }
    .row b { font-weight: 600; }
    .row small { color: #5b6773; }
    .head { padding: 4px 10px; font-size: 11px; color: #5b6773; }
    .sep { border-top: 1px solid #e3e8ed; margin: 4px 0; }
    .msg { padding: 8px 10px; color: #5b6773; }
    .unlock { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; }
    .unlock input { font: inherit; padding: 5px 8px; border: 1px solid #d8dee4; border-radius: 5px; }
    .unlock button.hello { background: #1fa573; font-weight: 600; padding: 7px; }
    .unlock button { font: inherit; padding: 5px; border: none; border-radius: 5px; background: #2b8de0; color: #fff; cursor: pointer; }
    .err { color: #c4413a; font-size: 12px; }
    @media (prefers-color-scheme: dark) { .menu { background: #1c2128; color: #e8edf2; border-color: #38424d; } .row:hover, .row:focus { background: #26303b; } .row small, .head, .msg { color: #a3afbb; } .sep { border-color: #38424d; } }
  `;

  const inline = { host: null, root: null, ico: null, menu: null, target: null, kind: null, raf: 0, moved: false, dismissed: new WeakSet() };

  function ensureInline() {
    if (inline.host) return;
    const h = makeHost();
    inline.host = h.host; inline.root = h.root;
    const st = document.createElement('style');
    st.textContent = MENU_CSS;
    inline.root.append(st);
    inline.ico = document.createElement('button');
    inline.ico.className = 'ico';
    inline.ico.type = 'button';
    inline.ico.setAttribute('aria-label', 'TKRForm');
    inline.ico.addEventListener('mousedown', (e) => e.preventDefault()); // 入力欄のフォーカスを奪わない
    inline.ico.addEventListener('click', (e) => { if (!e.isTrusted) return; toggleMenu(); });
    inline.root.append(inline.ico);
  }

  function positionInline() {
    if (!inline.target || !inline.ico) return;
    const t = inline.target;
    if (!t.isConnected || !isVisible(t)) { hideInline(); return; }
    const r = t.getBoundingClientRect();
    inline.ico.style.left = Math.max(0, r.right - 24) + 'px';
    inline.ico.style.top = (r.top + (r.height - 20) / 2) + 'px';
    if (inline.menu && !inline.moved) {
      const mr = inline.menu.getBoundingClientRect();
      const mw = mr.width || 260, mh = mr.height || 200, E = 4;
      const vw = window.innerWidth, vh = window.innerHeight;
      const left = Math.max(E, Math.min(r.left, vw - mw - E));
      const spots = [{ x: left, y: r.bottom + E }, { x: left, y: r.top - mh - E }, { x: r.right + E, y: r.top }, { x: r.left - mw - E, y: r.top }];
      const hitsField = (c) => c.x < r.right && r.left < c.x + mw && c.y < r.bottom && r.top < c.y + mh;
      const best = spots.find((c) => c.x >= 0 && c.y >= 0 && c.x + mw <= vw && c.y + mh <= vh && !hitsField(c)) || spots[0];
      inline.menu.style.left = best.x + 'px';
      inline.menu.style.top = best.y + 'px';
    }
    inline.raf = requestAnimationFrame(positionInline);
  }

  function showInline(target, kind) {
    ensureInline();
    inline.target = target; inline.kind = kind;
    inline.ico.style.display = 'block';
    inline.ico.classList.toggle('off', S.locked);
    cancelAnimationFrame(inline.raf);
    positionInline();
  }

  function hideInline() {
    cancelAnimationFrame(inline.raf);
    closeMenu();
    if (inline.ico) inline.ico.style.display = 'none';
    inline.target = null;
  }

  function closeMenu() {
    if (inline.menu) { inline.menu.remove(); inline.menu = null; }
  }

  function toggleMenu() {
    if (inline.menu) { closeMenu(); return; }
    openMenu({ focusMenu: true });
  }

  // focusMenu: true のときだけメニューへフォーカスを移す（アイコンのクリック・↓キー）。
  // 入力欄へのフォーカスで自動的に開いたときは、入力を妨げないよう入力欄にフォーカスを残す。
  async function openMenu({ focusMenu = false } = {}) {
    if (!inline.target) return;
    const target = inline.target, kind = inline.kind;
    closeMenu();
    const outer = document.createElement('div');
    outer.className = 'menu';
    const menu = document.createElement('div');
    menu.className = 'mbody';
    menu.setAttribute('role', 'menu');
    const bar = makeBar('TKRForm', () => {
      // × で閉じた欄では、ページを再読み込みするまで、フォーカスしても自動では開かない（アイコンからは開ける）
      inline.dismissed.add(target);
      closeMenu();
      if (document.activeElement !== target) target.focus({ preventScroll: true });
    });
    attachDrag(bar, outer, () => { inline.moved = true; });
    outer.append(bar, menu);
    inline.root.append(outer);
    inline.menu = outer;
    inline.moved = false; // 開き直しは、自動の位置合わせから始める
    await refreshState(true);
    const row = (title, sub, fn) => {
      const r = document.createElement('div');
      r.className = 'row'; r.tabIndex = 0; r.setAttribute('role', 'menuitem');
      const b = document.createElement('b'); b.textContent = title; r.append(b);
      if (sub) { const s = document.createElement('small'); s.textContent = sub; r.append(s); }
      const act = (e) => { if (!e.isTrusted) return; e.preventDefault(); closeMenu(); fn(); };
      r.addEventListener('click', act);
      r.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') act(e); });
      return r;
    };
    const head = (t) => { const h = document.createElement('div'); h.className = 'head'; h.textContent = t; return h; };
    const msg = (t) => { const m = document.createElement('div'); m.className = 'msg'; m.textContent = t; return m; };
    const sep = () => { const s = document.createElement('div'); s.className = 'sep'; return s; };

    if (!S.connected) { menu.append(msg(T('Ext_NotConnected'))); positionInline(); return; }
    if (S.locked) {
      const box = document.createElement('div');
      box.className = 'unlock';
      const pw = document.createElement('input'); pw.type = 'password'; pw.placeholder = T('Ext_MasterPassword'); pw.setAttribute('aria-label', T('Ext_MasterPassword'));
      const go = document.createElement('button'); go.type = 'button'; go.textContent = T('Ext_Unlock');
      const err = document.createElement('div'); err.className = 'err';
      const doUnlock = async (e) => {
        if (e && !e.isTrusted) return;
        go.disabled = true;
        const r = await send({ t: 'unlock', password: pw.value });
        pw.value = '';
        go.disabled = false;
        if (r.ok) { await refreshState(true); S.matches = null; inline.ico && inline.ico.classList.remove('off'); openMenu({ focusMenu: true }); }
        else err.textContent = r.error.message || T('Ext_Err_Generic');
      };
      go.addEventListener('click', doUnlock);
      pw.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') doUnlock(e); });
      pw.addEventListener('keyup', (e) => e.stopPropagation());
      pw.addEventListener('keypress', (e) => e.stopPropagation());
      if (S.hello) {
        // Windows Hello で解除（アプリが確認ダイアログを出す）。失敗・キャンセルならマスターパスワードの入力を使う
        const hb = document.createElement('button'); hb.type = 'button'; hb.className = 'hello'; hb.textContent = T('Ext_Hello_Unlock');
        hb.addEventListener('click', async (e) => {
          if (!e.isTrusted) return;
          hb.disabled = true; err.textContent = T('Ext_Hello_Waiting');
          const r = await send({ t: 'helloUnlock' });
          hb.disabled = false;
          if (r.ok) { err.textContent = ''; await refreshState(true); S.matches = null; inline.ico && inline.ico.classList.remove('off'); openMenu({ focusMenu: true }); }
          else err.textContent = r.error.message || T('Ext_Err_Generic');
        });
        box.append(hb);
      }
      box.append(pw, go, err);
      menu.append(head(T('Ext_Locked')), box);
      positionInline();
      pw.focus();
      return;
    }

    const m = await getMatches(true);
    if (!inline.menu) return;
    const p = prefs().autofill;
    const isPw = target.type === 'password';
    const showLogins = kind !== 'identity' && p.target !== 'identities';
    const showIdent = (kind === 'identity' || kind === 'login') && p.target !== 'logins';
    let any = false;
    if (kind === 'otp') {
      const withTotp = (m ? m.logins : []).filter((l) => l.hasTotp);
      if (withTotp.length) { menu.append(head(T('Ext_Totp'))); withTotp.forEach((l) => menu.append(row(l.name, l.user, () => fillTotp(l.id, target)))); any = true; }
    }
    if (showLogins && kind !== 'otp' && m && m.logins.length) {
      menu.append(head(T('Ext_Logins')));
      for (const l of m.logins) menu.append(row(l.name, l.user, () => fillLogin(l.id, { submit: false })));
      any = true;
    }
    if (showIdent && m && m.identities.length) {
      const map = scanIdentityFields();
      if (kind === 'identity' || map.size >= (p.minIdentityFields || 3)) {
        if (any) menu.append(sep());
        menu.append(head(T('Ext_Identities')));
        for (const i of m.identities) menu.append(row(i.name, null, () => fillIdentity(i.id)));
        any = true;
      }
    }
    if (!any) menu.append(msg(T('Ext_NoMatches')));
    if (isPw) { menu.append(sep()); menu.append(row(T('Ext_Menu_Generate'), null, () => showGenerator(target))); }
    positionInline();
    if (focusMenu) focusFirstRow();
  }

  function focusFirstRow() {
    const first = inline.menu && inline.menu.querySelector('.row');
    if (first) first.focus({ preventScroll: true });
  }

  // 入力欄にフォーカスしたとき: アイコンを出し、設定が「提案する」ならメニューも開く
  async function onFocusIn(e) {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || !e.isTrusted) return;
    if (inline.host && e.composedPath && e.composedPath().includes(inline.host)) return;
    await refreshState(false);
    if (!S.connected) return;
    const p = prefs().autofill;
    if (p.inlineMenu === false || p.mode === 'off') return;
    let kind = null;
    const forms = scanForms();
    const f = forms.find((x) => x.user === el || x.pws.includes(el));
    if (f) kind = 'login';
    else if (findOtpFields().includes(el)) kind = 'otp';
    else if (!S.locked && p.target !== 'logins' && classifyField(el)) {
      const map = scanIdentityFields();
      if (map.size >= (p.minIdentityFields || 3)) kind = 'identity';
    }
    if (!kind) { if (inline.target && inline.target !== el) hideInline(); return; }
    if (kind === 'login' && p.onlyOnPasswordPages && !forms.some((x) => x.pws.length)) {
      // パスワード欄のないページでは出さない。ただしユーザー ID だけの 1 ページ目は多段ログインとして許す
      if (!forms.some((x) => x.user === el)) return;
    }
    showInline(el, kind);
    if (!S.locked && p.mode === 'suggest' && !inline.dismissed.has(el)) openMenu(); // 「提案する」: フォーカスしたら候補を出す（× で閉じた欄を除く）
  }

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('mousedown', (e) => {
    if (inline.menu && e.composedPath && !e.composedPath().includes(inline.host)) closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && inline.menu) closeMenu();
    // 入力欄で ↓ キー: 開いているメニューへ移る
    else if (e.key === 'ArrowDown' && inline.menu && e.target === inline.target) { e.preventDefault(); focusFirstRow(); }
  }, true);

  // ---------------------------------------------------------------- パスワード生成パネル

  const GEN_W = 340, GEN_BAR = BAR_H, GEN_GAP = 6, GEN_EDGE = 8;
  const GEN_BODY0 = 120; // 小さい表示の中身の高さの初期値（iframe からの通知で正しい値に直る）
  const GEN_CSS = `
    :host { all: initial; }
    .p { position: fixed; width: ${GEN_W}px; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden; background: #fff; color: #1f2933; border: 1px solid #d8dee4; border-radius: 10px; box-shadow: 0 8px 28px rgba(20,40,60,.3); font: 13px/1.4 "Segoe UI","Yu Gothic UI","Meiryo UI",sans-serif; }
    ${BAR_CSS}
    .p .bar { background: #eaf1f8; color: #1f2933; border-color: #d8dee4; }
    .p .x:hover, .p .x:focus-visible { background: #d8e6f3; }
    iframe { flex: 1; min-height: 0; width: 100%; border: 0; background: #fff; color-scheme: normal; }
  `;

  /** 画面内の可視の入力欄（パネルが重ならないようにする相手）。 */
  function genObstacles(form) {
    const scope = (form && (form.container || form.form)) || document;
    return Array.from(scope.querySelectorAll('input, select, textarea'))
      .filter((e) => (e.type || '').toLowerCase() !== 'hidden' && isVisible(e))
      .map((e) => e.getBoundingClientRect());
  }

  const overlapArea = (x, y, w, h, r) => Math.max(0, Math.min(x + w, r.right) - Math.max(x, r.left)) * Math.max(0, Math.min(y + h, r.bottom) - Math.max(y, r.top));

  /** 中身の高さ（iframe からの通知）に合わせて、パネルの高さを決める。画面に収まる範囲に抑え、超えるときは中をスクロールさせる。 */
  function genSize() {
    const g = genFrame;
    if (!g) return;
    g.h = Math.min(GEN_BAR + 2 + g.body, Math.max(GEN_BAR + 60, window.innerHeight - GEN_EDGE * 2));
    g.panel.style.height = g.h + 'px';
    if (g.moved) { // 動かしたあとは位置を変えないが、画面からはみ出さないようにする
      const r = g.panel.getBoundingClientRect();
      g.panel.style.top = Math.max(0, Math.min(r.top, window.innerHeight - g.h)) + 'px';
    }
  }

  /** パネルの位置。まず、対象のフォームのパスワード欄のうち、いちばん下の欄の下（左端は対象の欄にそろえる）。
   *  入力欄に重なる・画面に収まらないときは、順に、入力欄すべての下 → いちばん上の欄の上 → 入力欄すべての上 → 対象の欄の右 → 左を試す。
   *  どれも無理なら、重なりがいちばん少ない位置にする。今入力している欄（フォーカスのある欄）は、重なりを特に避ける。 */
  function genPlace() {
    const g = genFrame;
    if (!g || g.moved) return;
    const target = g.target && g.target.isConnected ? g.target : null;
    const form = (target && scanForms().find((x) => x.pws.includes(target) || x.user === target)) || pickForm();
    const pws = ((form && form.pws) || []).concat(target && !(form && form.pws.includes(target)) ? [target] : []).filter((e) => e.isConnected && isVisible(e));
    if (!pws.length) return; // 欄が見えなくなったときは、今の位置のまま
    const ae = document.activeElement;
    if (ae && ae !== g.host && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName) && ae.isConnected) g.focusEl = ae;
    const focusEl = g.focusEl && g.focusEl.isConnected && isVisible(g.focusEl) ? g.focusEl : target;
    const fr = focusEl ? focusEl.getBoundingClientRect() : null;
    const rects = pws.map((e) => e.getBoundingClientRect());
    const top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom));
    const tr = (target || pws[0]).getBoundingClientRect();
    const W = GEN_W, H = g.h;
    const left = Math.max(GEN_EDGE, Math.min(tr.left, window.innerWidth - W - GEN_EDGE));
    const obstacles = genObstacles(form);
    const allTop = Math.min(top, ...obstacles.map((r) => r.top)), allBottom = Math.max(bottom, ...obstacles.map((r) => r.bottom));
    const maxX = Math.max(GEN_EDGE, window.innerWidth - W - GEN_EDGE), maxY = Math.max(GEN_EDGE, window.innerHeight - H - GEN_EDGE);
    const clamp = (v, hi) => Math.max(GEN_EDGE, Math.min(v, hi));
    const raws = [
      { x: left, y: bottom + GEN_GAP }, { x: left, y: allBottom + GEN_GAP },
      { x: left, y: top - GEN_GAP - H }, { x: left, y: allTop - GEN_GAP - H },
      { x: tr.right + GEN_GAP, y: tr.top }, { x: tr.left - GEN_GAP - W, y: tr.top },
    ];
    const cands = raws.map((c) => ({ c, x: clamp(c.x, maxX), y: clamp(c.y, maxY) }));
    const cost = (c) => obstacles.reduce((n, r) => n + overlapArea(c.x, c.y, W, H, r), 0) + (fr ? 1000 * overlapArea(c.x, c.y, W, H, fr) : 0);
    const fits = (c) => c.x === c.c.x && c.y === c.c.y && cost(c) === 0;
    const best = cands.find(fits) || cands.map((c) => ({ c, k: cost(c) })).sort((u, v) => u.k - v.k)[0].c;
    g.panel.style.left = best.x + 'px';
    g.panel.style.top = best.y + 'px';
  }

  let genFrame = null;
  function showGenerator(target) {
    closeGenerator();
    const h = makeHost();
    const st = document.createElement('style');
    st.textContent = GEN_CSS;
    const panel = document.createElement('div');
    panel.className = 'p';
    const bar = makeBar(T('Ext_Menu_Generate'), closeGenerator);
    const f = document.createElement('iframe');
    f.src = chrome.runtime.getURL('generator.html');
    panel.append(bar, f);
    h.root.append(st, panel);
    const g = { host: h.host, panel, frame: f, target, focusEl: target, moved: false, raf: 0, stop: null, body: GEN_BODY0, h: 0 };
    genFrame = g;
    genSize();
    genPlace();
    // スクロール・ウィンドウの大きさ・ページの変化に追従する（動かしたあとは追従しない）
    const again = () => { if (g.raf) return; g.raf = requestAnimationFrame(() => { g.raf = 0; if (genFrame === g) { genSize(); genPlace(); } }); };
    g.again = again;
    const mo = new MutationObserver(again);
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    const ro = new ResizeObserver(again);
    ro.observe(document.documentElement);
    window.addEventListener('scroll', again, true);
    window.addEventListener('resize', again);
    g.stop = () => { mo.disconnect(); ro.disconnect(); window.removeEventListener('scroll', again, true); window.removeEventListener('resize', again); cancelAnimationFrame(g.raf); };
    // 見出しの帯をつかんで動かす。動かしたら、自動の位置合わせはやめて、その位置に置く
    attachDrag(bar, panel, () => { g.moved = true; });
  }
  function closeGenerator() { if (genFrame) { genFrame.stop && genFrame.stop(); genFrame.host.remove(); genFrame = null; } }

  function useGenerated(pw) {
    const target = genFrame && genFrame.target;
    const form = (target && scanForms().find((x) => x.pws.includes(target) || x.user === target)) || pickForm();
    if (form && form.pws.length) {
      // 新しいパスワードと確認欄の両方に入れる。変更フォームなら現在のパスワード欄は除く
      const list = form.pws.length >= 2 ? form.pws.filter((p, i) => !(form.pws.length >= 3 && i === 0) && p.autocomplete !== 'current-password') : form.pws;
      (list.length ? list : form.pws).forEach((p) => nativeSet(p, pw));
    } else if (target instanceof HTMLInputElement) nativeSet(target, pw);
    closeGenerator();
  }

  // ---------------------------------------------------------------- 保存ダイアログ

  let saveFrame = null;
  function showSave(token) {
    if (!IS_TOP) return;
    closeSave();
    const h = makeHost();
    const f = document.createElement('iframe');
    f.src = chrome.runtime.getURL('save.html?token=' + encodeURIComponent(token));
    f.style.cssText = 'position:fixed;top:12px;right:12px;width:372px;height:330px;border:1px solid #d8dee4;border-radius:10px;box-shadow:0 8px 28px rgba(20,40,60,.3);background:#fff;color-scheme:normal;';
    h.root.append(f);
    saveFrame = { host: h.host, frame: f };
  }
  function closeSave() { if (saveFrame) { saveFrame.host.remove(); saveFrame = null; } }

  window.addEventListener('message', (e) => {
    // 拡張自身の iframe からのメッセージだけを受け付ける（ページのスクリプトは偽装できない）
    if (e.origin !== EXT_ORIGIN || !e.data || typeof e.data !== 'object') return;
    if (genFrame && e.source === genFrame.frame.contentWindow) {
      if (e.data.t === 'use' && typeof e.data.password === 'string') useGenerated(e.data.password);
      if (e.data.t === 'close') closeGenerator();
      if (e.data.t === 'resize' && typeof e.data.height === 'number' && genFrame) { genFrame.body = Math.max(60, Math.min(1200, Math.ceil(e.data.height))); genFrame.again(); }
    }
    if (saveFrame && e.source === saveFrame.frame.contentWindow) {
      if (e.data.t === 'close') closeSave();
      if (e.data.t === 'resize' && typeof e.data.height === 'number') saveFrame.frame.style.height = Math.min(520, Math.max(200, e.data.height)) + 'px';
    }
  });

  // ---------------------------------------------------------------- 送信の検知（自動保存、§8.4）

  let snapshot = null; // 直近にユーザーが入力したフォームの値
  let lastCaptureSig = '';
  let lastCaptureAt = 0;

  function readForm(form) {
    const pws = form.pws.filter((p) => p.value);
    if (!pws.length) return null;
    const all = form.pws;
    let password, kind = 'login';
    const newIdx = all.findIndex((p) => p.autocomplete === 'new-password');
    if (all.length === 1) password = all[0].value;
    else if (newIdx >= 0) {
      password = all[newIdx].value;
      kind = all.some((p) => p.autocomplete === 'current-password') ? 'change' : 'signup';
    } else if (all.length === 2) {
      if (all[0].value === all[1].value) { password = all[0].value; kind = 'signup'; } else { password = all[1].value; kind = 'change'; }
    } else { password = all[1].value || all[0].value; kind = 'change'; }
    if (!password) return null;
    const u = form.user;
    const pwEl = (all.find((p) => p.value === password) || all[0]);
    return {
      url: location.href, user: u ? u.value.trim() : '', password, kind,
      userField: u ? { name: u.name || '', id: u.id || '' } : null,
      pwField: { name: all[0].name || '', id: all[0].id || '' },
      fields: collectFields(form, u, pwEl),
    };
  }

  const SKIP_NAME_RE = /csrf|xsrf|token|nonce|authenticity|captcha|viewstate|_RequestVerification/i;
  const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'file', 'range', 'color']);

  /** 送信されたフォームの、利用者が入力・選択したすべての欄を集める（保存用）。hidden・ボタン・ファイル・値が空の欄、ワンタイムコードの欄、
   *  CSRF トークンのような欄、見えていない欄は除く。ID とパスワード以外のパスワード欄（確認用・旧パスワード）も保存しない。 */
  function collectFields(form, userEl, pwEl) {
    const scope = form.container || document;
    const out = [];
    for (const el of scope.querySelectorAll('input, select, textarea')) {
      if (el.disabled || (!el.name && !el.id)) continue;
      if (SKIP_NAME_RE.test((el.name || '') + ' ' + (el.id || ''))) continue;
      let kind, value;
      if (el instanceof HTMLInputElement) {
        const t = (el.type || 'text').toLowerCase();
        if (SKIP_INPUT_TYPES.has(t)) continue;
        if (t === 'password') {
          if (el !== pwEl) continue;
          kind = 'password'; value = el.value;
        } else if (t === 'checkbox' || t === 'radio') {
          if (!el.checked) continue; // 選ばれているものだけ（ラジオは選択中の 1 つ、チェックボックスはオンのもの）
          kind = t; value = el.value || 'on';
        } else {
          if (!TEXT_TYPES.has(t)) continue;
          if (t === 'search') continue;
          if (el.autocomplete === 'one-time-code' || (OTP_RE.test(txtOf(el)) && (el.maxLength === -1 || el.maxLength <= 8))) continue;
          kind = 'text'; value = el.value;
        }
      } else if (el instanceof HTMLSelectElement) {
        kind = 'select'; value = el.value;
      } else {
        kind = 'textarea'; value = el.value;
      }
      if (value === '' || value === undefined) continue;
      if (kind !== 'checkbox' && kind !== 'radio' && kind !== 'select' && !isVisible(el)) continue; // 見えていない欄は保存しない
      if ((kind === 'select') && !isVisible(el.parentElement || el)) continue;
      out.push({ name: el.name || '', id: el.id || '', kind, value, role: el === userEl ? 'user' : el === pwEl ? 'password' : null });
    }
    return out;
  }

  function formOfTarget(el) {
    const forms = scanForms();
    return forms.find((f) => f.container.contains(el)) || forms.find((f) => f.pws.length) || null;
  }

  function capture(form, forced, deferred) {
    const data = readForm(form);
    if (!data) return;
    const sig = data.url + '|' + data.user + '|' + data.password;
    if (!forced && sig === lastCaptureSig && Date.now() - lastCaptureAt < 3000) return;
    lastCaptureSig = sig; lastCaptureAt = Date.now();
    data.forced = !!forced; data.deferred = !!deferred;
    send({ t: 'captured', data });
    snapshot = null;
  }

  document.addEventListener('input', (e) => {
    if (!e.isTrusted || !(e.target instanceof HTMLInputElement)) return;
    const f = formOfTarget(e.target);
    if (f && f.pws.length) snapshot = { form: f, at: Date.now() };
  }, true);

  document.addEventListener('submit', (e) => {
    if (!e.isTrusted) return;
    const f = scanForms().find((x) => x.form === e.target || (x.container && x.container.contains(e.target)));
    if (f) capture(f, false);
  }, true);

  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const t = e.target;
    const alt = e.altKey && prefs().autosave.forceDialog !== false;
    const isBtn = t instanceof Element && t.closest('button, input[type=submit], input[type=button], [role=button], a');
    if (!alt && !isBtn) return;
    const f = formOfTarget(t);
    if (!f || !f.pws.length) return;
    if (alt) { capture(f, true); return; }
    if (f.container.contains(t)) setTimeout(() => capture(f, false), 0);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
    const f = formOfTarget(e.target);
    if (!f || !f.pws.length) return;
    if (e.shiftKey && prefs().autosave.forceDialog !== false) { capture(f, true); return; }
    capture(f, false);
  }, true);

  // ページを離れる直前の値（遷移後に保存ダイアログを出す）
  window.addEventListener('pagehide', () => {
    if (snapshot && Date.now() - snapshot.at < 60_000 && snapshot.form.pws.some((p) => p.value)) capture(snapshot.form, false, true);
  });

  function onSpaNav() {
    // SPA: ログイン画面が消えていれば、直前の入力を送信されたものとして扱う
    if (snapshot && Date.now() - snapshot.at < 15_000) {
      const gone = snapshot.form.pws.every((p) => !p.isConnected || !isVisible(p));
      if (gone) capture(snapshot.form, false);
    }
  }

  // ---------------------------------------------------------------- bg からの指示

  chrome.runtime.onMessage.addListener((m, _sender, sendResponse) => {
    if (!m || typeof m !== 'object') return false;
    if (m.t === 'showSave') { showSave(m.token); sendResponse({ ok: true }); return false; }
    if (m.t === 'closeSave') { closeSave(); return false; }
    if (m.t === 'toast') { if (IS_TOP) toast(m.text); return false; }
    if (m.t !== 'cmd') return false;
    (async () => {
      switch (m.name) {
        case 'fillById': {
          if (!scanForms().length) return sendResponse({ filled: false });
          const r = await fillLogin(m.id, { submit: m.submit, silent: !!m.pending });
          return sendResponse({ filled: !!r.filled, code: r.error && r.error.code }); // 一致しないページでは URL_MISMATCH（ポップアップが知らせる）
        }
        case 'fillBest': {
          await refreshState(true);
          if (S.locked) { toast(T('Ext_Locked')); return sendResponse({}); }
          const mm = await getMatches(true);
          if (scanForms().length && mm && mm.logins.length) await fillLogin(mm.logins[0].id, { submit: false });
          else if (mm && mm.identities.length && scanIdentityFields().size >= (prefs().autofill.minIdentityFields || 3)) await fillIdentity(mm.identities[0].id);
          else toast(T('Ext_NoMatches'));
          return sendResponse({});
        }
        case 'generate': {
          const ae = document.activeElement;
          const pw = ae instanceof HTMLInputElement && ae.type === 'password' ? ae : (pickForm() || { pws: [] }).pws[0];
          showGenerator(pw || ae);
          return sendResponse({});
        }
        case 'savePage': {
          // パスワードが入力済みのフォームを優先する（フォーカス中のフォーム → ページ内の順）。
          // quiet: ポップアップから全フレームへ順に送るときは、このフレームでトーストを出さない
          const forms = scanForms();
          const f = [pickForm(), ...forms].find((x) => x && readForm(x));
          if (f) { capture(f, true); return sendResponse({ captured: true }); }
          if (!m.quiet) toast(T(forms.length ? 'Ext_Err_FormEmpty' : 'Ext_Err_NoForm'));
          return sendResponse({ captured: false, hasForm: forms.length > 0 });
        }
        case 'fillIdentityById': {
          const n = await fillIdentity(m.id, m.instance, !IS_TOP);
          return sendResponse({ filled: n > 0 });
        }
        case 'spaNav':
          onSpaNav();
          return sendResponse({});
        default:
          return sendResponse({});
      }
    })();
    return true;
  });

  // ---------------------------------------------------------------- 起動時の走査と自動記入

  let scanTimer = null;
  const autoFilled = new WeakSet();

  async function onScan() {
    if (dead) return;
    await refreshState(false);
    if (!S.connected || S.locked) return;
    const p = prefs().autofill;
    if (p.mode !== 'auto' || !IS_TOP) return;
    const forms = scanForms().filter((f) => f.pws.length && !autoFilled.has(f.container));
    if (!forms.length) return;
    const m = await getMatches(false);
    // 「候補が 1 件なら聞かずに記入する」
    if (m && m.logins.length === 1) {
      forms.forEach((f) => autoFilled.add(f.container));
      fillLogin(m.logins[0].id, { submit: false, silent: true });
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(onScan, 300); // debounce 300ms
  }

  function start() {
    scheduleScan();
    new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
    if (IS_TOP) {
      // ページを離れる直前に作った保存待ちがあれば、遷移後のこのページで出す
      send({ t: 'pendingSave' }).then((r) => { if (r.ok && r.data && r.data.token) showSave(r.data.token); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
