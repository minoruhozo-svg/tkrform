// パスキー（WebAuthn）の拡張側の窓口。isolated world のコンテンツスクリプト。
//  - inject.js（MAIN world）と、毎回乱数のチャネル名（token）を使ったイベントでやり取りする。
//  - 選択のダイアログをページ上に出す。
//  - 実際の鍵の操作は、bg.js 経由でアプリ（Native Messaging）に任せる。origin は bg.js が送信元フレームの URL から決める。
(() => {
  'use strict';
  const T = (key, ...subs) => chrome.i18n.getMessage(key, subs) || key;
  const win = window;

  // 対象は、トップフレームと、トップと同一オリジンの iframe だけ（それ以外は inject.js が元の API に渡す）
  function sameOriginChain() {
    try {
      let w = win;
      while (w !== w.parent) {
        w = w.parent;
        if (w.location.origin !== win.location.origin) return false; // 別オリジンへのアクセスは例外
      }
      return true;
    } catch (_) { return false; }
  }
  if (!/^https?:$/.test(location.protocol) || !sameOriginChain()) return;

  const rnd = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); };
  const token = rnd(16);
  const J = JSON;
  const CE = CustomEvent;

  const bg = (m) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(m, (r) => {
        if (chrome.runtime.lastError || !r) resolve({ ok: false, error: { code: 'NOT_CONNECTED', message: (chrome.runtime.lastError && chrome.runtime.lastError.message) || '' } });
        else resolve(r);
      });
    } catch (e) { resolve({ ok: false, error: { code: 'NOT_CONNECTED', message: String(e) } }); }
  });

  const reply = (id, body) => win.dispatchEvent(new CE('tkpk-r-' + token, { detail: J.stringify({ id, ...body }) }));
  const err = (name, message) => ({ error: { name, message } });

  const active = new Map(); // id -> 中断用の関数

  win.addEventListener('tkpk-q-' + token, (ev) => {
    let m; try { m = J.parse(ev.detail); } catch (_) { return; }
    if (!m || typeof m.id !== 'string') return;
    if (m.op === 'abort') { const f = active.get(m.id); if (f) f(); return; }
    if (m.op === 'create') run(m.id, () => onCreate(m.id, m.data));
    else if (m.op === 'get') run(m.id, () => onGet(m.id, m.data));
    else if (m.op === 'avail') run(m.id, async () => ((await available()) ? { yes: true } : { yes: false }));
  }, true);
  // ハンドシェイク（inject.js は document_start で先に待ち受けている）
  win.dispatchEvent(new CE('tkpk-hs', { detail: J.stringify({ token }) }));

  async function run(id, fn) {
    try { reply(id, await fn()); } catch (e) { reply(id, err('NotAllowedError', String((e && e.message) || e))); } finally { active.delete(id); }
  }

  const FALLBACK = { fallback: true };

  async function available() {
    const r = await bg({ t: 'passkeyAvail' });
    return r.ok && r.data && r.data.enabled ? r.data : null;
  }

  async function onCreate(id, d) {
    const av = await available();
    if (!av) return FALLBACK;
    if (d.attachment === 'cross-platform') return FALLBACK; // セキュリティキーを求められたときは tkrform では扱わない
    if (d.algs.length && !d.algs.includes(-7)) return FALLBACK; // ES256 以外は未対応
    const rpId = d.rpId || location.hostname;
    // rpId がこのページのドメインと合わないときは、ブラウザ標準の API に渡して SecurityError にさせる
    if (rpId !== location.hostname && !location.hostname.endsWith('.' + rpId)) return FALLBACK;
    const out = await dialog(id, {
      kind: 'create',
      title: T('Pk_Create_Title'),
      lead: T('Pk_Create_Lead', rpId),
      who: d.userDisplayName && d.userDisplayName !== d.userName ? `${d.userDisplayName} (${d.userName})` : d.userName,
      primary: T('Pk_Save'),
      run: async (password) => {
        const r = await bg({ t: 'passkeyCreate', args: { rpId, rpName: d.rpName, userId: d.userId, userName: d.userName, userDisplayName: d.userDisplayName, challenge: d.challenge, algs: d.algs, exclude: d.exclude, uv: d.uv, password } });
        return r;
      },
    });
    if (out.action === 'other') return FALLBACK;
    if (out.action === 'excluded') return err('InvalidStateError', 'The authenticator was previously registered.');
    if (out.action !== 'done') return err('NotAllowedError', 'The operation either timed out or was not allowed.');
    return out.data;
  }

  async function onGet(id, d) {
    const av = await available();
    if (!av) return FALLBACK;
    const rpId = d.rpId || location.hostname;
    if (rpId !== location.hostname && !location.hostname.endsWith('.' + rpId)) return FALLBACK;
    const l = await bg({ t: 'passkeyList', args: { rpId, allow: d.allow } });
    const list = l.ok && l.data ? l.data.passkeys : [];
    if (!list.length) return FALLBACK;
    if (d.mediation === 'conditional') return onConditional(id, d, rpId, list);
    const out = await dialog(id, {
      kind: 'get',
      title: T('Pk_Get_Title'),
      lead: T('Pk_Get_Lead', rpId),
      choices: list,
      primary: T('Pk_Use'),
      run: async (password, choice) => bg({ t: 'passkeyGet', args: { rpId, itemId: choice.itemId, credentialId: choice.credentialId, challenge: d.challenge, uv: d.uv, password } }),
    });
    if (out.action === 'other') return FALLBACK;
    if (out.action !== 'done') return err('NotAllowedError', 'The operation either timed out or was not allowed.');
    return out.data;
  }

  // ---------------------------------------------------------------- 条件付き表示（mediation: "conditional"）
  // すぐには解決しない。autocomplete に "webauthn" を含む入力欄にフォーカスすると、その下にパスキーの候補を「パスキー」の見出しで出す。
  // 選ぶと解決し、AbortSignal で中断されたら（inject.js からの abort）候補を片付けて終わる。
  // tkrform に一致するパスキーがあるときだけ、ここで扱う（なければ元の API の条件付き表示にそのまま任せる）。

  const WEBAUTHN_INPUT = 'input[autocomplete~="webauthn"], textarea[autocomplete~="webauthn"]';
  const isWebauthnInput = (e) => !!(e && e.matches && e.matches(WEBAUTHN_INPUT));
  const UV_CODES = ['NEEDS_PASSWORD', 'UV_FAILED', 'BAD_PASSWORD'];

  function onConditional(id, d, rpId, list) {
    return new Promise((resolve) => {
      const host = document.createElement('div');
      host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; display: none;';
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        .m { box-sizing: border-box; min-width: 240px; max-width: 420px; background: #fff; color: #1f2933; border: 1px solid #d8dee4; border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.25); font: 13px/1.5 "Segoe UI","Yu Gothic UI","Meiryo UI",sans-serif; overflow: hidden; }
        @media (prefers-color-scheme: dark) { .m { background: #1c2128; color: #e8edf2; border-color: #38424d; } .it:hover, .it.on { background: #26303b !important; } .s { color: #a3afbb !important; } }
        h2 { margin: 0; padding: 4px 10px; font-size: 11px; color: #5b6773; background: rgba(0,0,0,.04); }
        .it { display: block; width: 100%; text-align: left; border: 0; background: transparent; color: inherit; font: inherit; padding: 6px 10px; cursor: pointer; }
        .it:hover, .it.on { background: #eaf1f8; }
        .n { font-weight: 600; } .s { font-size: 12px; color: #5b6773; }
        .e { padding: 4px 10px; font-size: 12px; color: #c4413a; }`;
      const box = document.createElement('div');
      box.className = 'm';
      box.setAttribute('role', 'listbox');
      const h = document.createElement('h2');
      h.textContent = T('Pk_Cond_Heading');
      const errBox = document.createElement('div');
      errBox.className = 'e';
      errBox.style.display = 'none';
      box.append(h);
      let cur = 0;
      let anchor = null;
      let done = false;
      const items = list.map((c) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'it'; b.setAttribute('role', 'option');
        const n = document.createElement('div');
        n.className = 'n';
        n.textContent = c.userDisplayName && c.userDisplayName !== c.userName ? `${c.userDisplayName} (${c.userName})` : c.userName || c.itemName;
        const sub = document.createElement('div');
        sub.className = 's';
        sub.textContent = c.itemName;
        b.append(n, sub);
        b.addEventListener('mousedown', (e) => e.preventDefault()); // 入力欄のフォーカスを失わせない
        b.addEventListener('click', () => choose(c));
        box.append(b);
        return b;
      });
      box.append(errBox);
      root.append(style, box);

      const mark = () => items.forEach((b, i) => b.classList.toggle('on', i === cur));
      const place = () => {
        if (!anchor || !anchor.isConnected) { host.style.display = 'none'; return; }
        const r = anchor.getBoundingClientRect();
        host.style.display = 'block';
        host.style.left = Math.max(0, r.left) + 'px';
        host.style.top = (r.bottom + 2) + 'px';
        box.style.width = Math.max(240, r.width) + 'px';
      };
      const show = (el) => { anchor = el; cur = 0; mark(); (document.documentElement || document.body).append(host); place(); };
      const hide = () => { anchor = null; host.style.display = 'none'; };

      const onFocus = (e) => { if (isWebauthnInput(e.target)) show(e.target); };
      const onBlur = (e) => {
        if (isWebauthnInput(e.target)) setTimeout(() => { if (!isWebauthnInput(document.activeElement)) hide(); }, 150);
      };
      const onKey = (e) => {
        if (!anchor || done) return;
        if (e.key === 'ArrowDown') { cur = (cur + 1) % items.length; mark(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { cur = (cur - 1 + items.length) % items.length; mark(); e.preventDefault(); }
        else if (e.key === 'Enter' && anchor.value === '') { e.preventDefault(); choose(list[cur]); }
        else if (e.key === 'Escape') hide();
      };
      const reposition = () => place();
      const handlers = [[document, 'focusin', onFocus, true], [document, 'focusout', onBlur, true], [document, 'keydown', onKey, true], [window, 'resize', reposition, false], [window, 'scroll', reposition, true]];
      for (const [t, type, fn, cap] of handlers) t.addEventListener(type, fn, cap);

      const finish = (body) => {
        if (done) return;
        done = true;
        for (const [t, type, fn, cap] of handlers) t.removeEventListener(type, fn, cap);
        host.remove();
        active.delete(id);
        resolve(body);
      };
      active.set(id, () => finish(err('NotAllowedError', 'The operation was aborted.')));

      async function choose(c) {
        if (done) return;
        errBox.style.display = 'none';
        const r = await bg({ t: 'passkeyGet', args: { rpId, itemId: c.itemId, credentialId: c.credentialId, challenge: d.challenge, uv: d.uv } });
        if (r.ok) { finish(r.data); return; }
        if (r.error && UV_CODES.includes(r.error.code)) {
          // マスターパスワードでの確認が要る: モーダルで続ける（候補はこの 1 件）
          hide();
          const out = await dialog(id + ':uv', {
            kind: 'get', title: T('Pk_Get_Title'), lead: T('Pk_Get_Lead', rpId), choices: [c], primary: T('Pk_Use'),
            run: (password, choice) => bg({ t: 'passkeyGet', args: { rpId, itemId: choice.itemId, credentialId: choice.credentialId, challenge: d.challenge, uv: d.uv, password } }),
          });
          if (out.action === 'done') { finish(out.data); return; }
          if (isWebauthnInput(document.activeElement)) show(document.activeElement);
          return;
        }
        errBox.textContent = (r.error && r.error.message) || T('Pk_Error');
        errBox.style.display = 'block';
        place();
      }

      // 開いた時点で、すでにフォーカスがあれば出す
      if (isWebauthnInput(document.activeElement)) show(document.activeElement);
    });
  }

  // ---------------------------------------------------------------- ダイアログ（Shadow DOM）

  const CSS = `
    :host { all: initial; }
    .wrap { position: fixed; inset: 0; z-index: 2147483647; background: rgba(20, 24, 29, .45); display: flex; align-items: center; justify-content: center; font: 14px/1.5 "Segoe UI", "Yu Gothic UI", "Meiryo UI", sans-serif; }
    .box { width: min(420px, calc(100vw - 32px)); background: #fff; color: #1f2933; border: 1px solid #d8dee4; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,.3); padding: 18px 20px; }
    @media (prefers-color-scheme: dark) { .box { background: #1c2128; color: #e8edf2; border-color: #38424d; } .sub { color: #a3afbb !important; } input[type=password] { background: #14181d; color: #e8edf2; border-color: #38424d; } .row:hover { background: #26303b !important; } button { background: #1c2128; color: #e8edf2; border-color: #38424d; } }
    h1 { font-size: 16px; margin: 0 0 6px; display: flex; align-items: center; gap: 8px; }
    h1 .logo { width: 18px; height: 18px; border-radius: 4px; background: #2b8de0; display: inline-block; }
    .sub { color: #5b6773; margin: 0 0 10px; word-break: break-all; }
    .who { font-weight: 600; margin: 0 0 10px; word-break: break-all; }
    .list { max-height: 220px; overflow: auto; margin: 0 0 10px; border: 1px solid #d8dee4; border-radius: 6px; }
    .row { display: flex; gap: 8px; align-items: center; padding: 7px 10px; cursor: pointer; }
    .row:hover { background: #eaf1f8; }
    .row input { margin: 0; }
    .row .n { font-weight: 600; } .row .s { font-size: 12px; color: #5b6773; }
    .msg { margin: 8px 0; padding: 6px 8px; border-radius: 6px; background: #fdeceb; color: #c4413a; font-size: 13px; }
    .info { margin: 8px 0; padding: 6px 8px; border-radius: 6px; background: #e6f2fc; color: #1a6fb8; font-size: 13px; }
    .hidden { display: none !important; }
    label.pw { display: block; margin: 8px 0; font-size: 13px; }
    input[type=password] { display: block; width: 100%; margin-top: 4px; padding: 5px 8px; border: 1px solid #d8dee4; border-radius: 6px; font: inherit; }
    .btns { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; margin-top: 12px; }
    button { font: inherit; padding: 5px 14px; border: 1px solid #d8dee4; border-radius: 6px; background: #fff; color: #1f2933; cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }
    button.primary { background: #2b8de0; border-color: #2b8de0; color: #fff; }
  `;

  /**
   * 選択のダイアログを出す。`run(password, choice)` はアプリへの要求（{ok, data|error}）。
   * 戻り値の action: done（data あり）| other（ほかの方法を使う）| cancel | excluded
   */
  function dialog(id, o) {
    return new Promise((resolve) => {
      const host = document.createElement('div');
      host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
      const root = host.attachShadow({ mode: 'closed' });
      const el = (tag, props = {}, ...kids) => {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
        for (const c of kids) if (c) e.append(c);
        return e;
      };
      let chosen = o.choices ? o.choices[0] : null;
      const msg = el('div', { class: 'msg hidden', role: 'alert' });
      const info = el('div', { class: 'info hidden' });
      const pw = el('input', { type: 'password', autocomplete: 'off' });
      const pwBox = el('label', { class: 'pw hidden' }, document.createTextNode(T('Pk_Password_Label')), pw);
      const btnPrimary = el('button', { class: 'primary', type: 'button', text: o.primary });
      const btnOther = el('button', { type: 'button', text: T('Pk_Other') });
      const btnCancel = el('button', { type: 'button', text: T('Pk_Cancel') });

      const finish = (r) => { document.removeEventListener('keydown', onKey, true); host.remove(); active.delete(id); resolve(r); };
      active.set(id, () => finish({ action: 'cancel' }));

      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish({ action: 'cancel' }); }
        else if (e.key === 'Enter' && root.activeElement === pw) { e.preventDefault(); e.stopPropagation(); go(); }
      };
      document.addEventListener('keydown', onKey, true);

      let busy = false;
      async function go() {
        if (busy) return;
        busy = true;
        msg.classList.add('hidden');
        info.textContent = T('Pk_Verifying'); info.classList.remove('hidden');
        [btnPrimary, btnOther, btnCancel].forEach((b) => { b.disabled = true; });
        const r = await o.run(pwBox.classList.contains('hidden') ? undefined : pw.value, chosen);
        busy = false;
        [btnPrimary, btnOther, btnCancel].forEach((b) => { b.disabled = false; });
        info.classList.add('hidden');
        if (r.ok) { finish({ action: 'done', data: r.data }); return; }
        const c = r.error && r.error.code;
        if (c === 'PK_EXCLUDED') { finish({ action: 'excluded' }); return; }
        if (c === 'NEEDS_PASSWORD' || c === 'UV_FAILED' || c === 'BAD_PASSWORD') {
          pwBox.classList.remove('hidden');
          pw.value = '';
          msg.textContent = c === 'UV_FAILED' ? T('Pk_Uv_Failed') : c === 'BAD_PASSWORD' ? T('Pk_Password_Bad') : T('Pk_Password_Needed');
          msg.classList.remove('hidden');
          pw.focus();
          return;
        }
        if (c === 'LOCKED') { msg.textContent = T('Pk_Locked'); }
        else msg.textContent = (r.error && r.error.message) || T('Pk_Error');
        msg.classList.remove('hidden');
      }

      btnPrimary.addEventListener('click', go);
      btnOther.addEventListener('click', () => finish({ action: 'other' }));
      btnCancel.addEventListener('click', () => finish({ action: 'cancel' }));

      const list = o.choices ? el('div', { class: 'list', role: 'radiogroup' }) : null;
      if (list) {
        o.choices.forEach((c, i) => {
          const r = el('input', { type: 'radio', name: 'pk' });
          if (i === 0) r.checked = true;
          r.addEventListener('change', () => { chosen = c; });
          const name = c.userDisplayName && c.userDisplayName !== c.userName ? `${c.userDisplayName} (${c.userName})` : c.userName;
          const row = el('label', { class: 'row' }, r, el('span', {}, el('div', { class: 'n', text: name || c.itemName }), el('div', { class: 's', text: c.itemName })));
          list.append(row);
        });
      }
      const box = el('div', { class: 'box', role: 'dialog', 'aria-modal': 'true' },
        el('h1', {}, el('span', { class: 'logo' }), document.createTextNode(o.title)),
        el('p', { class: 'sub', text: o.lead }),
        o.who ? el('p', { class: 'who', text: o.who }) : null,
        list, msg, info, pwBox,
        el('div', { class: 'btns' }, btnOther, btnCancel, btnPrimary));
      root.append(el('style', { text: CSS }), el('div', { class: 'wrap' }, box));
      (document.documentElement || document.body).append(host);
      btnPrimary.focus();
    });
  }
})();
