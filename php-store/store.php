<?php
/*
 * ふたりミッション 記録保存用プログラム（コアサーバーなど、PHPが動くレンタルサーバーに置くファイル）
 *
 * - アプリ（Render）から送られてくる「通報の記録」「利用停止の記録」「対応済みの印」を保存します。
 * - 合言葉（STORE_TOKEN）を知っているアプリからの要求だけを受け付けます。
 * - 記録は、このファイルと同じフォルダの data/ に保存します。各ファイルの先頭に
 *   「<?php exit; ?>」を入れているので、ブラウザで直接開かれても中身は表示されません。
 * - 通報の記録は 180 日を過ぎると自動で削除します（プライバシーポリシーの記載どおり）。
 *
 * 動作環境: PHP 7.4 以上（コアサーバーの標準設定で動きます）
 * 通信内容は Base64 で送られてきます（チャットの文章がサーバーの WAF に誤ってブロックされないようにするため）。
 */

// ↓ アプリ（Render の環境変数 STORE_TOKEN）と同じ合言葉。32 文字以上にしてください。
const STORE_TOKEN = '__STORE_TOKEN__';

const RETENTION_DAYS = 180;      // 通報記録の保存期間
const MAX_BODY = 262144;         // 1 回に受け付ける最大サイズ（256KB）
const MAX_REPORTS_RETURNED = 1000;
const GUARD = "<?php exit; ?>\n";

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');

function out($code, $data) {
  http_response_code($code);
  echo json_encode($data, JSON_UNESCAPED_UNICODE);
  exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') out(405, ['ok' => false, 'error' => 'method not allowed']);
if (strlen(STORE_TOKEN) < 32 || STORE_TOKEN === '__STORE' . '_TOKEN__') out(500, ['ok' => false, 'error' => 'STORE_TOKEN is not configured']);
$got = isset($_SERVER['HTTP_X_STORE_TOKEN']) ? (string)$_SERVER['HTTP_X_STORE_TOKEN'] : '';
if (!hash_equals(STORE_TOKEN, $got)) { usleep(300000); out(403, ['ok' => false, 'error' => 'forbidden']); }

$raw = file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
if ($raw === false || strlen($raw) > MAX_BODY) out(413, ['ok' => false, 'error' => 'too large']);
$raw = trim($raw);
if ($raw !== '' && $raw[0] !== '{') {            // Base64-encoded JSON (normal case)
  $dec = base64_decode($raw, true);
  if ($dec === false) out(400, ['ok' => false, 'error' => 'bad encoding']);
  $raw = $dec;
}
$req = json_decode($raw, true);
if (!is_array($req) || !isset($req['action']) || !is_string($req['action'])) out(400, ['ok' => false, 'error' => 'bad request']);

// ---- storage helpers ---------------------------------------------------------
$DIR = __DIR__ . '/data';
if (!is_dir($DIR) && !mkdir($DIR, 0700, true) && !is_dir($DIR)) out(500, ['ok' => false, 'error' => 'cannot create data dir']);
if (!file_exists($DIR . '/.htaccess')) @file_put_contents($DIR . '/.htaccess', "Require all denied\nDeny from all\n");
if (!file_exists($DIR . '/index.html')) @file_put_contents($DIR . '/index.html', '');

function fpath($name) { return __DIR__ . '/data/' . $name . '.php'; }
function now_ms() { return (int) floor(microtime(true) * 1000); }

function read_json($name, $default) {
  $f = fpath($name);
  if (!is_file($f)) return $default;
  $s = (string) file_get_contents($f);
  if (strpos($s, GUARD) === 0) $s = substr($s, strlen(GUARD));
  $v = json_decode($s, true);
  return is_array($v) ? $v : $default;
}
function write_json($name, $value) {
  $json = json_encode((object) $value, JSON_UNESCAPED_UNICODE);
  if (file_put_contents(fpath($name), GUARD . $json, LOCK_EX) === false) out(500, ['ok' => false, 'error' => 'write failed']);
}
function read_reports() {
  $f = fpath('reports');
  if (!is_file($f)) return [];
  $s = (string) file_get_contents($f);
  if (strpos($s, GUARD) === 0) $s = substr($s, strlen(GUARD));
  $out = [];
  foreach (explode("\n", $s) as $line) {
    if ($line === '') continue;
    $r = json_decode($line, true);
    if (is_array($r)) $out[] = $r;
  }
  return $out;
}
function write_reports($list) {
  $s = GUARD;
  foreach ($list as $r) $s .= json_encode($r, JSON_UNESCAPED_UNICODE) . "\n";
  if (file_put_contents(fpath('reports'), $s, LOCK_EX) === false) out(500, ['ok' => false, 'error' => 'write failed']);
}
function report_time($r) {
  if (!isset($r['ts']) || !is_string($r['ts'])) return false;
  return strtotime($r['ts']);
}
function prune_reports() {
  $cut = time() - RETENTION_DAYS * 86400;
  $all = read_reports();
  $keep = [];
  foreach ($all as $r) { $t = report_time($r); if ($t !== false && $t >= $cut) $keep[] = $r; }
  if (count($keep) !== count($all)) write_reports($keep);
  return count($all) - count($keep);
}
function clean_bans($in) {
  $out = []; $now = now_ms();
  if (!is_array($in)) return $out;
  foreach ($in as $k => $v) {
    if (is_string($k) && preg_match('/^[a-f0-9]{24}$/', $k) && is_numeric($v) && (int)$v > $now) $out[$k] = (int) $v;
  }
  return $out;
}
function clean_handled($in) {
  $out = [];
  if (!is_array($in)) return $out;
  foreach ($in as $k => $v) {
    if (is_string($k) && preg_match('/^[A-Za-z0-9]{1,40}$/', $k) && is_numeric($v)) $out[$k] = (int) $v;
  }
  return $out;
}

// ---- actions -------------------------------------------------------------------
switch ($req['action']) {
  case 'ping':
    out(200, ['ok' => true, 'php' => PHP_VERSION]);

  case 'load':
    prune_reports();
    $reports = read_reports();
    if (count($reports) > MAX_REPORTS_RETURNED) $reports = array_slice($reports, -MAX_REPORTS_RETURNED);
    out(200, ['ok' => true, 'reports' => $reports,
      'bans' => (object) clean_bans(read_json('bans', [])),
      'handled' => (object) clean_handled(read_json('handled', []))]);

  case 'append_report':
    $r = $req['report'] ?? null;
    if (!is_array($r) || !isset($r['id']) || !is_string($r['id']) || report_time($r) === false) out(400, ['ok' => false, 'error' => 'bad report']);
    $f = fpath('reports');
    $h = fopen($f, 'c+');
    if (!$h) out(500, ['ok' => false, 'error' => 'open failed']);
    flock($h, LOCK_EX);
    $stat = fstat($h);
    if ($stat['size'] === 0) fwrite($h, GUARD);
    // skip duplicates (the app retries when a request fails midway)
    $body = $stat['size'] > 0 ? stream_get_contents($h, -1, 0) : '';
    if (strpos($body, '"id":' . json_encode($r['id'])) === false) {
      fseek($h, 0, SEEK_END);
      fwrite($h, json_encode($r, JSON_UNESCAPED_UNICODE) . "\n");
    }
    fflush($h); flock($h, LOCK_UN); fclose($h);
    prune_reports();
    out(200, ['ok' => true]);

  case 'save_bans':
    write_json('bans', clean_bans($req['bans'] ?? []));
    out(200, ['ok' => true]);

  case 'save_handled':
    write_json('handled', clean_handled($req['handled'] ?? []));
    out(200, ['ok' => true]);

  case 'prune':
    out(200, ['ok' => true, 'removed' => prune_reports()]);

  default:
    out(400, ['ok' => false, 'error' => 'unknown action']);
}
