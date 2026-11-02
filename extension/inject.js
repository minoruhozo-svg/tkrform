// MAIN world で動く。navigator.credentials.create / get（WebAuthn の publicKey）を包み、tkrform で扱えるときだけ
// 拡張側（passkey.js）へ処理を依頼する。扱わない場合は、元の API にそのまま渡す。
//
// ページのスクリプトから偽装されないための決めごと:
//  - passkey.js が document_start で乱数のチャネル名（token）を作り、1 回だけ CustomEvent でここへ渡す。ページのスクリプトは
//    これより後にしか動かないので、token を知ることも、先に偽のハンドシェイクを送ることもできない。
//  - 以降の要求・応答は、token を含む名前のイベントで行う（名前を知らないページは、聞くことも送ることもできない）。
//  - EventTarget の関数などは、ページが書き換える前の参照をここで確保しておく。
(() => {
  'use strict';
  if (!navigator.credentials || typeof PublicKeyCredential === 'undefined') return;

  const cc = navigator.credentials;
  const origCreate = cc.create.bind(cc);
  const origGet = cc.get.bind(cc);
  const addL = EventTarget.prototype.addEventListener;
  const removeL = EventTarget.prototype.removeEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const CE = CustomEvent;
  const J = JSON;
  const win = window;
  const rnd = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); };

  let token = null;
  const waiters = new Map();

  const onHandshake = (e) => {
    if (token) return;
    try { token = J.parse(e.detail).token; } catch (_) { return; }
    removeL.call(win, 'tkpk-hs', onHandshake, true);
    addL.call(win, 'tkpk-r-' + token, (ev) => {
      let m; try { m = J.parse(ev.detail); } catch (_) { return; }
      const w = m && waiters.get(m.id);
      if (w) w(m);
    }, true);
  };
  addL.call(win, 'tkpk-hs', onHandshake, true);

  // ---- base64url
  const b64u = (buf) => {
    const b = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const unb64u = (s) => {
    s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    const bin = atob(s); const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b.buffer;
  };
  const isBuf = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v);

  /** 拡張側へ要求を送り、応答を待つ。signal が中断されたら、中断を伝えて拒否する。 */
  function request(op, data, signal) {
    return new Promise((resolve, reject) => {
      if (!token) { resolve({ fallback: true }); return; }
      const id = rnd(16);
      const done = (fn, v) => { waiters.delete(id); fn(v); };
      waiters.set(id, (m) => done(resolve, m));
      if (signal) {
        const onAbort = () => {
          dispatch.call(win, new CE('tkpk-q-' + token, { detail: J.stringify({ id, op: 'abort' }) }));
          done(reject, signal.reason || new DOMException('The operation was aborted.', 'AbortError'));
        };
        if (signal.aborted) { onAbort(); return; }
        addL.call(signal, 'abort', onAbort, { once: true });
      }
      dispatch.call(win, new CE('tkpk-q-' + token, { detail: J.stringify({ id, op, data }) }));
    });
  }

  function fail(r) {
    // r.error = { name, message }
    return new DOMException(r.error.message || '', r.error.name || 'NotAllowedError');
  }

  // ---- 返すオブジェクト（PublicKeyCredential / AuthenticatorAttestationResponse / AuthenticatorAssertionResponse の形）
  const tag = (o, name) => Object.defineProperty(o, Symbol.toStringTag, { value: name, configurable: true });
  const def = (o, props) => { for (const [k, v] of Object.entries(props)) Object.defineProperty(o, k, { value: v, enumerable: true, configurable: true }); return o; };

  function makeCredential(kind, r, extResults) {
    const rawId = unb64u(r.credentialId);
    const cdj = unb64u(r.clientDataJSON);
    const resp = Object.create((kind === 'create' ? AuthenticatorAttestationResponse : AuthenticatorAssertionResponse).prototype);
    tag(resp, kind === 'create' ? 'AuthenticatorAttestationResponse' : 'AuthenticatorAssertionResponse');
    let json;
    if (kind === 'create') {
      const ad = unb64u(r.authData); const spki = unb64u(r.publicKey);
      def(resp, { clientDataJSON: cdj, attestationObject: unb64u(r.attestationObject) });
      Object.defineProperties(resp, {
        getTransports: { value: () => ['internal', 'hybrid'], configurable: true },
        getAuthenticatorData: { value: () => ad.slice(0), configurable: true },
        getPublicKey: { value: () => spki.slice(0), configurable: true },
        getPublicKeyAlgorithm: { value: () => r.publicKeyAlgorithm, configurable: true },
      });
      json = { clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject, transports: ['internal', 'hybrid'], authenticatorData: r.authData, publicKeyAlgorithm: r.publicKeyAlgorithm, publicKey: r.publicKey };
    } else {
      def(resp, { clientDataJSON: cdj, authenticatorData: unb64u(r.authData), signature: unb64u(r.signature), userHandle: r.userHandle ? unb64u(r.userHandle) : null });
      json = { clientDataJSON: r.clientDataJSON, authenticatorData: r.authData, signature: r.signature, userHandle: r.userHandle || undefined };
    }
    const cred = Object.create(PublicKeyCredential.prototype);
    tag(cred, 'PublicKeyCredential');
    def(cred, { id: r.credentialId, rawId, type: 'public-key', authenticatorAttachment: 'platform', response: resp });
    Object.defineProperties(cred, {
      getClientExtensionResults: { value: () => ({ ...extResults }), configurable: true },
      toJSON: { value: () => ({ id: r.credentialId, rawId: r.credentialId, type: 'public-key', authenticatorAttachment: 'platform', response: json, clientExtensionResults: { ...extResults } }), configurable: true },
    });
    return cred;
  }

  const descs = (list) => (Array.isArray(list) ? list.filter((d) => d && d.type === 'public-key' && isBuf(d.id)).map((d) => b64u(d.id)) : []);

  async function create(options) {
    const pkOpt = options && options.publicKey;
    if (!token || !pkOpt || !pkOpt.rp || !pkOpt.user || !isBuf(pkOpt.challenge) || !isBuf(pkOpt.user.id)) return origCreate(options);
    const sel = pkOpt.authenticatorSelection || {};
    const data = {
      rpId: pkOpt.rp.id || null,
      rpName: pkOpt.rp.name || '',
      userId: b64u(pkOpt.user.id), userName: pkOpt.user.name || '', userDisplayName: pkOpt.user.displayName || '',
      challenge: b64u(pkOpt.challenge),
      algs: Array.isArray(pkOpt.pubKeyCredParams) ? pkOpt.pubKeyCredParams.filter((p) => p && p.type === 'public-key').map((p) => p.alg) : [],
      exclude: descs(pkOpt.excludeCredentials),
      uv: sel.userVerification || 'preferred',
      attachment: sel.authenticatorAttachment || null,
      credProps: !!(pkOpt.extensions && pkOpt.extensions.credProps),
    };
    const r = await request('create', data, options.signal);
    if (r.fallback) return origCreate(options);
    if (r.error) throw fail(r);
    return makeCredential('create', r, data.credProps ? { credProps: { rk: true } } : {});
  }

  async function get(options) {
    const pkOpt = options && options.publicKey;
    if (!token || !pkOpt || !isBuf(pkOpt.challenge)) return origGet(options);
    const data = {
      rpId: pkOpt.rpId || null,
      challenge: b64u(pkOpt.challenge),
      allow: descs(pkOpt.allowCredentials),
      uv: pkOpt.userVerification || 'preferred',
      mediation: options.mediation || null,
    };
    const r = await request('get', data, options.signal);
    if (r.fallback) return origGet(options);
    if (r.error) throw fail(r);
    return makeCredential('get', r, {});
  }

  // 関数の見た目（toString など）を元の API に近づける
  const wrap = (fn, name, len) => {
    Object.defineProperty(fn, 'name', { value: name });
    Object.defineProperty(fn, 'length', { value: len });
    const ts = function toString() { return 'function ' + name + '() { [native code] }'; };
    Object.defineProperty(fn, 'toString', { value: ts, configurable: true });
    return fn;
  };
  // ---- 可用性の問い合わせ: tkrform が使える状態なら true（そうでなければ元の API の答え）
  const origCond = PublicKeyCredential.isConditionalMediationAvailable;
  const origUvpa = PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
  const avail = (orig) => async function () {
    const r = await request('avail', {});
    if (r && r.yes) return true;
    return typeof orig === 'function' ? orig.call(PublicKeyCredential) : false;
  };
  if (typeof origCond === 'function') Object.defineProperty(PublicKeyCredential, 'isConditionalMediationAvailable', { value: wrap(avail(origCond), 'isConditionalMediationAvailable', 0), configurable: true, writable: true });
  if (typeof origUvpa === 'function') Object.defineProperty(PublicKeyCredential, 'isUserVerifyingPlatformAuthenticatorAvailable', { value: wrap(avail(origUvpa), 'isUserVerifyingPlatformAuthenticatorAvailable', 0), configurable: true, writable: true });

  Object.defineProperty(cc, 'create', { value: wrap(function (options) { return create(options); }, 'create', 0), configurable: true, writable: true });
  Object.defineProperty(cc, 'get', { value: wrap(function (options) { return get(options); }, 'get', 0), configurable: true, writable: true });
})();
