'use strict';
// エディタのダイアログ: インポート、エクスポート、印刷（§10.2 / §14）。

const MAP_TARGETS = [['name', 'Import_Col_Name'], ['url', 'Import_Col_Url'], ['username', 'Import_Col_User'], ['password', 'Import_Col_Password'],
  ['note', 'Import_Col_Note'], ['folder', 'Import_Col_Folder'], ['totp', 'Import_Col_Totp']];

async function importDialog() {
  const path = await pickOpen(t('Import_PickTitle'), t('Import_FileFilter'), ['csv', 'json']);
  if (!path) return;
  let pv;
  let source = '';
  const load = async () => { pv = await rpc('importPreview', source ? { path, format: source } : { path }); };
  try { await load(); } catch (e) { showError(e); return; }

  let result;
  for (;;) {
  result = await openDialog((f, close) => {
    const body = el('div', { class: 'col' });
    const selects = {};
    // Keeper の CSV はヘッダ行がないので、形式を指定できるようにする
    const src = el('select', { 'aria-label': t('Import_Source') });
    src.append(el('option', { value: '', text: t('Import_Source_Auto') }), el('option', { value: 'keeper', text: t('Import_Source_Keeper') }));
    src.value = source;
    src.addEventListener('change', () => { source = src.value; close('__reload'); });
    if (pv.kind === 'csv') body.append(el('label', { class: 'field' }, el('span', { text: t('Import_Source') }), src));
    let infoKey = pv.kind === 'bitwarden' ? 'Import_Kind_Bitwarden' : pv.kind === 'tkrform' ? 'Import_Kind_Tkrform' : 'Import_Format_' + pv.format;
    body.append(el('div', { class: 'sub', text: path }), el('div', { text: t(infoKey) + (pv.rowCount !== undefined ? '  ' + t('Import_CsvInfo', pv.rowCount) : '') }),
      el('div', { class: 'sub', text: t('Legal_Trademarks') }));
    if (pv.kind === 'csv') {
      const grid = el('div', { class: 'two' });
      for (const [key, label] of MAP_TARGETS) {
        const sel = el('select', { 'aria-label': t(label) });
        sel.append(el('option', { value: '', text: t('Import_None') }));
        pv.headers.forEach((h, i) => sel.append(el('option', { value: String(i), text: h })));
        sel.value = pv.mapping[key] === null || pv.mapping[key] === undefined ? '' : String(pv.mapping[key]);
        selects[key] = sel;
        grid.append(el('label', { class: 'field' }, el('span', { text: t(label) }), sel));
      }
      body.append(el('h2', { text: t('Import_Mapping') }), grid);
      if (pv.sample && pv.sample.length) {
        body.append(el('div', { class: 'sub', text: t('Import_Sample') }),
          el('table', { class: 'grid' }, el('thead', null, el('tr', null, ...pv.headers.map((h) => el('th', { text: h })))),
            el('tbody', null, ...pv.sample.map((r) => el('tr', null, ...r.map((c) => el('td', { text: c })))))));
      }
    }
    const skip = el('input', { type: 'checkbox', checked: true });
    body.append(el('label', { class: 'check' }, skip, el('span', { text: t('Import_SkipDup') })), el('div', { class: 'sub', text: t('Import_FolderNote') }));
    f.append(el('div', { class: 'title', text: t('Cmd_Import') }), body,
      el('div', { class: 'actions' },
        el('button', { type: 'button', text: t('Common_Cancel'), onclick: () => close(null) }),
        el('button', {
          type: 'submit', class: 'primary', text: t('Import_Run'),
          onclick: async (e) => {
            e.preventDefault();
            const mapping = {};
            for (const [k] of MAP_TARGETS) mapping[k] = selects[k] && selects[k].value !== '' ? Number(selects[k].value) : null;
            try {
              const r = await rpc('importRun', { path, kind: pv.kind, format: source || undefined, mapping: pv.kind === 'csv' ? mapping : null, skipDuplicates: skip.checked });
              close(r);
            } catch (er) { showError(er); }
          },
        })));
  }, { wide: true });
  if (result === '__reload') { try { await load(); } catch (e) { showError(e); return; } continue; }
  break;
  }
  if (!result) return;
  await reload();
  const dup = result.duplicates.length ? '\n\n' + t('Import_DupList', result.duplicates.slice(0, 20).join('\n') + (result.duplicates.length > 20 ? '\n…' : '')) : '';
  await dialog.alert(t('Import_Done', result.added, result.duplicates.length, result.folder) + dup, t('Cmd_Import'));
}

async function exportDialog() {
  const fmt = await openDialog((f, close) => {
    const radios = [['csv', 'Export_Csv'], ['json', 'Export_Json'], ['tkb', 'Export_Tkb']].map(([v, k], i) =>
      el('label', { class: 'check' }, el('input', { type: 'radio', name: 'fmt', value: v, checked: i === 0 }), el('span', { text: t(k) })));
    const note = el('div', { class: 'msg warn', text: t('Export_PlainWarning') });
    f.append(el('div', { class: 'title', text: t('Cmd_Export') }), ...radios, note,
      el('div', { class: 'actions' },
        el('button', { type: 'button', text: t('Common_Cancel'), onclick: () => close(null) }),
        el('button', { type: 'submit', class: 'primary', text: t('Common_Next'), onclick: (e) => { e.preventDefault(); close($$('input[name=fmt]', f).find((r) => r.checked).value); } })));
  });
  if (!fmt) return;
  // 平文で出すときは MP の再入力を必須とする（§14.2）
  const pw = await dialog.reauth(t('Export_Reauth'));
  if (pw === null) return;
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const names = { csv: [`tkrform-${stamp}.csv`, 'CSV', ['csv']], json: [`tkrform-${stamp}.json`, 'JSON', ['json']], tkb: [`tkrform-${stamp}.tkb`, t('Export_TkbFilter'), ['tkb']] };
  const [fname, filterName, exts] = names[fmt];
  const dest = await pickSave(t('Cmd_Export'), fname, filterName, exts);
  if (!dest) return;
  try {
    const r = await rpc('exportData', { format: fmt, path: dest, password: pw });
    await dialog.alert(t('Export_Done', dest) + (r.skippedCorrupt ? '\n' + t('Export_SkippedCorrupt', r.skippedCorrupt) : ''), t('Cmd_Export'));
  } catch (e) { showError(e); }
}

// 印刷: 一覧（名前・URL・ユーザー ID）。パスワードを含めるかを選び、印刷前に MP の再入力を求める
async function printDialog(ids) {
  const logins = ids.map((id) => S.byId.get(id)).filter((e) => e && !e.deleted && (e.type === TYPE_LOGIN || e.type === TYPE_BOOKMARK));
  if (!logins.length) { toast(t('Print_Nothing'), 'error'); return; }
  const withPw = await openDialog((f, close) => {
    const c = el('input', { type: 'checkbox' });
    f.append(el('div', { class: 'title', text: t('Cmd_Print') }), el('div', { text: t('Print_Count', logins.length) }),
      el('label', { class: 'check' }, c, el('span', { text: t('Print_IncludePasswords') })),
      el('div', { class: 'msg warn', text: t('Print_Warning') }),
      el('div', { class: 'actions' },
        el('button', { type: 'button', text: t('Common_Cancel'), onclick: () => close(null) }),
        el('button', { type: 'submit', class: 'primary', text: t('Cmd_Print'), onclick: (e) => { e.preventDefault(); close(c.checked ? 'yes' : 'no'); } })));
  });
  if (!withPw) return;
  if ((await dialog.reauth(t('Print_Reauth'))) === null) return;

  const rows = [];
  for (const e of logins) {
    let pw = '';
    if (withPw === 'yes' && e.type === TYPE_LOGIN) {
      try { pw = (await rpc('getItem', { id: e.id })).fields.find((x) => x.role === 'password')?.value || ''; } catch (_) { pw = ''; }
    }
    rows.push([e.name, e.url, e.user || '', pw]);
  }
  const head = [t('Item_Name'), t('Login_Url'), t('Print_User')];
  if (withPw === 'yes') head.push(t('Field_Password'));
  const area = $('#print-area');
  area.replaceChildren(el('h2', { text: `tkrform  ${fmtDate(new Date().toISOString())}` }),
    el('table', null, el('thead', null, el('tr', null, ...head.map((h) => el('th', { text: h })))),
      el('tbody', null, ...rows.map((r) => el('tr', null, ...r.slice(0, head.length).map((c) => el('td', { text: c })))))));
  window.print();
  // 印刷用の平文は画面に残さない
  setTimeout(() => area.replaceChildren(), 1500);
}
