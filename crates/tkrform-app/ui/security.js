'use strict';
// セキュリティセンター（§13）: 弱い・使い回し・古い・重複と、任意の漏洩チェック（既定オフ・同意制）を、タブで切り替えて表示する。

const NS = 'http://www.w3.org/2000/svg';
const TABS = ['weak', 'reused', 'old', 'dups', 'breach'];
const TAB_KEY = { weak: 'Sec_Tab_Weak', reused: 'Sec_Tab_Reused', old: 'Sec_Tab_Old', dups: 'Sec_Tab_Dups', breach: 'Sec_Tab_Breach' };

let report = null;      // 直近の検査結果
let current = null;     // 選んでいるタブ（最初は、件数が 1 以上の最初のタブ。以降は、再検査やロック解除のあとも保つ）
let breachOn = false;   // 漏洩チェックが有効か
let breachFound = null; // 漏洩を確認した件数（まだ確認していなければ null）

function drawRing(score) {
  const ring = $('#ring');
  ring.replaceChildren();
  const color = score >= 80 ? 'var(--mint)' : score >= 50 ? 'var(--amber)' : 'var(--coral)';
  const c = 2 * Math.PI * 40;
  const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  ring.append(mk('circle', { cx: 50, cy: 50, r: 40, fill: 'none', stroke: 'var(--line)', 'stroke-width': 9 }),
    mk('circle', { cx: 50, cy: 50, r: 40, fill: 'none', stroke: color, 'stroke-width': 9, 'stroke-linecap': 'round', 'stroke-dasharray': c, 'stroke-dashoffset': c * (1 - score / 100), transform: 'rotate(-90 50 50)' }));
  const tx = mk('text', { x: 50, y: 59, 'text-anchor': 'middle' });
  tx.textContent = String(score);
  ring.append(tx);
  ring.setAttribute('aria-label', t('Sec_Score') + ' ' + score);
}

/** 行: 項目の頭文字、名前、ID とサイト、理由の chip、「サイトを開く」、色つきの「パスワードを変える」（保管庫の画面で、その項目を編集の状態で開く）。 */
function rowEl(r, extra, reasons) {
  return el('li', null, avatar(r.name, 1, 'sm'),
    el('span', { class: 'grow' },
      el('div', null, el('b', { text: r.name }), ' ', el('span', { class: 'sub', text: [r.user, r.url].filter(Boolean).join('  ') })),
      reasons && reasons.length ? el('div', { class: 'reasons' }, ...reasons.map((x) => el('span', { class: 'pill warn', text: x }))) : null),
    extra ? el('span', { class: 'sub', text: extra }) : null,
    r.url ? el('button', { type: 'button', class: 'sm', icon: 'open', onclick: () => rpc('openUrl', { url: /^https?:/i.test(r.url) ? r.url : 'https://' + r.url }).catch(showError) }, t('Sec_OpenSite')) : null,
    el('button', { type: 'button', class: 'primary sm', onclick: () => { location.href = 'editor.html?id=' + encodeURIComponent(r.id) + '&edit=1'; } }, t('Sec_ChangePw')));
}

/** 変更から何年たったか（1 年未満は 0）。 */
function yearsSince(ymd) {
  const d = new Date(ymd);
  if (isNaN(d)) return 0;
  return Math.floor((Date.now() - d.getTime()) / (365 * 864e5));
}

/** あと何件のパスワードを変えれば、スコアが 100 になるか。弱い・古いログインは、すべて変える。使い回しは、各グループで 1 件だけ残して、あとを変える。 */
function fixesTo100(r) {
  const fix = new Set([...r.weak, ...r.old].map((x) => x.id));
  for (const g of r.reused) {
    const rest = g.filter((x) => !fix.has(x.id));
    for (const x of rest.slice(1)) fix.add(x.id);
  }
  return fix.size;
}

/** タブごとの件数（使い回し・重複は、該当するログインの数）。漏洩は、オフなら null、未確認なら -1。 */
function counts() {
  const flat = (gs) => gs.reduce((n, g) => n + g.length, 0);
  return { weak: report ? report.weak.length : 0, reused: report ? flat(report.reused) : 0, old: report ? report.old.length : 0, dups: report ? flat(report.duplicates) : 0,
    breach: !breachOn ? null : breachFound === null ? -1 : breachFound };
}

function renderTabs() {
  const c = counts();
  for (const id of TABS) {
    const b = $('#tab-' + id);
    const n = c[id];
    const label = n === null ? t('Sec_Tab_Off') : n < 0 ? '–' : String(n);
    // 件数の箱。かっこは、画面には出さない（読み上げ・検査用の文字としては残す）
    b.replaceChildren(el('span', { class: 'lbl', text: t(TAB_KEY[id]) }),
      el('span', { class: 'cnt' + (n === null ? ' off' : n === 0 ? ' ok' : '') }, el('span', { class: 'par', text: '(' }), el('b', { text: label }), el('span', { class: 'par', text: ')' })));
    const sel = id === current;
    b.setAttribute('aria-selected', String(sel));
    b.tabIndex = sel ? 0 : -1;
    $('#panel-' + id).classList.toggle('hidden', !sel);
  }
}

function selectTab(id, focus) {
  current = id;
  renderTabs();
  if (focus) $('#tab-' + id).focus();
}

function buildTabs() {
  const host = $('#tabs');
  for (const id of TABS) host.append(el('button', { type: 'button', role: 'tab', id: 'tab-' + id, 'aria-controls': 'panel-' + id, onclick: () => selectTab(id, false) }));
  host.addEventListener('keydown', (ev) => {
    const i = TABS.indexOf(current);
    const to = ev.key === 'ArrowRight' ? (i + 1) % TABS.length : ev.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : ev.key === 'Home' ? 0 : ev.key === 'End' ? TABS.length - 1 : -1;
    if (to < 0) return;
    ev.preventDefault();
    selectTab(TABS[to], true);
  });
  $$('[data-desc]').forEach((n) => { n.textContent = t(n.dataset.desc); });
}

/** パネルの中身。0 件なら「問題は見つかりませんでした」。 */
function fillPanel(id, rows, grouped, extraOf, groupKey, reasonsOf) {
  const body = $('#panel-' + id + ' .body');
  if (!rows.length) { body.replaceChildren(el('div', { class: 'msg ok', text: t('Sec_NoIssues') })); return; }
  const list = el('ul', { class: 'rows' });
  if (grouped) rows.forEach((g) => list.append(el('li', { class: 'grp-wrap' }, el('div', { class: 'grp' }, el('div', { class: 'grp-title', text: t(groupKey, g.length) }), el('ul', { class: 'rows' }, ...g.map((r) => rowEl(r, null, reasonsOf ? reasonsOf(r, g) : null)))))));
  else rows.forEach((r) => list.append(rowEl(r, extraOf ? extraOf(r) : null, reasonsOf ? reasonsOf(r) : null)));
  body.replaceChildren(list);
}

async function scan() {
  try {
    const r = await rpc('securityReport');
    report = r;
    drawRing(r.score);
    $('#score-body').textContent = t('Sec_ScoreBody', r.total);
    $('#corrupt').classList.toggle('hidden', !r.corrupt);
    $('#corrupt').textContent = t('Sec_Corrupt', r.corrupt);
    const n = fixesTo100(r);
    $('#score-hint').textContent = r.score < 100 && n > 0 ? t('Sec_FixHint', n) : '';
    fillPanel('weak', r.weak, false, null, null, (x) => [t('Sec_Reason_Weak', x.bits)]);
    fillPanel('reused', r.reused, true, null, 'Sec_GroupReused', (x, g) => {
      const others = g.filter((y) => y.id !== x.id);
      return [others.length > 1 ? t('Sec_Reason_SameMany', others[0].name, others.length - 1) : t('Sec_Reason_Same', others[0].name)];
    });
    fillPanel('old', r.old, false, (x) => (x.changed ? t('Sec_Changed', x.changed) : null), null, (x) => { const y = yearsSince(x.changed); return y >= 1 ? [t('Sec_Reason_Old', y)] : []; });
    fillPanel('dups', r.duplicates, true, null, 'Sec_GroupDup', (x, g) => [t('Sec_Reason_Dup', g.length - 1)]);
    if (current === null) {
      const c = counts();
      current = TABS.find((id) => c[id] > 0) || 'weak'; // 最初に開くタブ: 件数が 1 以上の最初のタブ。すべて 0 件なら「弱い」
    }
    renderTabs();
  } catch (e) { if (e.code !== 'LOCKED') showError(e); }
}

async function breachUi() {
  const p = await rpc('getPrefs');
  breachOn = !!p.security.breachCheck;
  if (!breachOn) { breachFound = null; $('#breach-result').replaceChildren(); }
  $('#breach-state').textContent = breachOn ? t('Sec_Desc_Breach') : t('Sec_BreachOff');
  const acts = $('#breach-actions');
  acts.replaceChildren();
  renderTabs();
  if (!breachOn) {
    acts.append(el('button', { type: 'button', id: 'breach-enable', class: 'primary', text: t('Sec_BreachEnable'), onclick: async () => {
      // 同意画面。同意しない限りオンにならず、何も送られない
      const ok = await dialog.confirm(t('Sec_BreachConsentBody'), { title: t('Sec_BreachConsentTitle'), okLabel: t('Sec_BreachConsentOk') });
      if (!ok) return;
      try { await rpc('breachConsent', { agree: true }); await breachUi(); } catch (e) { showError(e); }
    } }));
    return;
  }
  acts.append(
    el('button', { type: 'button', id: 'breach-run', class: 'primary', text: t('Sec_BreachRun'), onclick: async (ev) => {
      ev.target.disabled = true;
      try {
        const r = await rpc('breachCheck');
        const res = $('#breach-result');
        breachFound = r.breached.length;
        renderTabs();
        res.replaceChildren(el('div', { class: 'sub', text: t('Sec_BreachDone', r.checked) }),
          r.breached.length
            ? el('div', null, el('h2', null, el('span', { text: t('Sec_BreachFound', r.breached.length) })), el('ul', { class: 'rows' }, ...r.breached.map((b) => rowEl({ id: b.id, name: b.name, user: '', url: '' }, t('Sec_BreachCount', b.count)))))
            : el('div', { class: 'msg ok', text: t('Sec_BreachClean') }));
      } catch (e) { showError(e); }
      ev.target.disabled = false;
    } }),
    el('button', { type: 'button', class: 'flat', text: t('Sec_BreachDisable'), onclick: async () => { await rpc('breachConsent', { agree: false }); await breachUi(); } }));
}

(async () => {
  await initI18n();
  mountRail('security');
  buildTabs();
  await LockGuard.init(() => { scan(); });
  $('#rescan').addEventListener('click', scan);
  await TAURI.event.listen('vault-changed', scan);
  await scan();
  await breachUi();
})();
