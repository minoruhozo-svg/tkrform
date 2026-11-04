# TKRForm ブラウザ拡張: ストア提出の下書き / Store submission draft

Chrome ウェブストア（Chrome Web Store）と Microsoft Edge アドオン（Microsoft Edge Add-ons）の審査で書く文面の下書き。英語が本文で、日本語の説明を添えている。
各権限が実際にどこで使われているかは、`extension/` のコードで確かめた（行番号は 0.2.0 の時点）。

提出する zip は `node tools/pack-extension.mjs` で作る（`dist/tkrform-extension-<版>.zip`）。

---

## 0. パッケージと拡張 ID

- zip は、既定で manifest.json の `"key"` を**外して**作る。`"key"` は、開発中に拡張 ID を固定するためのもの。Chrome ウェブストアは、最初のアップロードでは `"key"` の入った manifest を受け付けず、ID はストアが割り当てる。Edge アドオンも、ID はストアが割り当てる。
  - 出典: [Manifest - key（Chrome for Developers）](https://developer.chrome.com/docs/extensions/reference/manifest/key)（開発時の ID の固定。ストアの Package タブの公開鍵を入れると、開発中も同じ ID になる）、[Chromium Extensions グループの議論](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/Su50pbNzRms)（最初のアップロードでは `key` を外す。以後の更新で、ストアの鍵に合わせた `key` を入れるのは任意）、[Microsoft Edge 拡張の公開](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)。ストアが ID を割り当てる仕組みの公式の記述は、見つからなかった（上の議論は、Chrome の拡張の開発者向けの担当者の回答）。
- ストアで割り当てられた ID は、`crates/tkrform-ipc/src/proto.rs` の `ALLOWED_EXTENSION_IDS` に**1 行足す**（Chrome ウェブストアと Edge アドオンは、別の ID になる）。アプリと接続役（NM ホスト）の許可リストと、Native Messaging のマニフェストの `allowed_origins` は、ここから作られる。
- 開発用の拡張（`extension/` を「パッケージ化されていない拡張機能」で読み込んだもの）の ID は、これまでどおり固定（`peloncdiaianimbhoficpdcpiooldofd`）。

## 1. Single purpose（単一の目的）

**English**

> TKRForm is a password manager. This extension connects the browser to the TKRForm desktop app on the user's own PC, so that saved logins can be filled into web pages, new logins can be saved from the pages the user signs in to, and strong passwords can be generated.

**日本語**: パスワードマネージャ。ブラウザを、同じ PC の TKRForm アプリにつなぎ、保存したログインの記入、新しいログインの保存、パスワードの生成を行う。

## 2. Permission justification（権限ごとの理由）

| 権限 | English justification | 使っている場所（日本語） |
|---|---|---|
| `nativeMessaging` | Connects to the TKRForm desktop app on the same PC (native host `jp.tkrs.tkrform`). The vault is stored and decrypted only by that app; the extension asks it for the logins that match the current page. | `bg.js:48`（`chrome.runtime.connectNative`）。すべての保管庫の操作の通り道 |
| `host_permissions: <all_urls>` | A password manager must be able to fill a login form on any site the user chooses to save. Content scripts run on http/https pages to detect login forms and fill them. It is also used (only if the user turns it on) to fetch the top page and icon of the user's saved sites for the Home screen, and to answer HTTP authentication. | `manifest.json` の `content_scripts`（`matches: http(s)://*/*`）、`icons.js`（サイトのアイコンの取得。初期設定はオフ） |
| `tabs` | Reads the URL of tabs to find the logins for the current site, opens the TKRForm pages (Home, Options) and the login page in a tab, and sends fill commands to the tab the user is working in. | `bg.js:169,174,201`（`tabs.query`）、`bg.js:210,255,308,321`（`tabs.sendMessage`）、`bg.js:517`・`popup.js`・`start.js`（`tabs.create`） |
| `storage` | Keeps the extension's own settings (e.g. generator options, Home settings, which dialogs were closed) and a short-lived flag in session storage. No passwords are stored by the extension. | `ext.js:69,92`、`options.js`、`start.js`、`icons.js`（`storage.local`）、`bg.js:407,413`（`storage.session`） |
| `unlimitedStorage` | Stores the small icon images of the user's saved sites (cache of the optional Home icons feature, off by default); with thousands of saved sites this can exceed the default 10 MB quota. | `icons.js`（`storage.local` に、オリジンごとの画像を保存） |
| `webNavigation` | Detects page loads and in-page navigations (including single-page apps) so that login forms are detected, multi-step logins are continued on the next page, and a submitted login can be offered for saving. | `bg.js:237,246,252`（`onCommitted` / `onCompleted` / `onHistoryStateUpdated`）、`bg.js:483`（`getAllFrames`） |
| `webRequest` + `webRequestAuthProvider` | Supplies the matching saved login to HTTP Basic authentication prompts (`onAuthRequired`), only when the vault is unlocked and a saved login matches the site (logins the user marked for HTTP authentication are preferred); it can be turned off in the options. | `bg.js:265`（`webRequest.onAuthRequired`） |
| `contextMenus` | Adds a "TKRForm" right-click menu to fill a login, generate a password, save the page or lock the vault. | `bg.js:297,299,306` |
| `favicon` | Reads the favicon that Chrome already has for a saved site (`_favicon`), with no network request, for the Home screen when site icons are off or unavailable. | `icons.js`（`chrome.runtime.getURL('_favicon/')`） |


## 3. Remote code（リモートコード）

**English**: No. The extension is Manifest V3 and contains all of its code in the package. It does not load or execute remotely hosted code. (The optional Home icon feature downloads images only; SVG images are shown with `<img>` and never inserted into the page as markup.)

**日本語**: 使っていない（MV3。すべてのコードが、パッケージの中にある。アイコンは画像として表示するだけ）。

## 4. Data usage（データの取り扱い）

**English summary for the disclosure**

- The extension and the TKRForm app collect nothing about the user for the developer. There is no telemetry, advertising or account.
- The extension reads the login/identity fields of the pages the user opens, in order to fill them and (when the user chooses) to save them. Saved data is handed only to the TKRForm app on the same PC (Native Messaging) and stored there, encrypted with the user's master password. It is never sent to the developer or to any third party.
- The only network access by the extension itself is the optional Home icons feature: **off by default**; when turned on, it requests the top page and the icon image of the sites the user has saved, without cookies or referrer. A "clear cache" button is provided.
- No data is sold or transferred to third parties; no data is used for creditworthiness or lending purposes; no data is used for purposes unrelated to the single purpose.

**チェックの目安（Chrome ウェブストアの「データの使用」）**: 該当するのは「個人を特定できる情報」「認証情報（パスワード）」「ウェブ閲覧アクティビティ（保存したサイトの URL）」を、**この拡張が扱う**こと。ただし、開発者には送らない。「ユーザーのデータを、承認された以外の用途で使わない / 売らない / 与信に使わない」の 3 つの証明にはチェックを入れてよい。

**Privacy policy URL**: https://github.com/minoruhozo-svg/tkrform/blob/main/PRIVACY.md （公開リポジトリに push してから使う）

## 5. Store listing（掲載情報）の素材

- **Edge アドオン**: 拡張のロゴ 300×300（最小 128×128）、小さいプロモーションタイル 440×280（任意）、大きいプロモーションタイル 1400×560（任意）、スクリーンショットは最大 6 枚で 640×480 または 1280×800。説明は 250 文字以上（出典: [Microsoft Edge 拡張の公開](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)）。画像は `docs/store/`（`extension-*`）にある。
- **Chrome ウェブストア**: アイコン 128×128、スクリーンショット 1280×800 または 640×400、小さいプロモーションタイル 440×280。画像は同じ場所にある。
- manifest の `name` と `description` は `_locales`（日本語・英語）から。ストアに出る名前は `TKRForm パスワードマネージャ` / `TKRForm Password Manager`。
