'use strict';
// ホームのタイル用: サイトのアイコン画像を、各サイトから直接取得し、縮小してキャッシュする（第三者のサービスは使わない）。
// 取得は bg.js（service worker）で行う。Cookie は送らない（credentials: 'omit'）、Referer も送らない。

const SETTING_KEY = 'tkrform.home.icons'; // true のときだけ通信する（既定・未設定はオフ）
const CACHE_PREFIX = 'icon:';
const OK_TTL = 30 * 86400e3;   // 取れた画像は 30 日たったら取り直す
const FAIL_TTL = 7 * 86400e3;  // 取れなかったことも覚えて、7 日は取り直さない
const FETCH_TIMEOUT = 8000;
const MAX_IMAGE = 1024 * 1024;
const MAX_HTML = 2 * 1024 * 1024; // <head> まで読めればよいので、</head> が見つかったところで読むのをやめる
const MAX_MANIFEST = 256 * 1024;
const MAX_PARALLEL = 4;        // 同時に取りに行くのは 4 サイトまで
const TARGET = 128;            // 長辺をこの大きさに縮める
const MAX_SVG_STORE = 256 * 1024;

export async function iconsEnabled() {
  try { return (await chrome.storage.local.get(SETTING_KEY))[SETTING_KEY] === true; } catch (_) { return false; }
}

const mem = new Map();      // origin -> entry
const inflight = new Map(); // origin -> Promise
const queue = [];
let running = 0;

function schedule(task) {
  return new Promise((resolve) => { queue.push({ task, resolve }); pump(); });
}
function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const { task, resolve } = queue.shift();
    running++;
    task().then(resolve, () => resolve(null)).finally(() => { running--; pump(); });
  }
}

function originOf(url) {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : 'https://' + url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch (_) { return null; }
}

async function readEntry(origin) {
  if (mem.has(origin)) return mem.get(origin);
  try {
    const e = (await chrome.storage.local.get(CACHE_PREFIX + origin))[CACHE_PREFIX + origin] || null;
    if (e) mem.set(origin, e);
    return e;
  } catch (_) { return null; }
}
async function writeEntry(origin, e) {
  mem.set(origin, e);
  try { await chrome.storage.local.set({ [CACHE_PREFIX + origin]: e }); } catch (_) { /* 保存できなくても表示はできる */ }
}
const fresh = (e) => Date.now() - (e.at || 0) < (e.fail ? FAIL_TTL : OK_TTL);
const toResult = (e) => (e && !e.fail && e.dataUrl ? { dataUrl: e.dataUrl, bg: e.bg || null } : { none: true });
const SMALL = 32; // 長辺がこれより小さい画像は、拡大するとぼやけるので、Chrome の favicon キャッシュ（size=64）を先に試す

/** url のサイトのアイコンを返す: { dataUrl, bg } か { none: true }。キャッシュがあればそれを使い、通信しない。 */
export async function iconFor(url) {
  const origin = originOf(String(url || ''));
  if (!origin) return { none: true };
  const cached = await readEntry(origin);
  if (cached && fresh(cached)) return toResult(cached);
  if (await iconsEnabled()) {
    if (!inflight.has(origin)) inflight.set(origin, schedule(() => fetchAndStore(origin, cached)).finally(() => inflight.delete(origin)));
    return toResult(await inflight.get(origin));
  }
  // 通信しない設定: 古いキャッシュ、なければ Chrome が持っているアイコン（端末内）だけを使う
  if (cached && !cached.fail) return toResult(cached);
  const f = await chromeFavicon(origin + '/').catch(() => null);
  return f ? toResult(f) : { none: true };
}

export async function clearIcons() {
  mem.clear();
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}

async function fetchAndStore(origin, old) {
  let img = null;
  const trace = []; // 取得の経過（どの段階で失敗したかを調べるため。画像は含まない）
  try { img = await findIcon(origin, trace); } catch (_) { img = null; }
  const why = trace.join(' | ').slice(0, 600);
  let e;
  if (img) e = { at: Date.now(), dataUrl: img.dataUrl, bg: img.bg || null, w: img.w || 0, h: img.h || 0, why };
  else if (old && !old.fail) e = { ...old, at: Date.now() }; // 取り直しに失敗しても、前の画像は残す
  else e = { at: Date.now(), fail: true, why };
  await writeEntry(origin, e);
  return e;
}

// ------------------------------------------------------------------ 取得

/** 条件つきの取得: http(s) だけ、Cookie なし、Referer なし、8 秒、最大 max バイト。 */
async function fetchLimited(url, max, untilHead = false) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(url, {
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', cache: 'no-cache', signal: ctl.signal,
      headers: { Accept: 'text/html,application/xhtml+xml,image/avif,image/webp,image/*;q=0.8,*/*;q=0.5', 'Accept-Language': navigator.language || 'ja' },
    });
    if (!r.ok) throw new Error('status ' + r.status);
    if (!/^https?:$/.test(new URL(r.url).protocol)) throw new Error('scheme');
    const len = Number(r.headers.get('content-length') || 0);
    if (len > max) throw new Error('too large');
    const chunks = [];
    let total = 0;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let tail = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) { ctl.abort(); throw new Error('too large'); }
      chunks.push(value);
      if (untilHead) {
        const text = tail + dec.decode(value, { stream: true });
        if (/<\/head\s*>/i.test(text)) { await reader.cancel().catch(() => {}); break; }
        tail = text.slice(-16);
      }
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }
    return { bytes, type: (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), url: r.url };
  } finally { clearTimeout(timer); }
}

const sizeOf = (s) => {
  if (!s) return 0;
  if (/any/i.test(s)) return 256;
  let m = 0;
  for (const x of String(s).matchAll(/(\d+)\s*x\s*(\d+)/gi)) m = Math.max(m, Number(x[1]), Number(x[2]));
  return m;
};

function parseAttrs(tag) {
  const a = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) a[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return a;
}

/** HTML の <link> から、アイコンの候補（と manifest の URL）を集める。 */
function parseHtml(html, base) {
  const icons = [];
  const manifests = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    if (!a.href) continue;
    const rel = String(a.rel || '').toLowerCase().split(/\s+/);
    let abs;
    try { abs = new URL(a.href, base).href; } catch (_) { continue; }
    if (!/^https?:/i.test(abs)) continue;
    if (rel.includes('manifest')) manifests.push(abs);
    else if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) icons.push({ url: abs, size: sizeOf(a.sizes) || 180 });
    else if (rel.includes('icon')) icons.push({ url: abs, size: sizeOf(a.sizes) || (/svg/i.test(a.type || '') || /\.svg(\?|$)/i.test(abs) ? 256 : 0) });
  }
  return { icons, manifests };
}

async function findIcon(origin, trace) {
  const cands = [];
  try {
    const page = await fetchLimited(origin + '/', MAX_HTML, true);
    const { icons, manifests } = parseHtml(new TextDecoder().decode(page.bytes), page.url);
    trace.push(`page ok(icons ${icons.length}, manifest ${manifests.length})`);
    cands.push(...icons);
    for (const mu of manifests.slice(0, 1)) {
      try {
        const mf = JSON.parse(new TextDecoder().decode((await fetchLimited(mu, MAX_MANIFEST)).bytes));
        for (const ic of Array.isArray(mf.icons) ? mf.icons : []) {
          if (!ic || typeof ic.src !== 'string') continue;
          try {
            const abs = new URL(ic.src, mu).href;
            if (/^https?:/i.test(abs)) cands.push({ url: abs, size: sizeOf(ic.sizes) });
          } catch (_) { /* 無視 */ }
        }
        trace.push(`manifest ok(${cands.length} 候補)`);
      } catch (e) { trace.push('manifest ' + errName(e)); /* manifest が読めなくても続ける */ }
    }
  } catch (e) { trace.push('page ' + errName(e)); /* トップページが読めなくても、決まった場所を試す */ }
  cands.sort((x, y) => y.size - x.size); // いちばん大きい画像から（64px 以上が先になる）
  const urls = [];
  for (const c of cands) if (!urls.includes(c.url)) urls.push(c.url);
  for (const fixed of [origin + '/apple-touch-icon.png', origin + '/favicon.ico']) if (!urls.includes(fixed)) urls.push(fixed);
  let small = null; // 小さすぎる画像は、ほかに見つからなかったときのために取っておく
  for (const u of urls.slice(0, 6)) {
    const name = u.replace(origin, '');
    try {
      const r = await tryImage(u);
      if (!r) { trace.push(`image ${name} 画像ではない`); continue; }
      if (Math.max(r.w || 0, r.h || 0) >= SMALL || !r.w) { trace.push(`image ${name} ok ${r.w || 'svg'}x${r.h || ''}`); return r; }
      trace.push(`image ${name} 小さい ${r.w}x${r.h}`);
      small = small || r;
    } catch (e) { trace.push(`image ${name} ${errName(e)}`); /* 次の候補へ */ }
  }
  // 最後に、Chrome が持っているアイコン（通信しない。size=64 なので、小さい画像を引き伸ばすより見やすい）
  const f = await chromeFavicon(origin + '/').catch((e) => { trace.push('chrome ' + errName(e)); return null; });
  if (f) { trace.push('chrome favicon ok'); return f; }
  if (small) { trace.push('小さい画像を使う'); return small; }
  trace.push('画像なし');
  return null;
}

const errName = (e) => String((e && (e.name === 'AbortError' ? 'timeout' : e.message)) || e).slice(0, 60);

async function tryImage(url) {
  const r = await fetchLimited(url, MAX_IMAGE);
  if (!r.type.startsWith('image/')) return null;
  if (r.type === 'image/svg+xml') {
    if (r.bytes.length > MAX_SVG_STORE) return null;
    return { dataUrl: 'data:image/svg+xml;base64,' + b64(r.bytes), bg: null, w: 0, h: 0 }; // <img> で表示するだけ（スクリプトは動かない）
  }
  return rasterize(new Blob([r.bytes], { type: r.type }));
}

let defaultFavicon = null;
async function chromeFavicon(pageUrl) {
  const get = async (p) => {
    const r = await fetch(chrome.runtime.getURL('_favicon/') + '?pageUrl=' + encodeURIComponent(p) + '&size=64');
    if (!r.ok) return null;
    return rasterize(await r.blob());
  };
  const img = await get(pageUrl);
  if (!img) return null;
  if (defaultFavicon === null) defaultFavicon = (await get('https://tkrform-default-icon.invalid/').catch(() => null))?.dataUrl || '';
  return img.dataUrl === defaultFavicon ? null : img; // 持っていないときの既定の画像は、画像なし扱い
}

// ------------------------------------------------------------------ 縮小と背景色

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 長辺を TARGET に縮めた PNG にする。外周の色が不透明でほぼ一色なら、タイルの背景色（#rrggbb）として返す。 */
async function rasterize(blob) {
  const bmp = await createImageBitmap(blob);
  try {
    const k = Math.min(1, TARGET / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    const bg = edgeColor(ctx.getImageData(0, 0, w, h).data, w, h);
    const out = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer());
    return { dataUrl: 'data:image/png;base64,' + b64(out), bg, w, h };
  } finally { bmp.close(); }
}

function edgeColor(d, w, h) {
  const px = [];
  for (let x = 0; x < w; x++) { px.push((x) * 4); px.push(((h - 1) * w + x) * 4); }
  for (let y = 1; y < h - 1; y++) { px.push((y * w) * 4); px.push((y * w + w - 1) * 4); }
  let opaque = 0, r = 0, g = 0, b = 0;
  for (const i of px) if (d[i + 3] >= 250) { opaque++; r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  if (!opaque || opaque / px.length < 0.95) return null;
  r /= opaque; g /= opaque; b /= opaque;
  let near = 0;
  for (const i of px) if (d[i + 3] >= 250 && Math.abs(d[i] - r) <= 24 && Math.abs(d[i + 1] - g) <= 24 && Math.abs(d[i + 2] - b) <= 24) near++;
  if (near / px.length < 0.92) return null;
  const hex = (v) => Math.round(v).toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b);
}
