'use strict';
(async () => {
  await initI18n();
  const info = await rpc('extensionInfo');
  $('#ext-path').textContent = info.path ? t('Setup_Ext_Path', info.path) : t('Setup_Ext_PathMissing');
  $('#open-ext-folder').addEventListener('click', () => rpc('openExtensionFolder').catch(showError));
  $('#open-store').addEventListener('click', () => rpc('openBrowserPage', { browser: 'chrome', page: 'https://chromewebstore.google.com/detail/fkhigfffleejckieoikjboabidigggee' }).catch(showError));
  $('#open-chrome').addEventListener('click', () => rpc('openBrowserPage', { browser: 'chrome', page: 'chrome://extensions' }).catch(showError));
  $('#open-edge').addEventListener('click', () => rpc('openBrowserPage', { browser: 'edge', page: 'edge://extensions' }).catch(showError));
})();
