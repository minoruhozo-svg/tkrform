// tkrform service worker: Native Messaging の維持、タブ状態、コンテキストメニュー、ショートカット、ベーシック認証。
// 保管庫の本体は TKRForm.exe にあり、ここは薄いクライアント。復号済みデータは必要な分だけ都度受け取る。

import { iconFor, clearIcons } from './icons.js';

const HOST = 'jp.tkrs.tkrform';
const EXT_BASE = chrome.runtime.getURL('');
const msg = (key, ...subs) => chrome.i18n.getMessage(key, subs) || key;

const state = { connected: false, locked: true, exists: true, version: '', error: '', helloAvailable: false, starting: false };
let port = null;
let nextId = 1;
let lastConnectTry = 0;
let lastKick = 0;
let startingTimer = null;
const pending = new Map();
let prefsCache = null;
let helloWaiters = [];
const pendingFills = []; // { id, url, host, submit, expires }
const pendingSaves = new Map(); // token -> { data, tabId, check }

// ------------------------------------------------------------------ Native Messaging

/** 接続役（NM ホスト）は生きているが、アプリにつながっていない（アプリが終了した）とき、hello を送る。
 *  接続役は、要求を受けると、アプリを起動してつなぎ直す（`connected` → hello の応答で、接続済みに戻る）。起動を待つ間は、state.starting を立てる。 */
function kickApp() {
  const now = Date.now();
  if (!port || state.connected || now - lastKick < 1500) return;
  lastKick = now;
  try {
    port.postMessage({ id: 0, cmd: 'hello', args: { extVersion: chrome.runtime.getManifest().version } });
  } catch (_) { return; }
  state.starting = true;
  clearTimeout(startingTimer);
  startingTimer = setTimeout(() => { if (state.starting) { state.starting = false; broadcastState(); } }, 12000);
  broadcastState();
}

function connect() {
  if (port) {
    if (!state.connected) kickApp();
    return;
  }
  const now = Date.now();
  if (now - lastConnectTry < 1500) return;
  lastConnectTry = now;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    port = null;
    setConnected(false, String(e));
    return;
  }
  port.onMessage.addListener(onNative);
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    port = null;
    helloWaiters.splice(0).forEach((f) => f());
    for (const [, p] of pending) { clearTimeout(p.to); p.rej({ code: 'NOT_CONNECTED', message: msg('Ext_NotConnected') }); }
    pending.clear();
    setConnected(false, err ? err.message : '');
  });
  port.postMessage({ id: 0, cmd: 'hello', args: { extVersion: chrome.runtime.getManifest().version } });
}

function call(cmd, args, timeoutMs = 15000) {
  connect();
  if (!port) return Promise.reject({ code: 'NOT_CONNECTED', message: msg('Ext_NotConnected') });
  const id = nextId++;
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej({ code: 'TIMEOUT', message: msg('Ext_Timeout') }); }, timeoutMs);
    pending.set(id, { res, rej, to });
    try { port.postMessage({ id, cmd, args: args || {} }); } catch (e) { clearTimeout(to); pending.delete(id); rej({ code: 'NOT_CONNECTED', message: String(e) }); }
  });
}

function onNative(m) {
  if (m.id === 0 && m.success && m.data) {
    // hello の応答
    state.version = m.data.appVersion;
    helloWaiters.splice(0).forEach((f) => f());
    state.exists = m.data.exists !== false;
    state.helloAvailable = !!m.data.helloAvailable;
    setConnected(true, '');
    setLocked(!!m.data.locked);
    return;
  }
  if (m.id !== undefined && m.id !== null) {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.to);
    if (m.success) p.res(m.data); else p.rej({ code: m.code || 'INTERNAL', message: m.message || '' });
    return;
  }
  switch (m.event) {
    case 'lockState': setLocked(!!m.data.locked); break;
    case 'fillRequest': onFillRequest(m.data); break;
    case 'connected': setConnected(true, ''); port && port.postMessage({ id: 0, cmd: 'hello', args: {} }); break;
    case 'disconnected': setConnected(false, ''); setLocked(true); break;
    default: break;
  }
}

function setConnected(c, err) {
  state.connected = c;
  state.error = err || '';
  if (c) { state.starting = false; clearTimeout(startingTimer); }
  if (!c) { prefsCache = null; updateIcon(); broadcastState(); }
}

function setLocked(l) {
  const was = state.locked;
  state.locked = l;
  if (was !== l) prefsCache = null;
  if (l && !was) {
    // ロックされたときに、Windows Hello で解除できるか（設定が変わっていないか）を取り直す
    call('hello', { extVersion: chrome.runtime.getManifest().version }).then((r) => { state.helloAvailable = !!r.helloAvailable; broadcastState(); }).catch(() => {});
  }
  updateIcon();
  broadcastState();
  if (!l) refreshBadges();
  else clearBadges();
}

/** hello の応答（または失敗・タイムアウト）まで待つ。サービスワーカーの再起動直後に古い状態を返さないため。 */
function ready(ms = 4000) {
  if (state.connected) return Promise.resolve();
  return new Promise((resolve) => {
    const to = setTimeout(resolve, ms);
    helloWaiters.push(() => { clearTimeout(to); resolve(); });
  });
}

function broadcastState() {
  chrome.runtime.sendMessage({ t: 'state', state }).catch(() => {});
}

function updateIcon() {
  const dir = state.connected && !state.locked ? 'icon' : 'locked';
  const path = { 16: `icons/${dir}16.png`, 32: `icons/${dir}32.png`, 48: `icons/${dir}48.png`, 128: `icons/${dir}128.png` };
  chrome.action.setIcon({ path }).catch(() => {});
  chrome.action.setTitle({ title: !state.connected ? msg('Ext_Title_Disconnected') : state.locked ? msg('Ext_Title_Locked') : 'TKRForm' }).catch(() => {});
}

async function getPrefs() {
  if (prefsCache) return prefsCache;
  try {
    prefsCache = await call('getPrefs');
  } catch (_) {
    prefsCache = { autofill: { mode: 'suggest', target: 'both', onlyOnPasswordPages: true, minIdentityFields: 3, basicAuth: true, inlineMenu: true }, autosave: { mode: 'suggest', forceDialog: true, excludeUrls: [] }, equivDomains: [], clipboardClearSecs: 30 };
  }
  return prefsCache;
}

// ------------------------------------------------------------------ バッジ（このサイトの候補数）

async function updateBadge(tabId, url) {
  if (state.locked || !state.connected || !/^https?:/i.test(url || '')) { chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}); return; }
  try {
    const r = await call('match', { url });
    const n = r.logins.length;
    await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2b8de0' });
  } catch (_) { /* 無視 */ }
}

async function refreshBadges() {
  const tabs = await chrome.tabs.query({ active: true });
  for (const t of tabs) if (t.id !== undefined) updateBadge(t.id, t.url);
}

async function clearBadges() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) if (t.id !== undefined) chrome.action.setBadgeText({ tabId: t.id, text: '' }).catch(() => {});
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { const t = await chrome.tabs.get(tabId); updateBadge(tabId, t.url); } catch (_) { /* 無視 */ }
});

// ------------------------------------------------------------------ 「開いて記入」（トレイ・エディタ・ポップアップからの記入指示）

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; } };
const originOf = (u) => { try { return new URL(u).origin; } catch (_) { return ''; } };
// 厳密な照合はアプリ側が行う。ここでは「無関係なタブに試行しない」ための粗い絞り込み
const roughSameSite = (a, b) => {
  if (!a || !b) return false;
  if (a === b || a.endsWith('.' + b) || b.endsWith('.' + a)) return true;
  const la = a.split('.').slice(-2).join('.'), lb = b.split('.').slice(-2).join('.');
  return la === lb;
};

function addPending(p) {
  pendingFills.push({ ...p, host: hostOf(p.url), expires: Date.now() + 90_000 });
  while (pendingFills.length > 50) pendingFills.shift();
}

async function onFillRequest(d) {
  if (d.current) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) fillInTab(tab.id, d.id, d.submit);
    return;
  }
  addPending({ id: d.id, url: d.url, submit: d.submit });
}

async function fillInTab(tabId, id, submit, pendingMode) {
  try {
    const rs = await chrome.tabs.sendMessage(tabId, { t: 'cmd', name: 'fillById', id, submit, pending: !!pendingMode });
    return rs;
  } catch (_) { return null; }
}

async function tryPending(tabId, url) {
  const now = Date.now();
  for (let i = pendingFills.length - 1; i >= 0; i--) if (pendingFills[i].expires < now) pendingFills.splice(i, 1);
  if (!pendingFills.length || state.locked) return;
  const host = hostOf(url);
  for (const p of [...pendingFills]) {
    if (!roughSameSite(host, p.host)) continue;
    // 記入中に、ページ遷移の通知（onCompleted と onHistoryStateUpdated など）がもう 1 回来ても、二重に記入・送信しない
    // （「短時間に同一の画面操作が複数回行われた」とみなして弾く銀行サイトがある）
    if (p.busy) continue;
    p.busy = true;
    let r = null;
    try { r = await fillInTab(tabId, p.id, p.submit, true); } finally { p.busy = false; }
    if (r && r.filled) {
      const i = pendingFills.indexOf(p);
      if (i >= 0) pendingFills.splice(i, 1);
    }
  }
}

// ログイン送信の直後にページが遷移すると、遷移前のページに出した保存ダイアログは消える。
// 保存も却下もされていない保存待ちは「未表示」に戻し、遷移後のページの pendingSave で出し直す。
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  const ch = authChallenged.get(d.tabId);
  if (ch && originOf(ch.url) !== originOf(d.url)) authChallenged.delete(d.tabId);
  for (const e of pendingSaves.values()) {
    if (e.tabId === d.tabId && e.shown && Date.now() - e.ts < 2 * 60_000) e.shown = false;
  }
});

chrome.webNavigation.onCompleted.addListener((d) => {
  if (d.frameId !== 0 || !/^https?:/i.test(d.url)) return;
  tryPending(d.tabId, d.url);
  updateBadge(d.tabId, d.url);
});

chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (!/^https?:/i.test(d.url)) return;
  // SPA の画面遷移: 送信の検知とログイン後の追従記入
  chrome.tabs.sendMessage(d.tabId, { t: 'cmd', name: 'spaNav' }, { frameId: d.frameId }).catch(() => {});
  if (d.frameId === 0) { tryPending(d.tabId, d.url); updateBadge(d.tabId, d.url); }
});

// ------------------------------------------------------------------ ベーシック認証

const authTried = new Set();
const authChallenged = new Map(); // tabId -> { url, ts }: Basic 認証を求められたタブ
const authOverride = new Map(); // tabId -> { id, ts }: ポップアップで選んだ項目で次の 1 回だけ認証する
chrome.tabs.onRemoved.addListener((tabId) => { authChallenged.delete(tabId); authOverride.delete(tabId); });
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    (async () => {
      try {
        // 認証を求められたタブを覚えておく（ダイアログを閉じた後でも、ポップアップから項目を選んで認証し直せるように）
        if (details.tabId >= 0) authChallenged.set(details.tabId, { url: details.url, ts: Date.now() });
        if (state.locked || authTried.has(details.requestId)) return callback({});
        authTried.add(details.requestId);
        if (authTried.size > 200) authTried.clear();
        // ポップアップで選んだ項目の予約があれば 1 回だけそれを使う（アプリ側でも URL に一致するかを確かめる）
        const ov = authOverride.get(details.tabId);
        if (ov) authOverride.delete(details.tabId);
        const chosen = ov && Date.now() - ov.ts < 60_000 ? ov.id : undefined;
        const p = await getPrefs();
        if (!chosen && (!p.autofill || p.autofill.basicAuth === false)) return callback({});
        const r = await call('getBasicAuth', { url: details.url, id: chosen });
        callback({ authCredentials: { username: r.username, password: r.password } });
      } catch (_) {
        callback({});
      }
    })();
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking'],
);

// ------------------------------------------------------------------ コンテキストメニュー・ショートカット

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    // 通常の Web ページ（http / https）の上だけに出す。拡張のページ（ポップアップ・ホーム・保存ダイアログなど）には出さない
    const pages = ['http://*/*', 'https://*/*'];
    chrome.contextMenus.create({ id: 'tk', title: 'TKRForm', contexts: ['page', 'editable', 'frame', 'selection'], documentUrlPatterns: pages });
    const kids = [['tk-fill', 'Ext_Menu_Fill'], ['tk-generate', 'Ext_Menu_Generate'], ['tk-save', 'Ext_Menu_SavePage'], ['tk-lock', 'Ext_Menu_Lock']];
    for (const [id, key] of kids) chrome.contextMenus.create({ id, parentId: 'tk', title: msg(key), contexts: ['page', 'editable', 'frame', 'selection'], documentUrlPatterns: pages });
  });
}

chrome.runtime.onInstalled.addListener(() => { buildMenus(); connect(); updateIcon(); });
chrome.runtime.onStartup.addListener(() => { connect(); updateIcon(); });

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id === undefined) return;
  const send = (name) => chrome.tabs.sendMessage(tab.id, { t: 'cmd', name }, { frameId: info.frameId || 0 }).catch(() => {});
  switch (info.menuItemId) {
    case 'tk-fill': send('fillBest'); break;
    case 'tk-generate': send('generate'); break;
    case 'tk-save': send('savePage'); break;
    case 'tk-lock': call('lock').catch(() => {}); break;
    default: break;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id === undefined) return;
  if (command === 'fill-best') chrome.tabs.sendMessage(tab.id, { t: 'cmd', name: 'fillBest' }).catch(() => {});
  if (command === 'generate') chrome.tabs.sendMessage(tab.id, { t: 'cmd', name: 'generate' }).catch(() => {});
});

// ------------------------------------------------------------------ 自動保存

const excluded = (url, list) => (list || []).some((x) => x && url.toLowerCase().includes(x.toLowerCase()));

async function onCaptured(data, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId === undefined) return;
  const p = await getPrefs();
  const forced = !!data.forced;
  if (!data.user && data.kind === 'change' && !state.locked) {
    // パスワード変更フォームにはユーザー ID 欄がないことが多い。このサイトのログインが 1 件ならそれとみなす
    try { const m = await call('match', { url: data.url }); if (m.logins.length === 1) data.user = m.logins[0].user; } catch (_) { /* 無視 */ }
  }
  if (!forced && (p.autosave.mode === 'off' || excluded(data.url, p.autosave.excludeUrls))) return;
  if (!state.connected) return;
  const token = crypto.randomUUID();
  let check = null;
  if (!state.locked) {
    try { check = await call('checkSave', { url: data.url, user: data.user || '', password: data.password }); } catch (_) { check = null; }
    if (check && check.action === 'none' && !forced) return;
    if (check && !forced && p.autosave.mode === 'auto') {
      await persistCapture({ data, check }, { name: hostOf(data.url), folder: '/' });
      chrome.tabs.sendMessage(tabId, { t: 'toast', text: msg(check.action === 'update' ? 'Ext_Save_Updated' : 'Ext_Save_Saved') }, { frameId: 0 }).catch(() => {});
      return;
    }
  }
  const entry = { data, tabId, check, ts: Date.now(), shown: false };
  pendingSaves.set(token, entry);
  for (const [k, v] of pendingSaves) if (Date.now() - v.ts > 10 * 60_000) pendingSaves.delete(k);
  // ページを離れる直前の捕捉は、遷移後のページが pendingSave で取りに来る
  if (data.deferred) return;
  chrome.tabs.sendMessage(tabId, { t: 'showSave', token }, { frameId: 0 }).then(() => { entry.shown = true; }).catch(() => {});
}

/** 既存のログインの欄に、取り込んだ欄の新しい値を重ねる。ユーザー ID・パスワードは役割（role）で、ほかは id → name の順で照合し、
 *  ラジオは同じ name のものを置き換える。見つからない欄は追加し、取り込まれなかった既存の欄はそのまま残す。 */
function mergeFields(existing, captured) {
  const out = (existing || []).map((f) => ({ ...f }));
  for (const c of captured) {
    let i = -1;
    if (c.role) i = out.findIndex((f) => f.role === c.role);
    if (i < 0 && c.kind === 'radio') i = out.findIndex((f) => f.kind === 'radio' && f.name === c.name);
    if (i < 0 && c.id) i = out.findIndex((f) => f.id === c.id && f.kind !== 'radio');
    if (i < 0 && c.name) i = out.findIndex((f) => f.name === c.name && !f.id && f.kind !== 'radio');
    if (i >= 0) out[i] = { ...out[i], value: c.value, kind: c.kind || out[i].kind, ...(c.kind === 'radio' ? { id: c.id } : {}) };
    else out.push({ ...c });
  }
  return out;
}

async function persistCapture(entry, opts) {
  const { data, check } = entry;
  if (check && check.action === 'update' && opts.mode !== 'new') {
    const it = await call('getItem', { id: check.id });
    // 取り込んだ欄（なければ、パスワードだけ）で更新する。パスワードの履歴は、アプリ側が今までどおり残す
    const captured = (data.fields && data.fields.length) ? data.fields : [{ name: '', id: '', value: data.password, kind: 'password', role: 'password' }];
    const fields = mergeFields(it.fields, captured);
    await call('saveItem', { mode: 'update', item: { id: it.id, fields } });
    return it.id;
  }
  const url = (() => { try { const u = new URL(data.url); return u.origin + u.pathname; } catch (_) { return data.url; } })();
  const item = {
    type: 1, name: opts.name || hostOf(data.url), folder: opts.folder || '/', url,
    // 入力・選択されたすべての欄（なければ、ユーザー ID とパスワードだけ）
    fields: (data.fields && data.fields.some((f) => f.role === 'password')) ? data.fields : [
      { name: data.userField?.name || 'username', id: data.userField?.id || '', value: data.user || '', kind: 'text', role: 'user' },
      { name: data.pwField?.name || 'password', id: data.pwField?.id || '', value: data.password, kind: 'password', role: 'password' },
    ],
  };
  const r = await call('saveItem', { mode: 'new', item });
  return r.id;
}

// ------------------------------------------------------------------ メッセージ

const isExtPage = (sender) => !!sender.url && sender.url.startsWith(EXT_BASE);

// Windows Hello の要求は、同時に 1 つだけ（ボタンと自動開始が重なっても二重に始めない）。ポップアップが閉じても、ここで最後まで待つ。
// キャンセル・失敗した直後に自動で始め直すと、利用者が抜け出せないため、失敗から一定時間は自動開始しない。
const HELLO_AUTO_RETRY_MS = 30_000;
let helloInflight = null;
let helloFailedAt = 0;
chrome.storage.session.get('helloFailedAt').then((r) => { helloFailedAt = Math.max(helloFailedAt, Number(r.helloFailedAt) || 0); }).catch(() => {});
function helloRun() {
  if (helloInflight) return helloInflight;
  helloInflight = call('helloUnlock', {}, 120_000)
    .catch((e) => {
      helloFailedAt = Date.now();
      chrome.storage.session.set({ helloFailedAt }).catch(() => {});
      throw e;
    })
    .finally(() => { helloInflight = null; });
  return helloInflight;
}

const CONTENT_OK = new Set(['state', 'match', 'fill', 'identity', 'totp', 'captured', 'generate', 'unlock', 'helloUnlock', 'pendingSave', 'passkeyAvail', 'passkeyList', 'passkeyCreate', 'passkeyGet']);

async function handle(m, sender) {
  const ext = isExtPage(sender);
  if (!ext && !CONTENT_OK.has(m.t)) throw { code: 'POLICY_DENIED', message: 'denied' };
  switch (m.t) {
    case 'state':
      connect();
      await ready();
      return { ...state, prefs: state.connected && !state.locked ? await getPrefs() : null };
    case 'reconnect':
      lastConnectTry = 0; lastKick = 0; connect();
      return state;
    case 'match':
      return call('match', { url: sender.url });
    case 'fill': {
      // URL はブラウザが保証する送信元フレームの URL を使い、アプリ側でも再照合される
      const r = await call('getFill', { id: m.id, url: sender.url });
      call('touch', { id: m.id }).catch(() => {});
      if (r.chain && r.chain.next && r.chain.next.length && sender.tab) {
        for (const id of r.chain.next) addPending({ id, url: sender.url, submit: null });
      }
      return r;
    }
    case 'identity':
      return call('getIdentityFill', { id: m.id, instance: m.instance });
    case 'totp':
      return call('totp', { id: m.id });
    case 'unlock': {
      const r = await call('unlock', { password: m.password });
      return r;
    }
    case 'helloUnlock':
      // 確認ダイアログで利用者が操作する時間を待つ（アプリが小さなウィンドウを前面に出し、Hello の確認を出す）
      return helloRun();
    case 'helloAuto': {
      // ポップアップを開いたときの自動開始。Hello が使えない・直前に失敗した・すでに進行中のときは始めない
      if (!state.locked || !state.helloAvailable) return { started: false };
      if (helloInflight) return { started: false, busy: true };
      if (Date.now() - helloFailedAt < HELLO_AUTO_RETRY_MS) return { started: false, recentFail: true };
      try { await helloRun(); return { started: true }; } catch (e) { return { started: true, error: String((e && e.message) || e) }; }
    }
    // ---- パスキー: origin は、ブラウザが保証する送信元フレームの URL から決める（ページのスクリプトから渡された値は使わない）。
    // アプリ側でも、origin と rpId の関係を再検証する。
    case 'passkeyAvail':
      return call('passkeyAvail', { origin: new URL(sender.url).origin });
    case 'passkeyList':
      return call('passkeyList', { origin: new URL(sender.url).origin, rpId: m.args.rpId, allow: m.args.allow || [] });
    case 'passkeyCreate':
    case 'passkeyGet': {
      // 同一オリジンの iframe だけが対象（passkey.js が絞っている）。トップと同じオリジンなので crossOrigin は false
      const a = { ...m.args, origin: new URL(sender.url).origin, crossOrigin: false };
      if (!a.password) delete a.password;
      return call(m.t, a, 120_000);
    }
    case 'generate':
      return call('generate', { options: m.options || null, record: false });
    case 'captured':
      await onCaptured(m.data, sender);
      return {};
    // ---- ここから拡張ページ（ポップアップ・設定・保存ダイアログ）専用
    case 'saveFormInTab': {
      // ポップアップの「フォームの入力内容を保存」: トップフレームから順に試し、最初に取り込めたフレームで保存ダイアログを出す
      const frames = (await chrome.webNavigation.getAllFrames({ tabId: m.tabId }).catch(() => null)) || [{ frameId: 0 }];
      frames.sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : 0));
      let hasForm = false;
      for (const f of frames) {
        const r = await chrome.tabs.sendMessage(m.tabId, { t: 'cmd', name: 'savePage', quiet: true }, { frameId: f.frameId }).catch(() => null);
        if (r && r.captured) return { captured: true };
        if (r && r.hasForm) hasForm = true;
      }
      throw { code: 'NO_FORM', message: msg(hasForm ? 'Ext_Err_FormEmpty' : 'Ext_Err_NoForm') };
    }
    case 'rpc':
      if (m.cmd === 'setPrefs') prefsCache = null;
      return call(m.cmd, m.args || {});
    case 'fillTab': {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return { filled: false };
      const r = (await fillInTab(tab.id, m.id, m.submit)) || { filled: false };
      if (r.filled) return r;
      // フォームがなく、このタブが直前に Basic 認証を求められていたら、選んだ項目で認証し直す（10 分以内）
      const ch = authChallenged.get(tab.id);
      if (ch && Date.now() - ch.ts < 10 * 60_000) {
        authOverride.set(tab.id, { id: m.id, ts: Date.now() });
        await chrome.tabs.update(tab.id, { url: ch.url });
        return { filled: true, basicAuth: true };
      }
      return r;
    }
    case 'fillIdentityTab': {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab) chrome.tabs.sendMessage(tab.id, { t: 'cmd', name: 'fillIdentityById', id: m.id }).catch(() => {});
      return {};
    }
    case 'goFill':
      addPending({ id: m.id, url: m.url, submit: m.submit });
      await chrome.tabs.create({ url: m.url });
      return {};
    case 'getSaveData': {
      const e = pendingSaves.get(m.token);
      if (!e) throw { code: 'NOT_FOUND', message: 'expired' };
      let check = e.check;
      if (!check && !state.locked) {
        try { check = await call('checkSave', { url: e.data.url, user: e.data.user || '', password: e.data.password }); e.check = check; } catch (_) { /* 無視 */ }
      }
      return { url: e.data.url, user: e.data.user || '', kind: e.data.kind, check, locked: state.locked, defaultName: hostOf(e.data.url) };
    }
    case 'doSave': {
      const e = pendingSaves.get(m.token);
      if (!e) throw { code: 'NOT_FOUND', message: 'expired' };
      const id = await persistCapture(e, { name: m.name, folder: m.folder, mode: m.mode });
      pendingSaves.delete(m.token);
      return { id };
    }
    case 'neverHere': {
      const e = pendingSaves.get(m.token);
      if (e) {
        const p = await getPrefs();
        const host = hostOf(e.data.url);
        const list = [...(p.autosave.excludeUrls || [])];
        if (!list.includes(host)) list.push(host);
        await call('setPrefs', { autosave: { ...p.autosave, excludeUrls: list } });
        prefsCache = null;
        pendingSaves.delete(m.token);
      }
      return {};
    }
    case 'pendingSave': {
      if (!sender.tab) return {};
      for (const [token, e] of pendingSaves) {
        if (e.tabId === sender.tab.id && !e.shown && Date.now() - e.ts < 2 * 60_000) { e.shown = true; return { token }; }
      }
      return {};
    }
    case 'dropSave':
      pendingSaves.delete(m.token);
      return {};
    case 'closeSave':
      if (m.tabId !== undefined) chrome.tabs.sendMessage(m.tabId, { t: 'closeSave' }, { frameId: 0 }).catch(() => {});
      else if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, { t: 'closeSave' }, { frameId: 0 }).catch(() => {});
      return {};
    case 'prefsChanged':
      prefsCache = null;
      return {};
    case 'icon': // ホームのタイル用のサイトのアイコン（拡張のページからだけ。取得とキャッシュは icons.js）
      return iconFor(m.url);
    case 'iconClear':
      await clearIcons();
      return {};
    default:
      throw { code: 'INTERNAL', message: 'unknown message' };
  }
}

chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  if (!m || typeof m !== 'object' || m.t === 'state-broadcast') return false;
  if (m.t === 'state' && m.state) return false; // 自分が送ったブロードキャスト
  handle(m, sender).then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: { code: (e && e.code) || 'INTERNAL', message: (e && e.message) || String(e) } }),
  );
  return true;
});

connect();
updateIcon();
