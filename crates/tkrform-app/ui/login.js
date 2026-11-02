'use strict';
(async () => {
  await initI18n();
  const params = new URLSearchParams(location.search);
  const then = params.get('then');
  const st = await rpc('status');
  if (!st.exists) {
    $('#err').textContent = t('Login_NoVault'); $('#err').classList.remove('hidden');
    $('#go').disabled = true;
    return;
  }
  const finish = async () => {
    if (then) { try { await rpc('openWindow', { name: then }); } catch (e) { showError(e); } }
    await invoke('close_self');
  };
  if (!st.locked) { await finish(); return; }
  if (st.hint) $('#show-hint').classList.remove('hidden');
  $('#show-hint').addEventListener('click', () => {
    $('#hint').textContent = t('Login_HintLabel', st.hint); $('#hint').classList.remove('hidden');
  });
  if (st.hello) {
    $('#hello').classList.remove('hidden');
    const tryHello = async () => {
      $('#hello').disabled = true;
      // このウィンドウは常に手前にあるため、そのままだと Hello の確認画面を覆い隠してしまう。確認の間だけ手前固定を外す
      await invoke('set_on_top', { on: false }).catch(() => {});
      try { await rpc('helloUnlock'); await finish(); } catch (er) { $('#err').textContent = er.message; $('#err').classList.remove('hidden'); $('#pw').focus(); }
      await invoke('set_on_top', { on: true }).catch(() => {});
      $('#hello').disabled = false;
    };
    $('#hello').addEventListener('click', tryHello);
    // ウィンドウを開いた時点で Hello の確認を始める。キャンセルや失敗ならマスターパスワードの入力に戻る
    // ただし、ウィンドウが表示されて前面（フォーカス）になってから始める。前面でないうちに始めると、Hello が確認を出せず失敗することがある（最大 1.5 秒待つ）
    const t0 = Date.now();
    const start = () => {
      if (document.visibilityState === 'visible' || Date.now() - t0 > 3000) setTimeout(tryHello, 300); // 前面（フォーカス）には頼らない
      else setTimeout(start, 100);
    };
    setTimeout(start, 200);
  }
  $('#pw').focus();
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#go').disabled = true;
    try {
      await rpc('unlock', { password: $('#pw').value });
      $('#pw').value = '';
      await finish();
    } catch (er) {
      $('#err').textContent = er.message; $('#err').classList.remove('hidden');
      $('#pw').select();
    }
    $('#go').disabled = false;
  });
})();
