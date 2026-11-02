// E2E テスト用の共通ヘルパ（Node 24 の標準機能のみ）。
//   - アプリの起動（テスト用データフォルダ + WebView2 のリモートデバッグ）
//   - CDP（Chrome DevTools Protocol）クライアント
//   - Named Pipe クライアント（拡張と同じプロトコル）
//   - Native Messaging ホストの起動
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 利用者の tkrform と同時に動かせるよう、テストはパイプ名に接尾辞を付ける
process.env.TKRFORM_PIPE_SUFFIX = process.env.TKRFORM_PIPE_SUFFIX || 'e2e';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, timeout = 15000, what = 'condition', step = 100) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    if (Date.now() - t0 > timeout) throw new Error(`タイムアウト: ${what}${last ? ' (' + last.message + ')' : ''}`);
    await sleep(step);
  }
}

export function sid() {
  const out = execSync(String.raw`C:\Windows\System32\whoami.exe /user /fo csv /nh`, { encoding: 'utf8' });
  return out.trim().split(',')[1].replace(/"/g, '');
}

// この実行で自分が作った一時フォルダ（と、同じ名前の付随物）。E2E_CLEANUP=1 のときだけ、終了時に片付ける（過去の分には触れない）
const made = [];
export function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), prefix));
  made.push(d);
  return d;
}
if (process.env.E2E_CLEANUP === '1') {
  process.on('exit', () => {
    for (const d of made) {
      for (const x of [d, d + '-wv2', d + '-hello-stub.txt']) {
        try { fs.rmSync(x, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* 使用中など。残してよい */ }
      }
    }
  });
}

// 利用者の作業を邪魔しない: アプリのウィンドウは画面の外に置かれ、前面化もされない（アプリ側の sys::quiet）。
// OS への実入力（SendInput / SendKeys）を使う E2E は、TKRFORM_E2E_INTERACTIVE=1 のときだけ動かす。
export const INTERACTIVE = process.env.TKRFORM_E2E_INTERACTIVE === '1';

// ---------------------------------------------------------------- アプリの起動

export function startApp({ dataDir, cdpPort = 9333, args = [], exe, env = {} }) {
  const bin = exe || process.env.TKRFORM_EXE || path.join(ROOT, 'target', 'debug', 'TKRForm.exe');
  const wv = path.join(dataDir, '..', path.basename(dataDir) + '-wv2');
  const child = spawn(bin, args, {
    env: {
      ...process.env,
      TKRFORM_TEST: '1',
      TKRFORM_DATA_DIR: dataDir,
      WEBVIEW2_USER_DATA_FOLDER: wv,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  watchWindows(child.pid, 'TKRForm');
  return { child, log, cdpPort };
}

export function killTree(child) {
  try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) { /* 既に終了 */ }
}

// ---------------------------------------------------------------- CDP

export async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json`);
  return r.json();
}

export async function waitTarget(port, match, timeout = 20000) {
  return waitFor(async () => (await listTargets(port)).find((t) => t.type === 'page' && match(t)), timeout, 'CDP target');
}

export class Cdp {
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    // 接続が完了も失敗もしないまま止まらないよう、時間制限をつける
    await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('ws 接続のタイムアウト（15 秒）: ' + wsUrl)), 15000); ws.onopen = () => { clearTimeout(to); res(); }; ws.onerror = () => { clearTimeout(to); rej(new Error('ws error')); }; });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && this.pending.has(d.id)) {
        const p = this.pending.get(d.id);
        this.pending.delete(d.id);
        if (d.error) p.rej(new Error(JSON.stringify(d.error))); else p.res(d.result);
      } else if (d.method) this.events.push(d);
    };
  }

  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      // ページが閉じられた・固まったときに、応答が来ないまま永久に待たない
      const to = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP のタイムアウト（${timeoutMs / 1000} 秒）: ${method}`)); }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(to); res(v); }, rej: (e) => { clearTimeout(to); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) { const ex = r.exceptionDetails.exception || {}; throw new Error('eval: ' + (ex.description && ex.description !== 'Object' ? ex.description : JSON.stringify(ex.preview || ex.value || r.exceptionDetails.text))); }
    return r.result.value;
  }

  /** 開いたページが読み込まれる（about:blank でなくなり、readyState が complete になる）まで待つ。
   *  /json/new は、ナビゲーションの前に about:blank のまま返ることがあり、その状態で complete を見てしまうと、まだない要素を探すことになる。
   *  時間切れでもエラーにはしない（読み込みが終わらないページを、わざと開くテストがあるため）。 */
  async waitLoaded(timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await this.eval(`({ h: location.href, s: document.readyState })`);
        if (r && r.h !== 'about:blank' && r.s === 'complete') return true;
      } catch (_) { /* ナビゲーション中は評価に失敗することがある */ }
      await sleep(100);
    }
    return false;
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }

  async click(selector) {
    const pos = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; })()`);
    if (!pos) throw new Error('要素がありません: ' + selector);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  }

  /** 実際のキー入力（isTrusted になる）で入力欄に文字を打つ。 */
  async type(selector, text, { clear = true } = {}) {
    await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); ${clear ? 'e.select && e.select();' : ''} })()`);
    if (clear) { await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); }
    await this.send('Input.insertText', { text });
  }

  async press(key, code = key, vk = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text: key === 'Enter' ? '\r' : undefined });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  }

  close() { try { this.ws.close(); } catch (_) { /* 無視 */ } }
}

// ---------------------------------------------------------------- Named Pipe クライアント

export class PipeClient {
  static async connect(timeout = 15000) {
    const name = `\\\\.\\pipe\\tkrform-${sid()}-${process.env.TKRFORM_PIPE_SUFFIX}`;
    const sock = await waitFor(() => new Promise((res) => {
      const s = net.connect(name);
      // 1 回の接続が完了も失敗もしないまま止まらないよう、2 秒で諦めて次の試行へ
      const to = setTimeout(() => { s.destroy(); res(null); }, 2000);
      s.once('connect', () => { clearTimeout(to); res(s); });
      s.once('error', () => { clearTimeout(to); res(null); });
    }), timeout, 'named pipe');
    return new PipeClient(sock);
  }

  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.nextId = 1; this.pending = new Map(); this.events = [];
    sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        if (this.buf.length < 4) return;
        const n = this.buf.readUInt32LE(0);
        if (this.buf.length < 4 + n) return;
        const msg = JSON.parse(this.buf.subarray(4, 4 + n).toString('utf8'));
        this.buf = this.buf.subarray(4 + n);
        if (msg.id !== undefined && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
        else if (msg.event) this.events.push(msg);
      }
    });
  }

  call(cmd, args = {}, timeoutMs = 60000) {
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({ id, cmd, args }), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    this.sock.write(Buffer.concat([head, body]));
    return new Promise((res, rej) => {
      const to = setTimeout(() => { this.pending.delete(id); rej(new Error(`パイプのタイムアウト（${timeoutMs / 1000} 秒）: ${cmd}`)); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(to); res(m); });
    });
  }

  /** 成功を期待する呼び出し */
  async ok(cmd, args = {}) {
    const r = await this.call(cmd, args);
    if (!r.success) throw new Error(`${cmd} 失敗: ${r.code} ${r.message}`);
    return r.data;
  }

  close() { this.sock.destroy(); }
}

// ---------------------------------------------------------------- Native Messaging ホスト

export function spawnNmHost(origin, exe) {
  const bin = exe || process.env.TKRFORM_NMHOST_EXE || path.join(ROOT, 'target', 'debug', 'tkrform-nmhost.exe');
  const child = spawn(bin, [origin], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = Buffer.alloc(0);
  const msgs = [];
  const waiters = [];
  child.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 4) return;
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) return;
      const m = JSON.parse(buf.subarray(4, 4 + n).toString('utf8'));
      buf = buf.subarray(4 + n);
      msgs.push(m);
      waiters.splice(0).forEach((w) => w());
    }
  });
  const send = (obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([head, body]));
  };
  const nextWhere = async (pred, timeout = 15000) => waitFor(() => {
    const i = msgs.findIndex(pred);
    return i >= 0 ? msgs.splice(i, 1)[0] : null;
  }, timeout, 'NM message');
  return { child, send, msgs, nextWhere };
}

/** いま前面にあるウィンドウのプロセス ID（前面を奪っていないことの確認用。入力は送らない）。 */
export function foregroundPid() {
  const ps = `$ProgressPreference = 'SilentlyContinue'; Add-Type -Namespace T -Name F -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);'; $p = 0; [void][T.F]::GetWindowThreadProcessId([T.F]::GetForegroundWindow(), [ref]$p); $p`;
  const out = execSync('powershell -NoProfile -EncodedCommand ' + Buffer.from(ps, 'utf16le').toString('base64'), { encoding: 'utf8' });
  return Number(out.trim().split(/\r?\n/).pop());
}

// ---------------------------------------------------------------- 画面にウィンドウが出ないことの見張り
// テスト用のプロセス（とその子孫: msedgewebview2.exe など）が持つ「可視のトップレベルウィンドウ」が、
// 仮想スクリーンの範囲内に入ったら違反として記録し、終了時に失敗にする。
const watchers = [];
const NL = new RegExp(String.fromCharCode(92) + 'r?' + String.fromCharCode(92) + 'n');
export function watchWindows(rootPid, label = 'proc') {
  if (INTERACTIVE) return; // 実入力を使う実行では、ウィンドウが見える前提
  const out = path.join(process.env.E2E_TMP || os.tmpdir(), `winwatch-${process.pid}-${rootPid}.txt`);
  try { fs.rmSync(out, { force: true }); } catch (_) { /* なし */ }
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'e2e', 'winwatch.ps1'), '-RootPid', String(rootPid), '-Out', out], { stdio: 'ignore', windowsHide: true });
  watchers.push({ child, out, label });
}
function finishWatch() {
  let bad = 0;
  for (const w of watchers) {
    try { execSync(`taskkill /pid ${w.child.pid} /T /F`, { stdio: 'ignore' }); } catch (_) { /* 既に終了 */ }
    let lines = [];
    try { lines = fs.readFileSync(w.out, 'utf8').split(NL).filter(Boolean); } catch (_) { /* 違反なし */ }
    if (lines.length) { bad += lines.length; console.log(`FAIL  画面内に出たウィンドウ（${w.label}）: ${lines.length} 件`); for (const l of lines.slice(0, 10)) console.log('      ' + l); }
    try { fs.rmSync(w.out, { force: true }); } catch (_) { /* なし */ }
  }
  if (!bad && watchers.length) console.log(`PASS  テスト中、画面内に可視のウィンドウは出なかった（見張り ${watchers.length} 件）`);
  if (bad) process.exitCode = 1;
}
process.on('exit', finishWatch);
