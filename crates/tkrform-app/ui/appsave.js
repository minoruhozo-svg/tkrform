'use strict';
// Windows アプリログインの保存（Ctrl+Alt+A で取り込んだ前面ウィンドウから）。

(async () => {
  await initI18n();
  let cap;
  try { cap = await rpc('appCaptureGet'); } catch (e) { showError(e); return; }
  $('#exe').textContent = cap.exePath;
  $('#name').value = cap.exeName.replace(/\.exe$/i, '');
  $('#title').value = cap.title;
  const rows = cap.fields.map((f) => {
    const use = el('input', { type: 'checkbox', checked: !!(f.id || f.name) });
    const val = el('input', { type: f.isPassword ? 'password' : 'text', value: f.value, autocomplete: 'off', 'aria-label': t('Fields_Value') });
    $('#rows').append(el('tr', null, el('td', null, use), el('td', { class: 'mono', text: f.id }), el('td', { text: f.name }), el('td', null, val)));
    return { f, use, val };
  });
  if (!rows.length) $('#rows').append(el('tr', null, el('td', { colspan: 4, class: 'sub', text: t('AppSave_NoFields') })));
  $('#cancel').addEventListener('click', () => invoke('close_self'));
  $('#save').addEventListener('click', async () => {
    const name = $('#name').value.trim();
    if (!name) { toast(t('Err_NameEmpty'), 'error'); return; }
    let seenUser = false;
    const fields = [];
    for (const r of rows.filter((x) => x.use.checked)) {
      const isPw = r.f.isPassword;
      const role = isPw ? 'password' : (!seenUser ? 'user' : null);
      if (!isPw) seenUser = true;
      fields.push({ name: r.f.name || r.f.id, id: r.f.id, value: r.val.value, kind: isPw ? 'password' : 'text', role });
    }
    try {
      await rpc('saveItem', { mode: 'new', item: { type: 4, name, folder: '/', exePath: cap.exePath, windowTitle: $('#title').value.trim(), fields, submit: $('#submit').checked } });
      toast(t('Editor_Saved'));
      await invoke('close_self');
    } catch (e) { showError(e); }
  });
})();
