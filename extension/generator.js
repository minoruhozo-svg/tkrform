'use strict';
// ページ上に出すパスワード生成パネル（web_accessible_resources）。「使う」で親フレームの欄へ渡す。
applyI18n();
document.body.classList.add('compact');
mountGenerator($('#host'),
  (pw) => parent.postMessage({ t: 'use', password: pw }, '*'),
  () => parent.postMessage({ t: 'close' }, '*'), true);
// 中身の高さを親（ページ上のパネル）に知らせる。設定を開閉したら、パネルの大きさと位置が直る
const postHeight = () => parent.postMessage({ t: 'resize', height: Math.ceil(document.body.getBoundingClientRect().height) }, '*');
new ResizeObserver(postHeight).observe(document.body);
postHeight();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') parent.postMessage({ t: 'close' }, '*'); });
