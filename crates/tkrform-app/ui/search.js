'use strict';
// クイック検索（グローバルホットキー Ctrl+Alt+S）。Enter でログイン、他の種別はエディタで開く。

let results = [];
let sel = 0;
let seq = 0;

const TYPE_KEYS = { 1: 'Type_Login', 2: 'Type_Bookmark', 4: 'Type_AppLogin', 5: 'Type_Identity', 6: 'Type_Contact', 7: 'Type_Note' };

function render() {
  const ul = $('#list');
  ul.replaceChildren();
  results.forEach((e, i) => {
    ul.append(el('li', {
      role: 'option', 'aria-selected': i === sel ? 'true' : 'false',
      onclick: () => { sel = i; activate(); },
    },
      el('span', { class: 'type', text: t(TYPE_KEYS[e.type] || 'Type_Login') }),
      el('div', { class: 'grow' }, el('div', { class: 'name', text: e.name }), el('div', { class: 'meta', text: [e.user, e.url].filter(Boolean).join('  ') }))));
  });
  const cur = ul.children[sel];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

async function run() {
  const my = ++seq;
  try {
    const r = await rpc('search', { q: $('#q').value, limit: 30 });
    if (my !== seq) return;
    results = r; sel = 0; render();
  } catch (e) { if (e.code !== 'LOCKED') showError(e); }
}

async function activate() {
  const e = results[sel];
  if (!e) return;
  try {
    if (e.type === 1 || e.type === 2) await rpc('fillLogin', { id: e.id });
    else if (e.type === 4) { await invoke('close_self'); await rpc('fillApp', { id: e.id }); return; }
    else await rpc('openEditor', { id: e.id });
    await invoke('close_self');
  } catch (er) { showError(er); }
}

(async () => {
  await initI18n();
  await LockGuard.init(() => { run(); $('#q').focus(); });
  $('#q').focus();
  $('#q').addEventListener('input', run);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { invoke('close_self'); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); sel = Math.min(results.length - 1, sel + 1); render(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (ev.key === 'Enter' && document.activeElement === $('#q')) { ev.preventDefault(); activate(); }
  });
  run();
})();
