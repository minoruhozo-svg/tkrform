# プライバシーポリシー / Privacy Policy

最終更新日 / Last updated: 2026-11-04

対象: TKRForm（Windows アプリ、Microsoft Store 版を含む）と、TKRForm のブラウザ拡張（Chrome / Microsoft Edge）
Applies to: TKRForm (the Windows app, including the Microsoft Store version) and the TKRForm browser extension (Chrome / Microsoft Edge)

[English follows the Japanese text.](#english)

---

## 日本語

### 1. 集めない情報

TKRForm の開発者は、利用者の情報を一切集めません。TKRForm には、利用状況の計測（テレメトリ）、広告、アカウント登録、開発者へのデータの送信はありません。

### 2. 保存する情報と、その場所

- 利用者が保存したログイン（ユーザー ID・パスワードなど）、プロフィール（氏名・住所・電話番号・メールアドレス、勤務先、クレジットカードなどのカードの情報（カード番号・名義・有効期限・セキュリティコード・暗証番号など）を含む）、メモ、パスキー、2 段階認証のキーは、**利用者の PC の中**（`%LOCALAPPDATA%\tkrform`）に、マスターパスワードから作った鍵で暗号化して保存します（AES-256-GCM、PBKDF2-HMAC-SHA256）。
- マスターパスワードそのものは保存しません。開発者を含め、利用者以外は保管庫を開けません。
- Windows Hello を有効にした場合、その鍵は Windows の仕組み（Windows Hello）で保護して、同じ PC の中に保存します。
- バックアップは、暗号化したまま、利用者が選んだフォルダに保存します。

### 3. ブラウザ拡張が扱う情報

ブラウザ拡張は、利用者が開いた Web ページで、ログインやプロフィール（住所・カードの情報など）の記入・保存と、パスワードの生成を行います。そのために、ページの入力欄の内容を読み取り、利用者が保存を選んだときだけ、同じ PC の TKRForm アプリ（Native Messaging）へ渡します。拡張が、ページの内容や閲覧の履歴を、開発者やほかの第三者へ送ることはありません。

### 4. 外部と通信する機能（すべて初期設定はオフ）

次の機能は、利用者が設定でオンにしたときだけ通信します。

| 機能 | 通信先 | 送るもの |
|---|---|---|
| 同期 | 利用者が自分で用意して設定した同期サーバ | 暗号化済みの保管庫のデータ（サーバ側では復号できません） |
| 更新の確認（Microsoft Store 版にはありません。Store が更新します） | 利用者が設定した URL、または同期サーバ | 新しい版の情報（`latest.json`）を取得するだけ。利用者のデータは送りません |
| 漏洩チェック | Have I Been Pwned（`api.pwnedpasswords.com`） | パスワードの SHA-1 ハッシュの先頭 5 文字だけ（パスワードそのものや、どのサイトのものかは送りません） |
| ホームのサイトのアイコン | 利用者が保存している各サイト | そのサイトのトップページとアイコン画像を取得するだけ。Cookie と Referer は送りません |

漏洩チェックは、[Have I Been Pwned のプライバシーポリシー](https://haveibeenpwned.com/Privacy)に従います。同期サーバは利用者が管理するもので、開発者は関与しません。

### 5. 情報の削除

- TKRForm のデータは、すべて利用者の PC の中（`%LOCALAPPDATA%\tkrform`）と、利用者が選んだバックアップのフォルダにあります。設定の「全初期化」で、保管庫と設定を削除できます。
- アンインストールしても、保管庫は残ります（再インストールして続きから使えるように）。不要な場合は、上のフォルダを削除してください。

### 6. 子どもの情報

TKRForm は、子どもを対象にしたものではなく、子どもの情報を意図して集めることはありません（そもそも、開発者は情報を集めません）。

### 7. 変更

このポリシーを変更するときは、このページを更新し、最終更新日を改めます。

### 8. 問い合わせ

ご質問は、GitHub の Issues（https://github.com/minoruhozo-svg/tkrform/issues ）へお寄せください。

---

## English

### 1. Information we do not collect

The developer of TKRForm does not collect any information about you. TKRForm has no telemetry, no advertising, no account registration, and does not send any data to the developer.

### 2. Information stored, and where

- Logins (user IDs, passwords, etc.), identities (name, address, phone number, email address, company, and payment card information such as card number, cardholder name, expiry date, security code and PIN), notes, passkeys and two-factor (TOTP) keys that you save are stored **on your PC** (`%LOCALAPPDATA%\tkrform`), encrypted with a key derived from your master password (AES-256-GCM, PBKDF2-HMAC-SHA256).
- Your master password itself is never stored. No one other than you, including the developer, can open your vault.
- If you enable Windows Hello, the key is protected by Windows Hello and stored on the same PC.
- Backups are stored, still encrypted, in a folder you choose.

### 3. Information handled by the browser extension

The browser extension fills and saves logins and identities (such as addresses and payment card information) and generates passwords on web pages you open. To do so, it reads the form fields on the page and, only when you choose to save, passes them to the TKRForm app on the same PC (via Native Messaging). The extension never sends page content or browsing history to the developer or any other third party.

### 4. Features that communicate over the network (all off by default)

The following features communicate only when you turn them on in Settings.

| Feature | Destination | What is sent |
|---|---|---|
| Sync | A sync server you set up and configure yourself | Encrypted vault data (the server cannot decrypt it) |
| Update check (not present in the Microsoft Store version; the Store handles updates) | A URL you configure, or your sync server | Only fetches version information (`latest.json`); no user data is sent |
| Breach check | Have I Been Pwned (`api.pwnedpasswords.com`) | Only the first 5 characters of the SHA-1 hash of a password (never the password itself or which site it belongs to) |
| Site icons on the home page | Each website you have saved | Only fetches that site's home page and icon image, without cookies or referrer |

The breach check is subject to the [Have I Been Pwned privacy policy](https://haveibeenpwned.com/Privacy). The sync server is operated by you; the developer is not involved.

### 5. Deleting your information

- All TKRForm data is on your PC (`%LOCALAPPDATA%\tkrform`) and in the backup folder you chose. "Reset all" in Settings deletes the vault and settings.
- Uninstalling keeps your vault so that you can continue after reinstalling. If you no longer need it, delete the folder above.

### 6. Children

TKRForm is not directed at children and does not knowingly collect information from children (the developer does not collect information at all).

### 7. Changes

If this policy changes, we will update this page and its "Last updated" date.

### 8. Contact

Please send questions via GitHub Issues: https://github.com/minoruhozo-svg/tkrform/issues
