'use strict';
(async () => {
  await initI18n();
  const st = await rpc('status');
  $('#ver').textContent = t('About_Version', st.version);
  $('#dir').textContent = t('About_DataDir', st.dataDir);
})();
