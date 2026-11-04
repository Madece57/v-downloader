<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (preg_match('/^chrome-extension:\/\/[a-p]{32}$/', $origin) === 1) {
    header("Access-Control-Allow-Origin: {$origin}");
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

ini_set('session.use_strict_mode', '1');
session_name('vd_admin');
session_set_cookie_params([
    'httponly' => true,
    'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    'samesite' => 'Strict',
    'path' => '/'
]);
session_start();

function respond(int $status, array $payload): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

function request_data(): array
{
    static $data = null;
    if (is_array($data)) {
        return $data;
    }
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return $data = [];
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        respond(400, ['ok' => false, 'error' => 'Invalid JSON request.']);
    }
    return $data = $decoded;
}

function database(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $host = getenv('VD_DB_HOST') ?: '';
    $name = getenv('VD_DB_NAME') ?: '';
    $user = getenv('VD_DB_USER') ?: '';
    $password = getenv('VD_DB_PASSWORD');
    if ($host === '' || $name === '' || $user === '' || $password === false) {
        respond(503, ['ok' => false, 'error' => 'Website database is not configured.']);
    }

    try {
        $pdo = new PDO(
            "mysql:host={$host};dbname={$name};charset=utf8mb4",
            $user,
            $password,
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false
            ]
        );
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS vd_admins (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(254) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
        );
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS vd_ads (
                id VARCHAR(64) NOT NULL PRIMARY KEY,
                title VARCHAR(180) NOT NULL,
                description TEXT NOT NULL,
                type VARCHAR(16) NOT NULL DEFAULT \'text\',
                image_url VARCHAR(2048) NOT NULL DEFAULT "",
                click_url VARCHAR(2048) NOT NULL DEFAULT "",
                duration SMALLINT UNSIGNED NOT NULL DEFAULT 5,
                active TINYINT(1) NOT NULL DEFAULT 1,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX vd_ads_active (active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
        );
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS vd_ad_stats (
                id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
                impressions BIGINT UNSIGNED NOT NULL DEFAULT 0,
                completions BIGINT UNSIGNED NOT NULL DEFAULT 0,
                clicks BIGINT UNSIGNED NOT NULL DEFAULT 0,
                credits_used BIGINT UNSIGNED NOT NULL DEFAULT 0
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
        );
        $pdo->exec('INSERT IGNORE INTO vd_ad_stats (id) VALUES (1)');
        return $pdo;
    } catch (Throwable $error) {
        error_log('[Video Downloader] Database initialization failed: ' . $error->getMessage());
        respond(503, ['ok' => false, 'error' => 'Website database is unavailable.']);
    }
}

function require_admin(): int
{
    $adminId = (int)($_SESSION['admin_id'] ?? 0);
    if ($adminId <= 0) {
        respond(401, ['ok' => false, 'error' => 'Sign in to continue.']);
    }
    return $adminId;
}

function require_csrf(): void
{
    $data = request_data();
    $csrf = (string)($data['csrf'] ?? '');
    if ($csrf === '' || !hash_equals((string)($_SESSION['csrf'] ?? ''), $csrf)) {
        respond(403, ['ok' => false, 'error' => 'Your session expired. Sign in again.']);
    }
}

function safe_url(mixed $value, string $field): string
{
    $url = trim((string)$value);
    if ($url === '') {
        return '';
    }
    if (strlen($url) > 2048 || filter_var($url, FILTER_VALIDATE_URL) === false) {
        respond(400, ['ok' => false, 'error' => "Enter a valid {$field} URL."]);
    }
    $scheme = strtolower((string)parse_url($url, PHP_URL_SCHEME));
    if ($scheme !== 'http' && $scheme !== 'https') {
        respond(400, ['ok' => false, 'error' => "{$field} must use HTTP or HTTPS."]);
    }
    return $url;
}

$action = (string)($_GET['action'] ?? '');
$method = (string)($_SERVER['REQUEST_METHOD'] ?? 'GET');
$pdo = database();

if ($action === 'status' && $method === 'GET') {
    $setup = $pdo->query('SELECT id FROM vd_admins LIMIT 1')->fetch() === false;
    respond(200, [
        'ok' => true,
        'setupRequired' => $setup,
        'setupEnabled' => $setup && (getenv('VD_ADMIN_SETUP_TOKEN') ?: '') !== '',
        'authenticated' => (int)($_SESSION['admin_id'] ?? 0) > 0,
        'csrf' => $_SESSION['csrf'] ?? ''
    ]);
}

if ($action === 'ads' && $method === 'GET') {
    $rows = $pdo->query(
        'SELECT id, title, description, type, image_url, click_url, duration, active,
                UNIX_TIMESTAMP(created_at) * 1000 AS created_at
         FROM vd_ads WHERE active = 1 ORDER BY created_at DESC'
    )->fetchAll();
    $ads = array_map(static function (array $row): array {
        return [
            'id' => $row['id'],
            'title' => $row['title'],
            'description' => $row['description'],
            'type' => $row['type'],
            'imageUrl' => $row['image_url'],
            'clickUrl' => $row['click_url'],
            'duration' => (int)$row['duration'],
            'active' => (bool)$row['active'],
            'createdAt' => (int)$row['created_at']
        ];
    }, $rows);
    respond(200, ['ok' => true, 'ads' => $ads]);
}

if ($action === 'event' && $method === 'POST') {
    $data = request_data();
    $columns = [
        'impression' => 'impressions',
        'completion' => 'completions',
        'click' => 'clicks',
        'credit' => 'credits_used'
    ];
    $type = (string)($data['type'] ?? '');
    if (!isset($columns[$type])) {
        respond(400, ['ok' => false, 'error' => 'Unsupported event type.']);
    }
    $column = $columns[$type];
    $statement = $pdo->prepare("UPDATE vd_ad_stats SET {$column} = {$column} + 1 WHERE id = 1");
    $statement->execute();
    respond(200, ['ok' => true]);
}

if ($action === 'setup' && $method === 'POST') {
    $data = request_data();
    $setupToken = getenv('VD_ADMIN_SETUP_TOKEN') ?: '';
    if ($setupToken === '' || !hash_equals($setupToken, (string)($data['setupToken'] ?? ''))) {
        respond(403, ['ok' => false, 'error' => 'The setup token is invalid or setup is disabled.']);
    }
    $email = filter_var(trim((string)($data['email'] ?? '')), FILTER_VALIDATE_EMAIL);
    $password = (string)($data['password'] ?? '');
    if ($email === false || strlen($password) < 12 || strlen($password) > 200) {
        respond(400, ['ok' => false, 'error' => 'Use a valid email and a password of at least 12 characters.']);
    }
    $lock = (int)$pdo->query("SELECT GET_LOCK('vd_admin_initial_setup', 5)")->fetchColumn();
    if ($lock !== 1) {
        respond(503, ['ok' => false, 'error' => 'Could not acquire the initial setup lock. Try again.']);
    }
    try {
        if ($pdo->query('SELECT id FROM vd_admins LIMIT 1')->fetch() !== false) {
            respond(409, ['ok' => false, 'error' => 'Admin setup has already been completed.']);
        }
        $statement = $pdo->prepare('INSERT INTO vd_admins (email, password_hash) VALUES (?, ?)');
        $statement->execute([$email, password_hash($password, PASSWORD_DEFAULT)]);
        $adminId = (int)$pdo->lastInsertId();
        $pdo->prepare(
            'INSERT IGNORE INTO vd_ads (id, title, description, type, duration, active)
             VALUES (?, ?, ?, \'text\', 5, 1)'
        )->execute([
            'welcome_ad',
            'Welcome',
            'Manage this message in the website admin panel.'
        ]);
        session_regenerate_id(true);
        $_SESSION['admin_id'] = $adminId;
        $_SESSION['email'] = $email;
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        respond(200, ['ok' => true, 'csrf' => $_SESSION['csrf']]);
    } finally {
        $pdo->query("SELECT RELEASE_LOCK('vd_admin_initial_setup')");
    }
}

if ($action === 'login' && $method === 'POST') {
    $data = request_data();
    $email = trim((string)($data['email'] ?? ''));
    $statement = $pdo->prepare('SELECT id, email, password_hash FROM vd_admins WHERE email = ? LIMIT 1');
    $statement->execute([$email]);
    $admin = $statement->fetch();
    if (!$admin || !password_verify((string)($data['password'] ?? ''), $admin['password_hash'])) {
        respond(401, ['ok' => false, 'error' => 'Email or password is incorrect.']);
    }
    session_regenerate_id(true);
    $_SESSION['admin_id'] = (int)$admin['id'];
    $_SESSION['email'] = $admin['email'];
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
    respond(200, ['ok' => true, 'csrf' => $_SESSION['csrf'], 'email' => $admin['email']]);
}

if ($action === 'logout' && $method === 'POST') {
    require_admin();
    require_csrf();
    $_SESSION = [];
    session_regenerate_id(true);
    respond(200, ['ok' => true]);
}

require_admin();

if ($method !== 'POST') {
    respond(405, ['ok' => false, 'error' => 'Method not allowed.']);
}
require_csrf();
$data = request_data();

if ($action === 'stats') {
    $stats = $pdo->query(
        'SELECT impressions, completions, clicks, credits_used FROM vd_ad_stats WHERE id = 1'
    )->fetch();
    respond(200, [
        'ok' => true,
        'stats' => [
            'impressions' => (int)$stats['impressions'],
            'completions' => (int)$stats['completions'],
            'clicks' => (int)$stats['clicks'],
            'creditsUsed' => (int)$stats['credits_used']
        ]
    ]);
}

if ($action === 'admin-ads') {
    $rows = $pdo->query(
        'SELECT id, title, description, type, image_url, click_url, duration, active,
                UNIX_TIMESTAMP(created_at) * 1000 AS created_at
         FROM vd_ads ORDER BY created_at DESC'
    )->fetchAll();
    $ads = array_map(static function (array $row): array {
        return [
            'id' => $row['id'],
            'title' => $row['title'],
            'description' => $row['description'],
            'type' => $row['type'],
            'imageUrl' => $row['image_url'],
            'clickUrl' => $row['click_url'],
            'duration' => (int)$row['duration'],
            'active' => (bool)$row['active'],
            'createdAt' => (int)$row['created_at']
        ];
    }, $rows);
    respond(200, ['ok' => true, 'ads' => $ads]);
}

if ($action === 'save-ad') {
    $id = trim((string)($data['id'] ?? ''));
    $title = trim((string)($data['title'] ?? ''));
    $description = trim((string)($data['description'] ?? ''));
    $type = (string)($data['type'] ?? 'text');
    $imageUrl = safe_url($data['imageUrl'] ?? '', 'image');
    $clickUrl = safe_url($data['clickUrl'] ?? '', 'click');
    $duration = filter_var($data['duration'] ?? 5, FILTER_VALIDATE_INT);
    if ($title === '' || strlen($title) > 180 || !in_array($type, ['image', 'text'], true)) {
        respond(400, ['ok' => false, 'error' => 'Enter a title and select a valid ad type.']);
    }
    if ($duration === false || $duration < 1 || $duration > 60) {
        respond(400, ['ok' => false, 'error' => 'Ad duration must be from 1 to 60 seconds.']);
    }
    if ($type === 'image' && $imageUrl === '') {
        respond(400, ['ok' => false, 'error' => 'Image ads need an image URL.']);
    }
    $isUpdate = $id !== '';
    if (!$isUpdate) {
        $id = bin2hex(random_bytes(16));
        $statement = $pdo->prepare(
            'INSERT INTO vd_ads (id, title, description, type, image_url, click_url, duration, active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
    } else {
        $statement = $pdo->prepare(
            'UPDATE vd_ads SET title = ?, description = ?, type = ?, image_url = ?, click_url = ?,
             duration = ?, active = ? WHERE id = ?'
        );
    }
    $values = [
        $title,
        $description,
        $type,
        $imageUrl,
        $clickUrl,
        $duration,
        !empty($data['active']) ? 1 : 0
    ];
    if ($isUpdate) {
        $values[] = $id;
    } else {
        array_unshift($values, $id);
    }
    $statement->execute($values);
    respond(200, ['ok' => true, 'id' => $id]);
}

if ($action === 'delete-ad') {
    $id = trim((string)($data['id'] ?? ''));
    if ($id === '') {
        respond(400, ['ok' => false, 'error' => 'An ad ID is required.']);
    }
    $statement = $pdo->prepare('DELETE FROM vd_ads WHERE id = ?');
    $statement->execute([$id]);
    respond(200, ['ok' => true]);
}

if ($action === 'change-password') {
    $statement = $pdo->prepare('SELECT password_hash FROM vd_admins WHERE id = ?');
    $statement->execute([require_admin()]);
    $admin = $statement->fetch();
    $current = (string)($data['currentPassword'] ?? '');
    $next = (string)($data['newPassword'] ?? '');
    if (!$admin || !password_verify($current, $admin['password_hash'])) {
        respond(401, ['ok' => false, 'error' => 'Current password is incorrect.']);
    }
    if (strlen($next) < 12 || strlen($next) > 200) {
        respond(400, ['ok' => false, 'error' => 'New password must be at least 12 characters.']);
    }
    $update = $pdo->prepare('UPDATE vd_admins SET password_hash = ? WHERE id = ?');
    $update->execute([password_hash($next, PASSWORD_DEFAULT), (int)$_SESSION['admin_id']]);
    respond(200, ['ok' => true]);
}

respond(404, ['ok' => false, 'error' => 'Unknown API action.']);
