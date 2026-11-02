'use strict';
// パスワード生成器ウィンドウ（§10.3 / §11）

const DEFAULTS = {
  mode: 'random', length: 16, upper: true, lower: true, digits: true, symbols: true, symbolChars: '!@#$%^&*',
  hexOnly: false, excludeSimilar: false, requireEach: true, words: 4, separator: '-', capitalize: true, addNumber: true,
};
const BOOLS = ['upper', 'lower', 'digits', 'symbols', 'hexOnly', 'excludeSimilar', 'requireEach', 'capitalize', 'addNumber'];

let opts = { ...DEFAULTS };
let meter, current = '';

function load() {
  try { opts = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('tkrform.gen') || '{}') }; } catch (_) { opts = { ...DEFAULTS }; }
}
function save() { try { localStorage.setItem('tkrform.gen', JSON.stringify(opts)); } catch (_) { /* 保存できなくても動く */ } }

function toForm() {
  for (const k of BOOLS) $('#' + k).checked = !!opts[k];
  $('#length').value = opts.length;
  $('#length-r').value = Math.min(128, opts.length);
  $('#symbolChars').value = opts.symbolChars;
  $('#words').value = opts.words;
  $('#separator').value = opts.separator;
  $$('input[name=mode]').forEach((r) => { r.checked = r.value === opts.mode; });
  syncDisabled();
}

function fromForm() {
  for (const k of BOOLS) opts[k] = $('#' + k).checked;
  opts.length = Math.max(4, Math.min(512, Number($('#length').value) || 16));
  opts.symbolChars = $('#symbolChars').value;
  opts.words = Math.max(3, Math.min(12, Number($('#words').value) || 4));
  opts.separator = ($('#separator').value || '-').slice(0, 1);
  opts.mode = $$('input[name=mode]').find((r) => r.checked).value;
}

// 16 進のみがオンのときは他の文字種を無効にする
function syncDisabled() {
  const hex = $('#hexOnly').checked;
  for (const k of ['upper', 'lower', 'digits', 'symbols', 'symbolChars']) $('#' + k).disabled = hex;
  $('#opt-random').classList.toggle('hidden', opts.mode !== 'random');
  $('#opt-phrase').classList.toggle('hidden', opts.mode !== 'passphrase');
}

async function generate(record) {
  fromForm(); save(); syncDisabled();
  try {
    const g = await rpc('generate', { options: opts, record: !!record });
    current = g.password;
    $('#out').value = g.password;
    meter.className = 'meter ' + (g.class === 'weak' ? '' : g.class);
    meter.firstElementChild.style.width = Math.min(100, (g.bits / 128) * 100) + '%';
    $('#bits').textContent = t('Strength_Bits', Math.round(g.bits));
    if (record) refreshHistory();
  } catch (e) {
    $('#out').value = '';
    $('#bits').textContent = e.message;
    meter.className = 'meter'; meter.firstElementChild.style.width = '0';
  }
}

async function refreshHistory() {
  const list = $('#hist');
  list.replaceChildren();
  const st = await rpc('status');
  $('#hist-locked').classList.toggle('hidden', !st.locked);
  if (st.locked) return;
  try {
    const items = await rpc('genHistory');
    const show = $('#hist-show').checked;
    for (const h of items) {
      list.append(el('li', null,
        el('span', { class: 'pw selectable', text: show ? h.password : '•'.repeat(Math.min(24, h.password.length)) }),
        el('span', { class: 'sub', text: fmtDate(h.at) }),
        el('button', { type: 'button', class: 'icon', text: t('PassGen_Copy'), onclick: () => copySecret(h.password) })));
    }
    if (!items.length) list.append(el('li', { class: 'sub', text: t('PassGen_HistoryEmpty') }));
  } catch (e) { showError(e); }
}

(async () => {
  await initI18n();
  meter = meterEl();
  $('#meter-host').append(meter);
  load(); toForm();

  $('#length-r').addEventListener('input', () => { $('#length').value = $('#length-r').value; generate(false); });
  $('#length').addEventListener('input', () => { $('#length-r').value = Math.min(128, $('#length').value); generate(false); });
  for (const id of [...BOOLS, 'symbolChars', 'words', 'separator']) $('#' + id).addEventListener('input', () => generate(false));
  $$('input[name=mode]').forEach((r) => r.addEventListener('change', () => { fromForm(); syncDisabled(); generate(false); }));

  $('#gen').addEventListener('click', () => generate(true));
  $('#copy').addEventListener('click', () => current && copySecret(current));
  $('#type').addEventListener('click', async () => {
    if (!current) return;
    try { await invoke('type_to_last', { text: current }); } catch (e) { showError(e); }
  });
  $('#ontop').addEventListener('change', () => invoke('set_on_top', { on: $('#ontop').checked }));
  $('#reset').addEventListener('click', () => { opts = { ...DEFAULTS }; toForm(); generate(false); });
  $('#hist-show').addEventListener('change', refreshHistory);
  $('#hist-box').addEventListener('toggle', refreshHistory);
  $('#hist-unlock').addEventListener('click', () => rpc('openWindow', { name: 'login' }));
  $('#hist-clear').addEventListener('click', async () => {
    if (!(await dialog.confirm(t('PassGen_HistoryClearConfirm'), { danger: true, okLabel: t('PassGen_HistoryClear') }))) return;
    try { await rpc('clearGenHistory'); refreshHistory(); } catch (e) { showError(e); }
  });
  await TAURI.event.listen('vault-state', refreshHistory);

  generate(false);
})();
