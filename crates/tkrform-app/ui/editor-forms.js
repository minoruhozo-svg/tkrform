'use strict';
// エディタの右ペイン: アイテム種別ごとの編集フォーム。`item` を直接書き換え、変更のたびに ctx.changed() を呼ぶ。

const TYPE_LOGIN = 1, TYPE_BOOKMARK = 2, TYPE_APP = 4, TYPE_IDENTITY = 5, TYPE_CONTACT = 6, TYPE_NOTE = 7, TYPE_FOLDER = 8;
const SENSITIVE_KEYS = new Set(['CardNumber', 'CardValidationCode', 'CardPIN', 'BankPIN', 'SocialSecurityNumber', 'DriverLicenseNumber', 'PassportNumber', 'AccountNumber', 'IBAN']);
const IDENTITY_GROUPS_ORDER = ['Person', 'Business', 'Address', 'CreditCard', 'BankAccount', 'Passport', 'Car', 'Custom'];

let totpTimer = null;
const layoutCache = {};
const activeInstance = {};

async function getLayout(country) {
  if (!layoutCache[country]) layoutCache[country] = await rpc('identityLayout', { country });
  return layoutCache[country];
}

function bind(input, item, key, ctx, isCheck) {
  input.addEventListener('input', () => { item[key] = isCheck ? input.checked : input.value; ctx.changed(); });
  return input;
}

function field(labelText, control, hint) {
  return el('label', { class: 'field' }, el('span', { text: labelText }), control, hint ? el('span', { class: 'sub', text: hint }) : null);
}

function folderSelect(item, ctx) {
  const sel = el('select');
  const paths = ['/', ...S.folders.filter((p) => p !== '/')];
  if (!paths.includes(item.folder)) paths.push(item.folder);
  for (const p of paths) sel.append(el('option', { value: p, text: p === '/' ? t('Folder_Root') : p }));
  sel.value = item.folder;
  sel.addEventListener('change', () => { item.folder = sel.value; ctx.changed(); });
  return sel;
}

// パスワード欄用: 表示切替・コピー
function passwordCell(f, ctx) {
  const input = el('input', { type: 'password', value: f.value, autocomplete: 'off', class: 'mono', 'aria-label': t('Field_Password') });
  input.addEventListener('input', () => { f.value = input.value; ctx.changed(); });
  const show = el('button', { type: 'button', class: 'icon', icon: 'eye', title: t('Cmd_Show'), 'aria-label': t('Cmd_Show'),
    onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; } });
  const copy = el('button', { type: 'button', class: 'icon', icon: 'copy', title: t('Cmd_CopyPassword'), 'aria-label': t('Cmd_CopyPassword'), onclick: () => copySecret(input.value) });
  return el('div', { class: 'pwcell' }, input, show, copy);
}

const KINDS = ['text', 'password', 'checkbox', 'radio', 'textarea', 'select'];
const ROLES = [['', 'Role_None'], ['user', 'Role_User'], ['password', 'Role_Password'], ['newPassword', 'Role_NewPassword'], ['otp', 'Role_Otp']];

function fieldsTable(item, ctx) {
  const tbody = el('tbody');
  const render = () => {
    tbody.replaceChildren();
    item.fields.forEach((f, i) => {
      // 名前と ID は幅を狭くしているので、長いときは省略表示になる。全体は、ツールチップとフォーカスで見える
      const name = el('input', { type: 'text', value: f.name || '', title: f.name || '', placeholder: t('Fields_Name'), 'aria-label': t('Fields_Name') });
      name.addEventListener('input', () => { f.name = name.value; name.title = name.value; ctx.changed(); });
      const id = el('input', { type: 'text', value: f.id || '', title: f.id || '', placeholder: t('Fields_Id'), 'aria-label': t('Fields_Id') });
      id.addEventListener('input', () => { f.id = id.value; id.title = id.value; ctx.changed(); });
      let valueCell;
      if (f.kind === 'password') valueCell = passwordCell(f, ctx);
      else if (f.kind === 'checkbox' || f.kind === 'radio') {
        const c = el('input', { type: 'checkbox', checked: f.value === 'on' || f.value === 'true' || f.value === '1', 'aria-label': t('Fields_Value') });
        c.addEventListener('input', () => { f.value = c.checked ? 'on' : ''; ctx.changed(); });
        valueCell = c;
      } else {
        const v = el('input', { type: 'text', value: f.value || '', 'aria-label': t('Fields_Value') });
        v.addEventListener('input', () => { f.value = v.value; ctx.changed(); });
        valueCell = v;
      }
      const kind = el('select', { 'aria-label': t('Fields_Kind') });
      for (const k of KINDS) kind.append(el('option', { value: k, text: t('Kind_' + k) }));
      kind.value = f.kind || 'text';
      kind.addEventListener('change', () => { f.kind = kind.value; ctx.changed(); render(); });
      const role = el('select', { 'aria-label': t('Fields_Role') });
      for (const [v, k] of ROLES) role.append(el('option', { value: v, text: t(k) }));
      role.value = f.role || '';
      role.addEventListener('change', () => { f.role = role.value || null; ctx.changed(); });
      const del = el('button', { type: 'button', class: 'icon danger', icon: 'x', title: t('Fields_Remove'), 'aria-label': t('Fields_Remove'),
        onclick: () => { item.fields.splice(i, 1); ctx.changed(); render(); } });
      tbody.append(el('tr', null, el('td', null, name), el('td', null, id), el('td', null, valueCell), el('td', null, kind), el('td', null, role), el('td', null, del)));
    });
  };
  render();
  const add = el('button', { type: 'button', text: t('Fields_Add'), onclick: () => { item.fields.push({ name: '', id: '', value: '', kind: 'text', role: null }); ctx.changed(); render(); } });
  return el('div', { class: 'col' },
    el('table', { class: 'grid fields-table fields-login' },
      el('thead', null, el('tr', null, ...['Fields_Name', 'Fields_Id', 'Fields_Value', 'Fields_Kind', 'Fields_Role'].map((k) => el('th', { text: t(k) })), el('th'))),
      tbody),
    el('div', null, add));
}

function totpSection(item, ctx) {
  const input = el('input', { type: 'text', value: item.totpKey || '', class: 'mono', autocomplete: 'off', 'aria-label': t('Login_Totp') });
  input.addEventListener('input', () => { item.totpKey = input.value.trim(); ctx.changed(); });
  const qr = el('button', { type: 'button', text: t('Totp_FromQr'),
    onclick: async () => {
      const p = await pickOpen(t('Totp_QrPick'), t('Totp_ImageFilter'), ['png', 'jpg', 'jpeg', 'bmp', 'gif']);
      if (!p) return;
      try {
        const r = await rpc('decodeQr', { path: p });
        item.totpKey = r.text; input.value = r.text; ctx.changed();
      } catch (e) { showError(e); }
    } });
  const box = el('div', { class: 'totp-box hidden' });
  const section = el('div', { class: 'col' }, field(t('Login_Totp'), input, t('Login_TotpHint')), el('div', null, qr), box);
  if (totpTimer) { clearInterval(totpTimer); totpTimer = null; }
  if (!ctx.isNew && item.totpKey && item.totpKey === ctx.savedTotpKey) {
    let remain = 0, code = '', period = 30;
    const draw = () => {
      box.replaceChildren(
        el('span', { class: 'totp-code', text: code ? code.replace(/(\d{3})(\d+)/, '$1 $2') : '------', tabIndex: 0, role: 'button', title: t('Totp_ClickCopy'),
          onclick: () => code && copySecret(code, t('Login_Totp')), onkeydown: (e) => { if (e.key === 'Enter') code && copySecret(code, t('Login_Totp')); } }),
        ringSvg(remain, period), el('span', { class: 'sub', text: t('Totp_Remain', remain) }));
      box.classList.remove('hidden');
    };
    const fetchCode = async () => {
      try { const r = await rpc('totp', { id: item.id }); code = r.code; remain = r.remainSec; period = r.period; draw(); } catch (_) { box.classList.add('hidden'); }
    };
    fetchCode();
    totpTimer = setInterval(() => { remain -= 1; if (remain <= 0) fetchCode(); else draw(); }, 1000);
  }
  return section;
}

function ringSvg(remain, period) {
  const r = 11, c = 2 * Math.PI * r;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 28 28'); svg.setAttribute('class', 'ring'); svg.setAttribute('aria-hidden', 'true');
  const bg = document.createElementNS(ns, 'circle');
  for (const [k, v] of Object.entries({ cx: 14, cy: 14, r, fill: 'none', stroke: 'var(--line)', 'stroke-width': 3 })) bg.setAttribute(k, v);
  const fg = document.createElementNS(ns, 'circle');
  for (const [k, v] of Object.entries({ cx: 14, cy: 14, r, fill: 'none', stroke: remain <= 5 ? 'var(--coral)' : 'var(--sky)', 'stroke-width': 3,
    'stroke-dasharray': c, 'stroke-dashoffset': c * (1 - Math.max(0, remain) / period), transform: 'rotate(-90 14 14)' })) fg.setAttribute(k, v);
  svg.append(bg, fg);
  return svg;
}

function chainSection(item, ctx) {
  item.chain = item.chain || { previous: [], next: [] };
  const logins = S.entries.filter((e) => e.type === TYPE_LOGIN && !e.deleted && e.id !== item.id);
  const nameOf = (id) => (S.byId.get(id) || { name: id }).name;
  const mk = (which, labelKey) => {
    const chips = el('div', { class: 'chips' });
    const sel = el('select', { 'aria-label': t(labelKey) });
    const draw = () => {
      chips.replaceChildren(...item.chain[which].map((id, i) => el('span', { class: 'chip' }, nameOf(id),
        el('button', { type: 'button', icon: 'x', 'aria-label': t('Fields_Remove'), onclick: () => { item.chain[which].splice(i, 1); ctx.changed(); draw(); } }))));
      sel.replaceChildren(el('option', { value: '', text: t('Chain_Add') }), ...logins.filter((e) => !item.chain[which].includes(e.id)).map((e) => el('option', { value: e.id, text: e.name })));
    };
    sel.addEventListener('change', () => { if (sel.value) { item.chain[which].push(sel.value); ctx.changed(); draw(); } });
    draw();
    return el('div', { class: 'col' }, el('span', { class: 'sub', text: t(labelKey) }), chips, sel);
  };
  return el('details', null, el('summary', { text: t('Login_Chain') }), el('div', { class: 'col', style: 'margin-top:8px' }, el('div', { class: 'sub', text: t('Login_ChainHint') }), mk('previous', 'Chain_Previous'), mk('next', 'Chain_Next')));
}

function historySection(item) {
  if (!item.passwordHistory || !item.passwordHistory.length) return null;
  const ul = el('ul', { class: 'hist-list' });
  [...item.passwordHistory].reverse().forEach((h) => {
    const span = el('span', { class: 'mono grow selectable', text: '•'.repeat(10) });
    ul.append(el('li', null, span, el('span', { class: 'sub', text: fmtDate(h.changed) }),
      el('button', { type: 'button', class: 'icon', icon: 'eye', 'aria-label': t('Cmd_Show'), onclick: () => { span.textContent = span.textContent.startsWith('•') ? h.value : '•'.repeat(10); } }),
      el('button', { type: 'button', class: 'icon', icon: 'copy', 'aria-label': t('Cmd_CopyPassword'), onclick: () => copySecret(h.value) })));
  });
  return el('details', null, el('summary', { text: t('Login_History', item.passwordHistory.length) }), ul);
}

/** パスキーの一覧（サイト、ユーザー名、作成日、最終使用日）。削除は確認ダイアログを経て、専用のコマンドで行う。 */
function passkeysSection(item, ctx) {
  const list = item.passkeys || [];
  if (!list.length) return null;
  const ul = el('ul', { class: 'hist-list' });
  list.forEach((k) => {
    const who = k.userDisplayName && k.userDisplayName !== k.userName ? `${k.userName} (${k.userDisplayName})` : k.userName;
    ul.append(el('li', null,
      el('span', { class: 'grow selectable', text: `${k.rpId}  ${who}` }),
      el('span', { class: 'sub', text: `${t('Pk_Created', fmtDate(k.created))} / ${k.lastUsed ? t('Pk_LastUsed', fmtDate(k.lastUsed)) : t('Pk_NeverUsed')}` }),
      ctx.isNew ? null : el('button', {
        type: 'button', class: 'icon', icon: 'trash', 'aria-label': t('Pk_Delete'), title: t('Pk_Delete'),
        onclick: async () => {
          if (!(await dialog.confirm(t('Pk_DeleteConfirm'), { danger: true, okLabel: t('Pk_Delete') }))) return;
          try { await rpc('passkeyDelete', { itemId: item.id, credentialId: k.credentialId }); await ctx.passkeysChanged(); toast(t('Pk_Deleted')); } catch (e) { showError(e); }
        },
      })));
  });
  return el('details', { open: 'open' }, el('summary', { text: t('Pk_Section', list.length) }), ul);
}

function formLogin(item, ctx) {
  const url = bind(el('input', { type: 'text', value: item.url || '', placeholder: 'https://', 'aria-label': t('Login_Url') }), item, 'url', ctx);
  const level = el('select', { 'aria-label': t('Login_MatchLevel') });
  for (const [v, k] of [['domain', 'Match_Domain'], ['host', 'Match_Host'], ['prefix', 'Match_Prefix'], ['exact', 'Match_Exact']]) level.append(el('option', { value: v, text: t(k) }));
  level.value = item.matchLevel || 'domain';
  level.addEventListener('change', () => { item.matchLevel = level.value; ctx.changed(); });
  const matchUrl = bind(el('input', { type: 'text', value: item.matchUrl || '', placeholder: t('Login_MatchUrlPlaceholder') }), item, 'matchUrl', ctx);
  const open = el('button', { type: 'button', text: t('Cmd_GoTo'), onclick: () => item.url && rpc('openUrl', { url: /^https?:/i.test(item.url) ? item.url : 'https://' + item.url }).catch(showError) });
  const note = bind(el('textarea', { rows: 3, value: item.note || '', 'aria-label': t('Login_Note') }), item, 'note', ctx);
  const tip = bind(el('input', { type: 'text', value: item.hint || '', 'aria-label': t('Login_Hint') }), item, 'hint', ctx);
  // 既定（チェックなし）は、記入して送信する。送信したくないログインだけ、チェックを入れる
  const noSubmit = bind(el('input', { type: 'checkbox', checked: !!item.noSubmit }), item, 'noSubmit', ctx, true);
  const basic = bind(el('input', { type: 'checkbox', checked: !!item.basicAuth }), item, 'basicAuth', ctx, true);
  return [
    el('div', { class: 'two' }, field(t('Login_Url'), el('div', { class: 'row' }, url, open)), field(t('Login_MatchLevel'), level)),
    el('h2', { text: t('Login_Fields') }),
    fieldsTable(item, ctx),
    totpSection(item, ctx),
    field(t('Login_Note'), note),
    field(t('Login_Hint'), tip),
    // ふだん触らない設定は、折りたたむ
    el('details', { class: 'fold', id: 'adv' }, el('summary', { text: t('Login_Advanced') }), el('div', { class: 'col', style: 'margin-top:8px' },
      field(t('Login_MatchUrl'), matchUrl, t('Login_MatchUrlHint')),
      el('label', { class: 'check' }, noSubmit, el('span', { text: t('Login_NoSubmit') })),
      el('label', { class: 'check' }, basic, el('span', { text: t('Login_BasicAuth') })),
      chainSection(item, ctx))),
    passkeysSection(item, ctx),
    historySection(item),
  ];
}

function formBookmark(item, ctx) {
  return [
    field(t('Login_Url'), bind(el('input', { type: 'text', value: item.url || '', placeholder: 'https://' }), item, 'url', ctx)),
    field(t('Login_Note'), bind(el('textarea', { rows: 4, value: item.note || '' }), item, 'note', ctx)),
  ];
}

function formApp(item, ctx) {
  return [
    el('div', { class: 'sub', text: t('App_Help') }),
    field(t('App_ExePath'), bind(el('input', { type: 'text', value: item.exePath || '' }), item, 'exePath', ctx)),
    field(t('App_WindowTitle'), bind(el('input', { type: 'text', value: item.windowTitle || '' }), item, 'windowTitle', ctx)),
    el('h2', { text: t('Login_Fields') }), fieldsTable(item, ctx),
  ];
}

function formNote(item, ctx) {
  const ta = bind(el('textarea', { rows: 18, value: item.text || '', class: 'selectable', 'aria-label': t('Type_Note') }), item, 'text', ctx);
  const mono = el('input', { type: 'checkbox', checked: localStorage.getItem('tkrform.mono') === '1' });
  const applyMono = () => { ta.style.fontFamily = mono.checked ? 'var(--mono)' : ''; try { localStorage.setItem('tkrform.mono', mono.checked ? '1' : '0'); } catch (_) { /* 無視 */ } };
  mono.addEventListener('change', applyMono); applyMono();
  return [el('label', { class: 'check' }, mono, el('span', { text: t('Note_Mono') })), ta];
}

// ------------------------------------------------------------------ プロフィール / 連絡先

function ensureInstance(item, group, idx) {
  let g = item.groups.find((x) => x.group === group);
  if (!g) { g = { group, instances: [] }; item.groups.push(g); }
  if (!g.instances.length) g.instances.push({ name: t('Identity_DefaultInstance'), fields: {} });
  return g.instances[Math.min(idx, g.instances.length - 1)];
}

async function formIdentity(item, ctx, host) {
  item.groups = item.groups || [];
  if (!item.country) item.country = 'JP';
  const wrap = el('div', { class: 'col' });
  const country = el('select', { 'aria-label': t('Identity_Country') }, el('option', { value: 'JP', text: t('Country_JP') }), el('option', { value: 'US', text: t('Country_US') }));
  country.value = item.country;
  let current = IDENTITY_GROUPS_ORDER[0];
  const body = el('div', { class: 'col' });

  const draw = async () => {
    const layout = await getLayout(item.country);
    const tabs = el('div', { class: 'group-tabs', role: 'tablist' });
    for (const l of layout) {
      tabs.append(el('button', { type: 'button', role: 'tab', 'aria-selected': String(l.group === current), text: t('Group_' + l.group), onclick: () => { current = l.group; draw(); } }));
    }
    body.replaceChildren(tabs);
    const lay = layout.find((l) => l.group === current);
    const g = item.groups.find((x) => x.group === current);
    const idx = Math.min(activeInstance[item.id + current] || 0, Math.max(0, (g ? g.instances.length : 1) - 1));
    // インスタンスの切替（＋で追加）
    const names = g && g.instances.length ? g.instances.map((i) => i.name) : [t('Identity_DefaultInstance')];
    const isel = el('select', { 'aria-label': t('Identity_Instance') });
    names.forEach((n, i) => isel.append(el('option', { value: i, text: n })));
    isel.value = idx;
    isel.addEventListener('change', () => { activeInstance[item.id + current] = Number(isel.value); draw(); });
    const add = el('button', { type: 'button', class: 'icon', icon: 'plus', title: t('Identity_AddInstance'), 'aria-label': t('Identity_AddInstance'),
      onclick: async () => {
        const n = await dialog.prompt(t('Identity_InstanceName'), '');
        if (!n) return;
        ensureInstance(item, current, 0);
        const gg = item.groups.find((x) => x.group === current);
        gg.instances.push({ name: n, fields: {} });
        activeInstance[item.id + current] = gg.instances.length - 1;
        ctx.changed(); draw();
      } });
    const ren = el('button', { type: 'button', class: 'icon', icon: 'edit', title: t('Cmd_Rename'), 'aria-label': t('Cmd_Rename'),
      onclick: async () => {
        const inst = ensureInstance(item, current, idx);
        const n = await dialog.prompt(t('Identity_InstanceName'), inst.name);
        if (n) { inst.name = n; ctx.changed(); draw(); }
      } });
    const del = el('button', { type: 'button', class: 'icon danger', icon: 'minus', title: t('Identity_RemoveInstance'), 'aria-label': t('Identity_RemoveInstance'),
      onclick: async () => {
        if (!g || !g.instances.length) return;
        if (!(await dialog.confirm(t('Identity_RemoveInstanceConfirm', g.instances[idx].name), { danger: true, okLabel: t('Cmd_Delete') }))) return;
        g.instances.splice(idx, 1);
        activeInstance[item.id + current] = 0;
        ctx.changed(); draw();
      } });
    body.append(el('div', { class: 'row' }, el('span', { class: 'sub', text: t('Identity_Instance') }), isel, add, ren, del));

    if (current === 'Custom') { body.append(customRows(item, idx, ctx, draw)); return; }
    const inst = g && g.instances[idx] ? g.instances[idx] : { fields: {} };
    const grid = el('div', { class: 'idgrid' });
    for (const key of lay.keys) {
      const sensitive = SENSITIVE_KEYS.has(key);
      const input = el('input', { type: sensitive ? 'password' : 'text', value: inst.fields[key] || '', autocomplete: 'off', 'aria-label': t('Field_' + key) });
      input.addEventListener('input', () => {
        const target = ensureInstance(item, current, idx);
        if (input.value) target.fields[key] = input.value; else delete target.fields[key];
        ctx.changed();
      });
      const ctl = sensitive
        ? el('div', { class: 'pwcell' }, input, el('button', { type: 'button', class: 'icon', icon: 'eye', 'aria-label': t('Cmd_Show'), onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; } }))
        : input;
      grid.append(field(t('Field_' + key), ctl));
    }
    body.append(grid);
  };

  country.addEventListener('change', () => { item.country = country.value; ctx.changed(); draw(); });
  wrap.append(field(t('Identity_Country'), country), body);
  host.push(wrap);
  await draw();
}

function customRows(item, idx, ctx, redraw) {
  const inst = ensureInstance(item, 'Custom', idx);
  inst.customMatches = inst.customMatches || {};
  const tbody = el('tbody');
  const keys = Object.keys(inst.fields);
  keys.forEach((k) => {
    const key = el('input', { type: 'text', value: k, 'aria-label': t('Custom_Key') });
    const val = el('input', { type: 'text', value: inst.fields[k], 'aria-label': t('Custom_Value') });
    const re = el('input', { type: 'text', value: inst.customMatches[k] || '', class: 'mono', 'aria-label': t('Custom_Match') });
    let cur = k;
    key.addEventListener('change', () => {
      if (!key.value || (key.value !== cur && key.value in inst.fields)) { key.value = cur; return; }
      inst.fields[key.value] = inst.fields[cur]; delete inst.fields[cur];
      if (cur in inst.customMatches) { inst.customMatches[key.value] = inst.customMatches[cur]; delete inst.customMatches[cur]; }
      cur = key.value; ctx.changed();
    });
    val.addEventListener('input', () => { inst.fields[cur] = val.value; ctx.changed(); });
    re.addEventListener('input', () => { if (re.value) inst.customMatches[cur] = re.value; else delete inst.customMatches[cur]; ctx.changed(); });
    const del = el('button', { type: 'button', class: 'icon danger', icon: 'x', 'aria-label': t('Fields_Remove'), onclick: () => { delete inst.fields[cur]; delete inst.customMatches[cur]; ctx.changed(); redraw(); } });
    tbody.append(el('tr', null, el('td', null, key), el('td', null, val), el('td', null, re), el('td', null, del)));
  });
  const add = el('button', { type: 'button', text: t('Fields_Add'),
    onclick: () => { let n = 1; while (('Custom' + n) in inst.fields) n++; inst.fields['Custom' + n] = ''; ctx.changed(); redraw(); } });
  return el('div', { class: 'col' }, el('div', { class: 'sub', text: t('Custom_Hint') }),
    el('table', { class: 'grid fields-table' }, el('thead', null, el('tr', null, ...['Custom_Key', 'Custom_Value', 'Custom_Match'].map((k) => el('th', { text: t(k) })), el('th'))), tbody),
    el('div', null, add));
}

// ------------------------------------------------------------------ ログインの表示画面（編集の前に見せる）

/** ログインのフィールドから、ユーザー ID・パスワードの値を取り出す（役割が付いたものを優先）。 */
function loginRoleValue(item, role) {
  const fs = item.fields || [];
  const f = role === 'user'
    ? fs.find((x) => x.role === 'user') || fs.find((x) => x.kind === 'text' && x.value)
    : fs.find((x) => x.role === 'password') || fs.find((x) => x.kind === 'password');
  return f ? f.value || '' : '';
}

function vrow(label, value, ...buttons) {
  return el('div', { class: 'vrow' }, el('div', { class: 'grow' }, el('div', { class: 'k', text: label }), value), ...buttons);
}

/** ログインを、見るだけの画面で出す。編集は「編集」ボタンから（ctx.onEdit）。 */
function renderLoginView(host, item, ctx) {
  if (totpTimer) { clearInterval(totpTimer); totpTimer = null; }
  const user = loginRoleValue(item, 'user'), pw = loginRoleValue(item, 'password');
  const folder = item.folder && item.folder !== '/' ? item.folder.replace(/^\//, '') : t('Folder_Root');
  const head = el('div', { class: 'vhead' }, avatar(item.name, item.type, 'lg'),
    el('div', { class: 'grow' },
      el('h1', { class: 'vname' }, item.name, item.favorite ? el('span', { class: 'star', icon: 'star', 'aria-label': t('Item_Favorite') }) : null),
      el('div', { class: 'sub' }, icon('folder'), ' ', folder)));
  const acts = el('div', { class: 'vacts' },
    el('button', { type: 'button', class: 'primary', id: 'v-login', icon: 'fill', onclick: ctx.onLogin }, t('Menu_Login')),
    el('button', { type: 'button', id: 'v-gofill', onclick: ctx.onGoFill, text: t('Menu_GoFill') }),
    el('div', { class: 'grow' }),
    el('button', { type: 'button', id: 'v-edit', icon: 'edit', onclick: ctx.onEdit }, t('Cmd_Edit')));
  const rows = [];
  if (user) rows.push(vrow(t('Role_User'), el('div', { class: 'v selectable', text: user }),
    el('button', { type: 'button', class: 'icon', icon: 'copy', title: t('Cmd_CopyUser'), 'aria-label': t('Cmd_CopyUser'), onclick: () => copyPlain(user) })));
  if (pw) {
    const val = el('div', { class: 'v mono selectable', text: '•'.repeat(10) });
    rows.push(vrow(t('Field_Password'), val,
      el('button', { type: 'button', class: 'icon', icon: 'eye', title: t('Cmd_Show'), 'aria-label': t('Cmd_Show'), onclick: () => { val.textContent = val.textContent.startsWith('•') ? pw : '•'.repeat(10); } }),
      el('button', { type: 'button', class: 'icon', icon: 'copy', title: t('Cmd_CopyPassword'), 'aria-label': t('Cmd_CopyPassword'), onclick: () => copySecret(pw) })));
  }
  if (item.url) rows.push(vrow(t('Login_Url'), el('div', { class: 'v selectable', text: item.url }),
    el('button', { type: 'button', class: 'icon', icon: 'open', title: t('Cmd_GoTo'), 'aria-label': t('Cmd_GoTo'), onclick: () => rpc('openUrl', { url: /^https?:/i.test(item.url) ? item.url : 'https://' + item.url }).catch(showError) })));
  if (item.totpKey) {
    const box = el('div', { class: 'v totp-line' }, el('span', { class: 'totp-code', text: '------' }));
    rows.push(vrow(t('Login_Totp'), box));
    let remain = 0, code = '', period = 30;
    const draw = () => {
      box.replaceChildren(
        el('span', { class: 'totp-code', text: code ? code.replace(/(\d{3})(\d+)/, '$1 $2') : '------', tabIndex: 0, role: 'button', title: t('Totp_ClickCopy'),
          onclick: () => code && copySecret(code, t('Login_Totp')), onkeydown: (e) => { if (e.key === 'Enter') code && copySecret(code, t('Login_Totp')); } }),
        ringSvg(remain, period), el('span', { class: 'sub', text: t('Totp_Remain', remain) }));
    };
    const fetchCode = async () => {
      try { const r = await rpc('totp', { id: item.id }); code = r.code; remain = r.remainSec; period = r.period; draw(); } catch (_) { box.replaceChildren(el('span', { class: 'sub', text: '–' })); }
    };
    fetchCode();
    totpTimer = setInterval(() => { remain -= 1; if (remain <= 0) fetchCode(); else draw(); }, 1000);
  }
  if (item.note) rows.push(vrow(t('Login_Note'), el('div', { class: 'v selectable', style: 'white-space:pre-wrap', text: item.note })));
  if (item.hint) rows.push(vrow(t('Login_Hint'), el('div', { class: 'v selectable', text: item.hint })));
  const meta = ctx.meta;
  const foot = el('div', { class: 'vmeta sub' },
    meta && meta.modified ? el('span', { text: t('View_Modified', fmtDate(meta.modified)) }) : null,
    meta && meta.useCount ? el('span', { text: t('View_UseCount', meta.useCount) }) : null,
    item.passkeys && item.passkeys.length ? el('span', { class: 'pill info' }, icon('key'), ' ', t('Pk_Badge')) : null);
  host.replaceChildren(el('div', { class: 'form view' }, head, acts, rows.length ? el('div', { class: 'vrows' }, ...rows) : null, foot));
}

// ------------------------------------------------------------------ 入口

/** フォームを `host`（要素）に描画する。ctx = {changed, isNew, savedTotpKey, readonly, onSave, onRevert, onRestore, onPurge} */
async function renderForm(host, item, ctx) {
  if (totpTimer) { clearInterval(totpTimer); totpTimer = null; }
  const kindKey = { 1: 'Type_Login', 2: 'Type_Bookmark', 4: 'Type_AppLogin', 5: 'Type_Identity', 6: 'Type_Contact', 7: 'Type_Note', 8: 'Type_Folder' }[item.type];
  const name = bind(el('input', { type: 'text', value: item.name || '', id: 'f-name', 'aria-label': t('Item_Name') }), item, 'name', ctx);
  const fav = bind(el('input', { type: 'checkbox', checked: !!item.favorite }), item, 'favorite', ctx, true);
  const parts = [];
  parts.push(el('h1', { text: ctx.isNew ? t('Editor_NewItem', t(kindKey)) : t(kindKey) }));
  parts.push(el('div', { class: 'two' }, field(t('Item_Name'), name), field(t('Item_Folder'), folderSelect(item, ctx))));
  if (item.type !== TYPE_FOLDER) parts.push(el('label', { class: 'check' }, fav, el('span', { text: t('Item_Favorite') })));
  const rest = [];
  if (item.type === TYPE_LOGIN) rest.push(...formLogin(item, ctx));
  else if (item.type === TYPE_BOOKMARK) rest.push(...formBookmark(item, ctx));
  else if (item.type === TYPE_APP) rest.push(...formApp(item, ctx));
  else if (item.type === TYPE_NOTE) rest.push(...formNote(item, ctx));
  else if (item.type === TYPE_IDENTITY || item.type === TYPE_CONTACT) await formIdentity(item, ctx, rest);
  parts.push(...rest);

  const save = el('button', { type: 'button', class: 'primary', id: 'f-save', text: t('Common_Save'), onclick: () => ctx.onSave() });
  const revert = el('button', { type: 'button', id: 'f-revert', text: t('Cmd_Revert'), onclick: () => ctx.onRevert() });
  parts.push(el('div', { class: 'actions' }, save, revert));
  host.replaceChildren(el('div', { class: 'form' }, ...parts));
  if (ctx.isNew) { const n = $('#f-name'); if (n) n.focus(); }
}
