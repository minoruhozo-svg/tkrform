'use strict';
(async () => {
  await initI18n();
  applyExtInfo(await rpc('extensionInfo'));
  wireExtHelp();
})();
