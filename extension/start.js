'use strict';
// ホーム: ログインをタイルで並べる。お気に入りと使用頻度の高いものを「よく使う」として先頭に出し、残りは「すべてのログイン」に並べる。
// クリックで開いて記入する（ポップアップから開く）。件数が多い保管庫でも欠けないよう、すべて読み足し、描画は少しずつ行う。
const FREQUENT_MAX = 24;
let renderSeq = 0;

const host = (u) => { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u).host; } catch (_) { return u; } };

// サイトのアイコン: 見えているタイルの分から順に、bg.js に取りに行かせる（取得とキャッシュは bg.js / icons.js）
const iconObserver = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    iconObserver.unobserve(en.target);
    loadIcon(en.target);
  }
}, { rootMargin: '200px' });

/** 背景色（#rrggbb）に合わせた文字色: 明るければ黒、暗ければ白。 */
function textOn(hex) {
  const v = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
  return lum > 0.6 ? '#1f2933' : '#ffffff';
}

function loadIcon(btn) {
  bg({ t: 'icon', url: btn.dataset.url }).then((r) => {
    if (!r || !r.dataUrl || !btn.isConnected) return;
    btn.querySelector('.ico').replaceChildren(el('img', { src: r.dataUrl, alt: '' }));
    if (r.bg) { btn.style.background = r.bg; btn.style.color = textOn(r.bg); btn.classList.add('hasbg'); }
  }).catch(() => { /* 取れなければ頭文字のまま */ });
}

function tile(e) {
  const h = host(e.url);
  const av = avatar(e.name || h, e.type, 'xl');
  av.classList.add('initial'); // 画像がないときの頭文字（画像が取れると、.ico の中身ごと画像に替わる）
  const btn = el('button', {
    class: 'tile', type: 'button', title: e.type === 1 ? [e.user, h].filter(Boolean).join('  ') : h,
    onclick: async () => {
      const url = /^https?:/i.test(e.url) ? e.url : 'https://' + e.url;
      if (e.type === 1) await bg({ t: 'goFill', id: e.id, url, submit: null }); else chrome.tabs.create({ url });
    },
  }, e.favorite ? el('span', { class: 'fav', icon: 'star', 'aria-label': t('Item_Favorite') }) : null,
  el('span', { class: 'ico' }, av),
  el('b', { text: e.name }));
  btn.dataset.url = e.url;
  iconObserver.observe(btn);
  return btn;
}

/** 見出しとタイルを、少しずつ（1 回 150 件）追加する。何千件でも、画面が固まらない。 */
async function renderChunked(grid, parts, my) {
  const CHUNK = 150;
  for (const part of parts) {
    if (my !== renderSeq) return;
    if (part.heading) grid.append(el('h2', { class: 'sec', text: part.heading }));
    for (let i = 0; i < part.rows.length; i += CHUNK) {
      if (my !== renderSeq) return;
      grid.append(...part.rows.slice(i, i + CHUNK).map(tile));
      if (i + CHUNK < part.rows.length) await new Promise((r) => setTimeout(r, 0));
    }
  }
}

async function load() {
  const grid = $('#grid'), msg = $('#msg'), count = $('#count');
  const my = ++renderSeq;
  iconObserver.disconnect();
  try {
    const st = await bg({ t: 'state' });
    if (!st.connected || st.locked) {
      msg.textContent = st.connected ? t('Ext_Locked') : st.starting ? t('Ext_Starting') : t('Ext_NotConnected');
      msg.classList.remove('hidden');
      grid.replaceChildren();
      count.textContent = '';
      return;
    }
    msg.classList.add('hidden');
    const q = $('#q').value;
    const rows = await searchAll(q, [1]); // 並びはアプリ側（お気に入り → 使用回数 → 最終使用日時 → 名前）
    if (my !== renderSeq) return;
    grid.replaceChildren();
    if (!rows.length) { grid.append(el('div', { class: 'sub', text: t('Ext_NoItems') })); count.textContent = ''; return; }
    let parts;
    if (q.trim()) {
      count.textContent = '';
      parts = [{ heading: t('Start_Results', rows.length), rows }];
    } else {
      const hot = rows.filter((r) => r.favorite || (r.useCount || 0) >= 1).slice(0, FREQUENT_MAX);
      const hotIds = new Set(hot.map((r) => r.id));
      const rest = rows.filter((r) => !hotIds.has(r.id));
      count.textContent = t('Start_Count', rows.length);
      parts = [];
      if (hot.length) parts.push({ heading: t('Ext_Popup_Frequent'), rows: hot });
      parts.push({ heading: hot.length ? t('Start_All', rest.length) : t('Start_All', rows.length), rows: rest });
    }
    await renderChunked(grid, parts, my);
  } catch (e) { msg.textContent = errText(e); msg.classList.remove('hidden'); }
}
applyI18n();

// アイコンの取得がオフ（既定）のときは、上部に控えめな案内を出す。閉じたことは覚える
const ICON_KEY = 'tkrform.home.icons', NOTE_KEY = 'tkrform.home.iconsNoteClosed';
async function updateIconNote() {
  const r = await chrome.storage.local.get([ICON_KEY, NOTE_KEY]).catch(() => ({}));
  $('#icon-note').classList.toggle('hidden', r[ICON_KEY] === true || r[NOTE_KEY] === true);
}
$('#icon-note-link').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
$('#icon-note-close').addEventListener('click', () => chrome.storage.local.set({ [NOTE_KEY]: true }).then(updateIconNote));
chrome.storage.onChanged.addListener(updateIconNote);
updateIconNote();

let qTimer = null;
$('#q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(load, 120); });
// 接続・ロック状態が変わったら表示し直す（開いた時点で未接続でも、つながれば一覧を出す）
let lastState = '';
chrome.runtime.onMessage.addListener((m) => {
  if (!m || m.t !== 'state' || !m.state) return;
  const key = `${m.state.connected}/${m.state.locked}/${m.state.starting}`;
  if (key !== lastState) { lastState = key; load(); }
});
load();
