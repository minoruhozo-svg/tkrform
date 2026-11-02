'use strict';
// 設定。保存先は tkrform 本体の preferences.json（拡張から変えられるのは自動記入・自動保存・同等ドメインだけ）。

let prefs = null;
const inputs = {};

function addSelect(host, group, key, labelKey, opts) {
  const sel = el('select');
  opts.forEach(([v, k]) => sel.append(el('option', { value: v, text: t(k) })));
  sel.value = prefs[group][key];
  inputs[group + '.' + key] = sel;
  host.append(el('label', { class: 'field' }, el('span', { text: t(labelKey) }), sel));
}
function addCheck(host, group, key, labelKey) {
  const c = el('input', { type: 'checkbox', checked: !!prefs[group][key] });
  inputs[group + '.' + key] = c;
  host.append(el('label', { class: 'check' }, c, el('span', { text: t(labelKey) })));
}
function addNumber(host, group, key, labelKey) {
  const n = el('input', { type: 'number', min: 1, max: 20, value: prefs[group][key] });
  inputs[group + '.' + key] = n;
  host.append(el('label', { class: 'field' }, el('span', { text: t(labelKey) }), n));
}

/** ホームのアイコンの設定。拡張の中だけの設定で、アプリとの接続がなくても変えられる（すぐ保存する）。 */
async function initHome() {
  const key = 'tkrform.home.icons';
  const sw = $('#home-icons');
  sw.checked = (await chrome.storage.local.get(key))[key] === true; // 既定・未設定はオフ
  sw.addEventListener('change', () => chrome.storage.local.set({ [key]: sw.checked }));
  $('#icons-clear').addEventListener('click', async () => {
    await bg({ t: 'iconClear' });
    $('#icons-msg').textContent = t('Ext_Opt_HomeIconsCleared');
  });
}

async function init() {
  applyI18n();
  await initHome();
  const st = await bg({ t: 'state' }).catch(() => ({ connected: false }));
  const conn = $('#conn');
  if (!st.connected) { conn.className = 'msg warn'; conn.textContent = t('Ext_NotConnected'); return; }
  if (st.locked) { conn.className = 'msg warn'; conn.textContent = t('Ext_Opt_NeedUnlock'); return; }
  conn.className = 'msg ok';
  conn.textContent = t('Ext_Opt_Connected', st.version);
  prefs = await rpc('getPrefs');
  const fa = $('#f-autofill'), fs = $('#f-autosave');
  addSelect(fa, 'autofill', 'mode', 'Pref_autofill_mode', [['off', 'Pref_opt_fill_off'], ['suggest', 'Pref_opt_fill_suggest'], ['auto', 'Pref_opt_fill_auto']]);
  addSelect(fa, 'autofill', 'target', 'Pref_autofill_target', [['both', 'Pref_opt_target_both'], ['logins', 'Pref_opt_target_logins'], ['identities', 'Pref_opt_target_identities']]);
  addCheck(fa, 'autofill', 'onlyOnPasswordPages', 'Pref_autofill_onlyOnPasswordPages');
  addNumber(fa, 'autofill', 'minIdentityFields', 'Pref_autofill_minIdentityFields');
  addCheck(fa, 'autofill', 'includeContacts', 'Pref_autofill_includeContacts');
  addCheck(fa, 'autofill', 'basicAuth', 'Pref_autofill_basicAuth');
  addCheck(fa, 'autofill', 'inlineMenu', 'Pref_autofill_inlineMenu');
  addSelect(fs, 'autosave', 'mode', 'Pref_autosave_mode', [['off', 'Pref_opt_save_off'], ['suggest', 'Pref_opt_save_suggest'], ['auto', 'Pref_opt_save_auto']]);
  addCheck(fs, 'autosave', 'forceDialog', 'Pref_autosave_forceDialog');
  const ex = el('textarea', { rows: 4, value: (prefs.autosave.excludeUrls || []).join('\n') });
  inputs['autosave.excludeUrls'] = ex;
  fs.append(el('label', { class: 'field' }, el('span', { text: t('Pref_autosave_excludeUrls') }), ex));
  $('#equiv').value = (prefs.equivDomains || []).map((g) => g.join(', ')).join('\n');

  $('#save').addEventListener('click', async () => {
    const next = {
      autofill: { ...prefs.autofill }, autosave: { ...prefs.autosave },
      equivDomains: $('#equiv').value.split('\n').map((l) => l.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)).filter((g) => g.length >= 2),
    };
    for (const [k, i] of Object.entries(inputs)) {
      const [g, key] = k.split('.');
      if (key === 'excludeUrls') next[g][key] = i.value.split('\n').map((s) => s.trim()).filter(Boolean);
      else if (i.type === 'checkbox') next[g][key] = i.checked;
      else if (i.type === 'number') next[g][key] = Number(i.value);
      else next[g][key] = i.value;
    }
    try {
      await rpc('setPrefs', next);
      await bg({ t: 'prefsChanged' });
      $('#saved').textContent = t('Pref_Saved');
    } catch (e) { $('#saved').textContent = errText(e); }
  });
}
init();
