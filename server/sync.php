<?php
/**
 * tkrform 同期サーバ（フェーズ 2 の雛形）。仕様書 §15。
 *
 * - 単一ファイル。Composer は使わない。ロリポップ（共有レンタルサーバー）で動く PHP 8 + SQLite（PDO）。
 * - サーバが受け取るのは暗号化済みのアイテム blob と最小限のメタ情報だけ（ゼロ知識）。
 *   マスターパスワードや平文は一切届かない。認証には、クライアントが MP から別に導出した authHash を使う。
 * - API: POST sync.php?action=prelogin|register|login|pull|push|changeAuth|logout（ボディは JSON）
 * - エラーは jsonExit(false, "日本語メッセージ") で {"success": false, "message": "..."} を返す。
 *
 * 設置: このファイルを置いたフォルダに data/ が作られる（.htaccess で外部から読めないようにする）。
 */

declare(strict_types=1);

const RATE_LIMIT_PER_MIN = 10;
const TOKEN_DAYS = 30;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_PUSH_ITEMS = 500;
const MIN_ITER = 100000;
const MAX_ITER = 5000000;
const DEFAULT_ITER = 600000;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

/** JSON を返して終了する。 */
function jsonExit(bool $success, string $message = '', array $extra = []): void
{
    $out = array_merge(['success' => $success], $extra);
    if ($message !== '') {
        $out['message'] = $message;
    }
    echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** データフォルダを用意する（外部から読めないようにする）。 */
function dataDir(): string
{
    $dir = __DIR__ . '/data';
    if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
        jsonExit(false, 'データフォルダを作成できません');
    }
    $ht = $dir . '/.htaccess';
    if (!file_exists($ht)) {
        file_put_contents($ht, "Require all denied\n<IfModule !mod_authz_core.c>\nOrder deny,allow\nDeny from all\n</IfModule>\n");
    }
    return $dir;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }
    $pdo = new PDO('sqlite:' . dataDir() . '/tkrform.sqlite');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE, auth_hash TEXT, salt TEXT, iter INTEGER,
                wrapped_key TEXT, head_rev INTEGER DEFAULT 0, created TEXT)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS tokens(token_hash TEXT PRIMARY KEY, user_id INTEGER, expires TEXT)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS items(user_id INTEGER, id TEXT, rev INTEGER, blob TEXT, deleted INTEGER, updated TEXT,
                PRIMARY KEY(user_id, id))');
    $pdo->exec('CREATE INDEX IF NOT EXISTS items_rev ON items(user_id, rev)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS rate(key TEXT, ts INTEGER)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS rate_key ON rate(key, ts)');
    return $pdo;
}

/** 偽の salt を作るための、サーバ固有の秘密。 */
function serverSecret(): string
{
    $f = dataDir() . '/secret.key';
    if (!file_exists($f)) {
        file_put_contents($f, bin2hex(random_bytes(32)));
        @chmod($f, 0600);
    }
    return (string)file_get_contents($f);
}

function clientIp(): string
{
    return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
}

/** IP とメールごとに 1 分 10 回まで。 */
function rateLimit(string $email): void
{
    $pdo = db();
    $now = time();
    $pdo->prepare('DELETE FROM rate WHERE ts < ?')->execute([$now - 3600]);
    foreach (['ip:' . clientIp(), 'mail:' . strtolower($email)] as $key) {
        $st = $pdo->prepare('SELECT COUNT(*) AS n FROM rate WHERE key = ? AND ts > ?');
        $st->execute([$key, $now - 60]);
        if ((int)$st->fetch()['n'] >= RATE_LIMIT_PER_MIN) {
            http_response_code(429);
            jsonExit(false, '試行回数が多すぎます。しばらく待ってからやり直してください');
        }
    }
    foreach (['ip:' . clientIp(), 'mail:' . strtolower($email)] as $key) {
        $pdo->prepare('INSERT INTO rate(key, ts) VALUES(?, ?)')->execute([$key, $now]);
    }
}

/** 入力の検証 */
function str(array $in, string $key, int $max, int $min = 1): string
{
    $v = $in[$key] ?? null;
    if (!is_string($v) || strlen($v) < $min || strlen($v) > $max) {
        jsonExit(false, "入力が正しくありません（{$key}）");
    }
    return $v;
}

function emailOf(array $in): string
{
    $e = strtolower(trim(str($in, 'email', 254)));
    if (!filter_var($e, FILTER_VALIDATE_EMAIL)) {
        jsonExit(false, 'メールアドレスの形式が正しくありません');
    }
    return $e;
}

function iterOf(array $in, string $key = 'iter'): int
{
    $n = $in[$key] ?? null;
    if (!is_int($n) || $n < MIN_ITER || $n > MAX_ITER) {
        jsonExit(false, '反復回数が範囲外です');
    }
    return $n;
}

function b64(string $v, string $what, int $max): string
{
    if (strlen($v) > $max || !preg_match('/^[A-Za-z0-9+\/_\-=]+$/', $v)) {
        jsonExit(false, "形式が正しくありません（{$what}）");
    }
    return $v;
}

function newToken(int $userId): string
{
    $token = bin2hex(random_bytes(32));
    db()->prepare('INSERT INTO tokens(token_hash, user_id, expires) VALUES(?, ?, ?)')
        ->execute([hash('sha256', $token), $userId, gmdate('c', time() + TOKEN_DAYS * 86400)]);
    return $token;
}

/** トークンからユーザー ID を得る。無効なら終了する。 */
function authUser(array $in): int
{
    $t = $in['token'] ?? null;
    if (!is_string($t) || !preg_match('/^[0-9a-f]{64}$/', $t)) {
        jsonExit(false, '認証が必要です');
    }
    $pdo = db();
    $pdo->prepare('DELETE FROM tokens WHERE expires < ?')->execute([gmdate('c')]);
    $st = $pdo->prepare('SELECT user_id FROM tokens WHERE token_hash = ?');
    $st->execute([hash('sha256', $t)]);
    $row = $st->fetch();
    if (!$row) {
        jsonExit(false, 'セッションの有効期限が切れました。もう一度ログインしてください');
    }
    return (int)$row['user_id'];
}

// ---------------------------------------------------------------------- アクション

function actionPrelogin(array $in): void
{
    $email = emailOf($in);
    rateLimit($email);
    $st = db()->prepare('SELECT salt, iter FROM users WHERE email = ?');
    $st->execute([$email]);
    $u = $st->fetch();
    if ($u) {
        jsonExit(true, '', ['salt' => $u['salt'], 'iter' => (int)$u['iter']]);
    }
    // 未登録のメールにも、メールから決定的に作った偽の salt を返す（登録の有無を知られないため）
    $fake = substr(hash_hmac('sha256', $email, serverSecret(), true), 0, 16);
    jsonExit(true, '', ['salt' => rtrim(strtr(base64_encode($fake), '+/', '-_'), '='), 'iter' => DEFAULT_ITER]);
}

function actionRegister(array $in): void
{
    $email = emailOf($in);
    rateLimit($email);
    $auth = b64(str($in, 'authHash', 200, 20), 'authHash', 200);
    $salt = b64(str($in, 'salt', 100, 8), 'salt', 100);
    $iter = iterOf($in);
    $wrapped = b64(str($in, 'wrappedVaultKey', 4096, 20), 'wrappedVaultKey', 4096);
    $pdo = db();
    $st = $pdo->prepare('SELECT id FROM users WHERE email = ?');
    $st->execute([$email]);
    if ($st->fetch()) {
        jsonExit(false, 'このメールアドレスは既に登録されています');
    }
    $pdo->prepare('INSERT INTO users(email, auth_hash, salt, iter, wrapped_key, head_rev, created) VALUES(?, ?, ?, ?, ?, 0, ?)')
        ->execute([$email, password_hash($auth, PASSWORD_DEFAULT), $salt, $iter, $wrapped, gmdate('c')]);
    jsonExit(true, '', ['token' => newToken((int)$pdo->lastInsertId())]);
}

function actionLogin(array $in): void
{
    $email = emailOf($in);
    rateLimit($email);
    $auth = b64(str($in, 'authHash', 200, 20), 'authHash', 200);
    $st = db()->prepare('SELECT * FROM users WHERE email = ?');
    $st->execute([$email]);
    $u = $st->fetch();
    // 存在しないユーザーでも同じ時間をかけて検証する
    $hash = $u ? $u['auth_hash'] : password_hash('dummy', PASSWORD_DEFAULT);
    if (!password_verify($auth, $hash) || !$u) {
        jsonExit(false, 'メールアドレスまたはパスワードが違います');
    }
    jsonExit(true, '', ['token' => newToken((int)$u['id']), 'wrappedVaultKey' => $u['wrapped_key'], 'salt' => $u['salt'], 'iter' => (int)$u['iter']]);
}

function actionPull(array $in): void
{
    $uid = authUser($in);
    $since = $in['sinceRev'] ?? 0;
    if (!is_int($since) || $since < 0) {
        jsonExit(false, 'sinceRev が正しくありません');
    }
    $pdo = db();
    $st = $pdo->prepare('SELECT id, rev, blob, deleted FROM items WHERE user_id = ? AND rev > ? ORDER BY rev LIMIT 1000');
    $st->execute([$uid, $since]);
    $items = array_map(fn($r) => ['id' => $r['id'], 'rev' => (int)$r['rev'], 'blob' => $r['blob'], 'deleted' => (bool)$r['deleted']], $st->fetchAll());
    $h = $pdo->prepare('SELECT head_rev FROM users WHERE id = ?');
    $h->execute([$uid]);
    jsonExit(true, '', ['items' => $items, 'headRev' => (int)$h->fetch()['head_rev']]);
}

function actionPush(array $in): void
{
    $uid = authUser($in);
    $base = $in['baseRev'] ?? null;
    $items = $in['items'] ?? null;
    if (!is_int($base) || $base < 0 || !is_array($items) || count($items) > MAX_PUSH_ITEMS) {
        jsonExit(false, '入力が正しくありません');
    }
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $h = $pdo->prepare('SELECT head_rev FROM users WHERE id = ?');
        $h->execute([$uid]);
        $head = (int)$h->fetch()['head_rev'];
        $conflicts = [];
        $sel = $pdo->prepare('SELECT rev FROM items WHERE user_id = ? AND id = ?');
        $up = $pdo->prepare('INSERT INTO items(user_id, id, rev, blob, deleted, updated) VALUES(?, ?, ?, ?, ?, ?)
                             ON CONFLICT(user_id, id) DO UPDATE SET rev = excluded.rev, blob = excluded.blob, deleted = excluded.deleted, updated = excluded.updated');
        foreach ($items as $it) {
            if (!is_array($it) || !is_string($it['id'] ?? null) || !preg_match('/^[A-Za-z0-9\-]{1,64}$/', $it['id'])
                || !is_string($it['blob'] ?? null) || strlen($it['blob']) > MAX_BLOB_BYTES) {
                throw new RuntimeException('アイテムの形式が正しくありません');
            }
            $sel->execute([$uid, $it['id']]);
            $cur = $sel->fetch();
            // サーバ側の rev が、クライアントの基準（baseRev）より新しければ競合
            if ($cur && (int)$cur['rev'] > $base) {
                $conflicts[] = $it['id'];
                continue;
            }
            $head++;
            $up->execute([$uid, $it['id'], $head, $it['blob'], empty($it['deleted']) ? 0 : 1, gmdate('c')]);
        }
        $pdo->prepare('UPDATE users SET head_rev = ? WHERE id = ?')->execute([$head, $uid]);
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        jsonExit(false, $e instanceof RuntimeException ? $e->getMessage() : '保存に失敗しました');
    }
    jsonExit(true, '', ['headRev' => $head, 'conflicts' => $conflicts]);
}

function actionChangeAuth(array $in): void
{
    $uid = authUser($in);
    $auth = b64(str($in, 'newAuthHash', 200, 20), 'newAuthHash', 200);
    $salt = b64(str($in, 'newSalt', 100, 8), 'newSalt', 100);
    $iter = iterOf($in, 'newIter');
    $wrapped = b64(str($in, 'newWrappedVaultKey', 4096, 20), 'newWrappedVaultKey', 4096);
    $pdo = db();
    $pdo->prepare('UPDATE users SET auth_hash = ?, salt = ?, iter = ?, wrapped_key = ? WHERE id = ?')
        ->execute([password_hash($auth, PASSWORD_DEFAULT), $salt, $iter, $wrapped, $uid]);
    // 送ってきたトークン以外はすべて無効にする
    $pdo->prepare('DELETE FROM tokens WHERE user_id = ? AND token_hash <> ?')->execute([$uid, hash('sha256', (string)$in['token'])]);
    jsonExit(true, '', ['ok' => true]);
}

function actionLogout(array $in): void
{
    $uid = authUser($in);
    db()->prepare('DELETE FROM tokens WHERE user_id = ? AND token_hash = ?')->execute([$uid, hash('sha256', (string)$in['token'])]);
    jsonExit(true, '', ['ok' => true]);
}

// ---------------------------------------------------------------------- 入口

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    jsonExit(false, 'POST で呼び出してください');
}
$raw = file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
if ($raw === false || strlen($raw) > MAX_BODY_BYTES) {
    http_response_code(413);
    jsonExit(false, 'リクエストが大きすぎます');
}
$input = json_decode($raw === '' ? '{}' : $raw, true);
if (!is_array($input)) {
    jsonExit(false, 'JSON の形式が正しくありません');
}

try {
    switch ($_GET['action'] ?? '') {
        case 'prelogin':   actionPrelogin($input); break;
        case 'register':   actionRegister($input); break;
        case 'login':      actionLogin($input); break;
        case 'pull':       actionPull($input); break;
        case 'push':       actionPush($input); break;
        case 'changeAuth': actionChangeAuth($input); break;
        case 'logout':     actionLogout($input); break;
        default:           jsonExit(false, '不明な操作です');
    }
} catch (PDOException $e) {
    error_log('tkrform sync: ' . $e->getMessage());
    jsonExit(false, 'サーバでエラーが発生しました');
}
