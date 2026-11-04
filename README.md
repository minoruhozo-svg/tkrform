# TKRForm

Windows 向けの、無料のパスワード管理とフォーム自動記入ソフトウェアです。

- ログイン情報・プロフィール（住所やカード情報）・メモを、**暗号化した保管庫**に保存します（PBKDF2-HMAC-SHA256 → AES-256-GCM）。マスターパスワードと平文のデータは、PC の外へ出ません。
- Chrome / Edge の**拡張機能**で、ログインの自動記入・自動保存、パスワードの生成、パスキー、TOTP（ワンタイムコード）、ベーシック認証への記入ができます。
- **Windows Hello** でロックを解除できます。
- パスワード生成器、セキュリティセンター（弱い・使い回し・古い・重複・漏洩の検査）、他のソフトや CSV からのインポート、暗号化バックアップ、自前のサーバとの同期に対応しています。
- Windows アプリのログイン画面にも記入できます。

機能と振る舞いの詳細は [仕様書.md](仕様書.md) を、使い方は [マニュアル](docs/manual/) を参照してください。変更履歴は [CHANGELOG.md](CHANGELOG.md) にあります。

## 動作環境

- Windows 10（22H2）/ Windows 11（x64）。WebView2 ランタイムが必要です（Windows 11 は標準で入っています）。
- Google Chrome / Microsoft Edge（最新版と、その 1 つ前の版）。

## インストール

[リリースページ](../../releases)から、インストーラ（`tkrform-setup-<版>.exe`）をダウンロードして実行します。ユーザー単位のインストールで、管理者権限は要りません。アンインストール時は、保管庫などのユーザーデータを消すかどうかを必ず確認します（既定は「残す」）。

ブラウザ拡張は、ストア未公開のため、「パッケージ化されていない拡張機能を読み込む」で入れます。`chrome://extensions`（Edge は `edge://extensions`）で「デベロッパー モード」をオンにし、インストール先の `extension` フォルダを選びます。

## 構成

| パス | 内容 |
|---|---|
| `crates/tkrform-core` | 暗号・保管庫・モデル・URL 照合・パスワード生成・TOTP・インポート/エクスポート（UI 非依存、単体テストあり） |
| `crates/tkrform-ipc` | Native Messaging / Named Pipe のメッセージ型とフレーミング |
| `crates/tkrform-app` | Tauri 2 の常駐アプリ（トレイ・エディタ・生成器・設定）。`ui/` は素の HTML / CSS / JS |
| `crates/tkrform-nmhost` | Native Messaging ホスト（標準入出力と Named Pipe の中継） |
| `extension/` | Chrome / Edge の拡張機能（Manifest V3、素の JS） |
| `server/sync.php` | 同期サーバ（PHP の単一ファイル + SQLite） |
| `installer/tkrform.iss` | インストーラ（Inno Setup 6）のスクリプト |
| `locales/` | 共通の画面文言（`ja.json` / `en.json`）。原本は `tools/locales-src.mjs` |
| `tools/` | アイコン・文言の生成、文言の検査、E2E テスト |

## ビルド

前提: Rust 1.96（`x86_64-pc-windows-msvc`）、WebView2 ランタイム。

```bash
cargo build --release        # target/release/TKRForm.exe と tkrform-nmhost.exe
```

文言（`locales/`）を直したときは、次を実行します（Node 24 と PowerShell が必要です）。

```bash
node tools/locales-src.mjs                                  # locales/ja.json, en.json を生成
node tools/check-locales.mjs                                # コードが参照するキーの不足を検査
powershell -File tools/gen-locales.ps1                      # extension/_locales/ を生成
```

アイコンは `powershell -File tools/gen-icons.ps1` で生成します。

### インストーラの作り方

[Inno Setup 6](https://jrsoftware.org/isinfo.php) を入れたうえで、リリースビルドのあと、リポジトリのルートで実行します。

```bash
cargo build --release
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\tkrform.iss
```

出力は `installer\Output\tkrform-setup-<版>.exe` です。版は `installer\tkrform.iss` の `AppVersion` で決まります。GitHub Actions でも同じ手順でビルドします（[.github/workflows/build.yml](.github/workflows/build.yml)）。

### Microsoft Store 用の MSIX

リリースビルドのあと、`powershell -File installer\msix\build-msix.ps1` で `.msix` を作ります（手元で試すテスト用の自己署名は `-SelfSign`）。くわしくは [仕様書.md](仕様書.md) の「Microsoft Store 版（MSIX）」を参照してください。

### ブラウザ拡張のストア用の zip

`node tools/pack-extension.mjs` で、`dist/tkrform-extension-<版>.zip` を作ります（`manifest.json` の `key` を外します）。審査の文面の下書きは [docs/extension-store-draft.md](docs/extension-store-draft.md) にあります。ストアで割り当てられた拡張 ID は、`crates/tkrform-ipc/src/proto.rs` の `ALLOWED_EXTENSION_IDS` に足します。

## テスト

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

E2E（Node 24）は `tools/e2e/` にあります。実際のアプリと Chrome を操作します。詳しくは [仕様書.md](仕様書.md) の「テスト方針」を参照してください。

```bash
node tools/e2e/app-ui.mjs     # ウィザード・エディタ・ロック
node tools/e2e/pipe.mjs       # プロトコル、許可リスト、NM ホスト
node tools/e2e/ext.mjs        # 本物の Chrome に拡張を読み込み、自動保存→ロック→解除→自動記入など
```

`TKRFORM_EXE` / `TKRFORM_NMHOST_EXE` で、試験に使う実行ファイルを指定できます。

## プライバシー

TKRForm は、利用者の情報を、利用者が求めたとき以外は、他のネットワーク上のシステムへ送りません。外部と通信するのは、次の場合だけです。くわしくは [プライバシーポリシー（PRIVACY.md）](PRIVACY.md) を参照してください。

- 利用者が設定した同期サーバとの同期（暗号化済みのデータだけを送ります）。
- 更新の確認（`latest.json` の取得。**初期設定はオフ**で、設定でオンにしたときだけ。「今すぐ更新を確認」を押したときも取得します）。
- 漏洩チェック（既定オフ。オンにするとき同意画面を出し、パスワードの SHA-1 の先頭 5 文字だけを送ります）。
- ホームのサイトのアイコンの取得（保存しているサイトのトップページとアイコン画像を、そのサイトへ取りに行くだけ。Cookie は送りません。**初期設定はオフ**で、設定でオンにしたときだけ）。

## コード署名

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org)

署名の方針は [Code signing policy](CODE_SIGNING_POLICY.md) を参照してください。

## ライセンス

[MIT ライセンス](LICENSE)です。著作権者は Takara Syscom（タカラシスコム）です。第三者のデータと依存ライブラリのライセンスは [LICENSES.md](LICENSES.md) を参照してください（Public Suffix List: MPL-2.0 / EFF Large Wordlist: CC-BY 3.0）。

## 商標について

RoboForm は Siber Systems, Inc. の商標です。TKRForm は Siber Systems, Inc. とは関係ありません。1Password、LastPass、Dashlane、Keeper、KeePass、Bitwarden、Chrome、Edge、Windows などの名称は、それぞれの権利者の商標または登録商標です。これらの名称は、インポート元の形式の説明など、必要な箇所だけに使っています。
