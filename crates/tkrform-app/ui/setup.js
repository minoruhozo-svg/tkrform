'use strict';
(async () => {
  await initI18n();
  const TOTAL = 6;
  let step = 1;
  let created = false;
  let importPath = null;
  const bar = $('#bar');
  for (let i = 1; i <= TOTAL; i++) bar.append(el('i'));

  const meter = meterEl();
  $('#meter-host').append(meter);
  let bitsNow = 0;
  const upd = attachStrength($('#mp1'), meter, $('#bits'));
  $('#mp1').addEventListener('input', async () => {
    await upd();
    const r = $('#mp1').value ? await rpc('strength', { password: $('#mp1').value }) : { bits: 0 };
    bitsNow = r.bits;
    $('#weak-row').classList.toggle('hidden', !($('#mp1').value && bitsNow < 50));
  });

  function show(n) {
    step = n;
    $$('.step').forEach((s) => s.classList.toggle('active', Number(s.dataset.step) === n));
    $$('#bar i').forEach((b, i) => b.classList.toggle('done', i < n));
    $('#back').classList.toggle('hidden', n === 1 || n >= 5);
    $('#skip').classList.toggle('hidden', n !== 6);
    $('#next').textContent = n === 4 ? t('Setup_CreateButton') : n === 6 ? t('Setup_Finish') : t('Common_Next');
    if (n === 3) $('#mp1').focus();
  }

  async function validateMp() {
    const msg = $('#mp-msg');
    msg.classList.add('hidden');
    const a = $('#mp1').value, b = $('#mp2').value;
    const fail = (k) => { msg.textContent = t(k); msg.classList.remove('hidden'); return false; };
    if (a.length < 1) return fail('Setup_MP_Empty');
    if (a !== b) return fail('Setup_MP_Mismatch');
    if (bitsNow < 50 && !$('#weak-ok').checked) return fail('Setup_MP_Weak');
    return true;
  }

  const wantSync = () => $$('input[name=storage]').find((r) => r.checked).value === 'sync';
  $$('input[name=storage]').forEach((r) => r.addEventListener('change', () => $('#sync-fields').classList.toggle('hidden', !wantSync())));

  async function create() {
    $('#create-err').classList.add('hidden');
    try {
      const args = { mp: $('#mp1').value, hint: $('#hint').value, iterations: Number($('#iter').value) };
      if (wantSync()) args.sync = { url: $('#sync-url').value.trim(), email: $('#sync-email').value.trim(), mode: $$('input[name=syncmode]').find((r) => r.checked).value };
      const res = await rpc('setup', args);
      if (res.syncError) toast(t('Setup_Sync_Failed', res.syncError), 'error');
      created = true;
      $('#mp1').value = ''; $('#mp2').value = '';
      const info = await rpc('extensionInfo');
      $('#ext-path').textContent = info.path ? t('Setup_Ext_Path', info.path) : t('Setup_Ext_PathMissing');
      return true;
    } catch (e) {
      $('#create-err').textContent = e.message; $('#create-err').classList.remove('hidden');
      return false;
    }
  }

  async function finish() {
    await rpc('openWindow', { name: 'editor' });
    await invoke('close_self');
  }

  $('#next').addEventListener('click', async () => {
    if (step === 2 && wantSync() && (!$('#sync-url').value.trim() || !$('#sync-email').value.trim())) { toast(t('Setup_Sync_Required'), 'error'); return; }
    if (step === 3 && !(await validateMp())) return;
    if (step === 4) { $('#next').disabled = true; const ok = await create(); $('#next').disabled = false; if (!ok) return; }
    if (step === 6) return finish();
    show(step + 1);
  });
  $('#skip').addEventListener('click', finish);
  $('#back').addEventListener('click', () => show(step - 1));

  $('#open-ext-folder').addEventListener('click', () => rpc('openExtensionFolder').catch(showError));
  $('#open-store').addEventListener('click', () => rpc('openBrowserPage', { browser: 'chrome', page: 'https://chromewebstore.google.com/detail/fkhigfffleejckieoikjboabidigggee' }).catch(showError));
  $('#open-chrome').addEventListener('click', () => rpc('openBrowserPage', { browser: 'chrome', page: 'chrome://extensions' }).catch(showError));
  $('#open-edge').addEventListener('click', () => rpc('openBrowserPage', { browser: 'edge', page: 'edge://extensions' }).catch(showError));

  $('#pick-import').addEventListener('click', async () => {
    const p = await pickOpen(t('Import_PickTitle'), t('Import_FileFilter'), ['csv', 'json']);
    if (!p) return;
    try {
      const pv = await rpc('importPreview', { path: p });
      importPath = p;
      $('#import-file').textContent = p;
      $('#import-info').textContent = pv.kind === 'csv' ? t('Import_CsvInfo', pv.rowCount) : t('Import_JsonInfo');
      $('#run-import').classList.remove('hidden'); $('#skipdup-row').classList.remove('hidden');
    } catch (e) { showError(e); }
  });
  $('#run-import').addEventListener('click', async () => {
    $('#run-import').disabled = true;
    try {
      const r = await rpc('importRun', { path: importPath, skipDuplicates: $('#skipdup').checked });
      const box = $('#import-result');
      box.textContent = t('Import_Done', r.added, r.duplicates.length, r.folder);
      box.classList.remove('hidden');
    } catch (e) { showError(e); }
    $('#run-import').disabled = false;
  });

  // 保管庫が作成済みなら（ウィザードの途中で閉じた場合）ログインへ
  const st = await rpc('status');
  if (st.exists) { await rpc('openWindow', { name: st.locked ? 'login' : 'editor' }); await invoke('close_self'); return; }
  show(1);
})();
