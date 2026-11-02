# Code signing policy（コード署名の方針）

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org)

TKRForm の Windows 用の実行ファイルとインストーラは、[SignPath Foundation](https://signpath.org) の OSS 向けプログラムで署名します。この文書は、その署名の方針です。

## 署名するもの

- 署名するのは、**GitHub Actions で、このリポジトリのソースから自動でビルドした成果物だけ**です（[.github/workflows/build.yml](.github/workflows/build.yml)）。手元の PC でビルドしたものには署名しません。
- 対象は、`TKRForm.exe`、`tkrform-nmhost.exe`、インストーラ（`tkrform-setup-<版>.exe`）です。製品名（`TKRForm`）と版は、ビルドのたびに、実行ファイルとインストーラのメタデータに設定します。
- 署名するのは、このリポジトリのソースと、ビルドのスクリプトだけから作ったものです。第三者のバイナリを再署名することはしません。
- インストーラには、アンインストールの手順があります。アンインストール時は、ユーザーデータを消すかどうかを必ず確認します。

## 役割

| 役割 | 内容 | 担当 |
|---|---|---|
| コミッター（Authors） | ソースを、追加の確認なしに変更できる | [@minoruhozo-svg](https://github.com/minoruhozo-svg)（リポジトリの所有者） |
| レビュアー（Reviewers） | コミッター以外からのすべての変更（プルリクエストなど）を確認する | [@minoruhozo-svg](https://github.com/minoruhozo-svg) |
| 承認者（Approvers） | 署名の依頼を、リリースのたびに、手動で承認する | [@minoruhozo-svg](https://github.com/minoruhozo-svg) |

- 担当者の一覧は、リポジトリの所有者または Organization のメンバーのページで公開します（[@minoruhozo-svg](https://github.com/minoruhozo-svg)）。
- コミッター・レビュアー・承認者は、リポジトリと SignPath の両方で、多要素認証を使います。
- 署名は、**リリースのたびに、承認者が手動で承認**してから行います。

## プライバシー

このプログラムは、利用者が求めたとき、または利用者（インストールして使う人）が求めたとき以外は、他のネットワーク上のシステムへ、いかなる情報も送りません（will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it）。

外部と通信するのは、次の場合だけです。

| 通信 | 送るもの | 条件 |
|---|---|---|
| 同期（`server/sync.php`） | 暗号化済みのデータ | 利用者が、自分の同期サーバの URL を設定したとき |
| 更新の確認 | `latest.json` の取得だけ（利用者のデータは送らない） | 既定はオフ。利用者が設定でオンにしたときだけ（「今すぐ更新を確認」を押したときも）。ダウンロードと実行は、同意を得てから行い、SHA-256 を照合する |
| 漏洩チェック（Have I Been Pwned） | パスワードの SHA-1 の先頭 5 文字だけ | 既定はオフ。オンにするとき、同意画面を出す |
| ホームのサイトのアイコン | 保存しているサイトのトップページとアイコン画像を、そのサイトへ取りに行く（Cookie も Referer も付けない） | 既定はオフ。利用者が設定でオンにしたときだけ。ほかのサービスは経由しない |

- マスターパスワードと、保管庫の平文のデータは、PC の外へ出しません。
- 漏洩チェックは、[Have I Been Pwned](https://haveibeenpwned.com/Privacy) のプライバシーポリシーに従います。

## 脆弱性・問題の報告

署名したものに問題があるときは、GitHub の Issues（またはセキュリティアドバイザリ）で報告してください。
