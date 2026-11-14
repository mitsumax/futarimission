'use strict';
/**
 * ふたりミッション — server
 * Zero-dependency Node.js (>=18). Serves ./public and a WebSocket endpoint at /ws.
 *
 * Env:
 *   PORT              listen port (default 3000)
 *   HOST              listen host (default 0.0.0.0)
 *   TRUST_PROXY=1     use X-Forwarded-For for client IP (set when behind Render/Fly/nginx)
 *   ALLOWED_ORIGINS   comma-separated origins allowed to open /ws (default: same host only)
 *   HASH_SALT         salt for hashing IPs/tokens in report logs (set a long random value!)
 *   ADMIN_TOKEN       enables GET /admin/stats and /admin/reports with header "x-admin-token"
 *   DATA_DIR          where reports.jsonl / bans.json are written (default ./data)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { handleUpgrade } = require('./lib/ws');
const games = require('./lib/games');
const { checkChat, cleanName } = require('./lib/filter');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const HASH_SALT = process.env.HASH_SALT || crypto.randomBytes(16).toString('hex');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- tunables ----
const RECONNECT_GRACE_MS = 20_000;   // keep a pair alive while a phone briefly drops
const HEARTBEAT_MS = 25_000;
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP) || 30; // mobile carriers share IPs (CGNAT)
const CHAT_BURST = 5, CHAT_WINDOW_MS = 6_000;  // max 5 messages per 6s
const ACT_BURST = 20, ACT_WINDOW_MS = 4_000;
const REPORTS_TO_BAN = 3;            // distinct reporters within 24h → temporary ban
const BAN_MS = 24 * 3600_000;
const AVOID_REMATCH_MS = 3 * 60_000; // don't re-pair the same two people right away

fs.mkdirSync(DATA_DIR, { recursive: true });
const hash = (v) => crypto.createHash('sha256').update(HASH_SALT + '|' + v).digest('hex').slice(0, 24);
const uid = () => crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

// ---------------------------------------------------------------- moderation
const bans = new Map();          // ipHash -> until
const reportsAgainst = new Map(); // ipHash -> [{by, ts}]
try {
  const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'bans.json'), 'utf8'));
  for (const [k, v] of Object.entries(saved)) if (v > now()) bans.set(k, v);
} catch (e) { /* none yet */ }
function saveBans() {
  const o = {}; for (const [k, v] of bans) if (v > now()) o[k] = v;
  fs.writeFile(path.join(DATA_DIR, 'bans.json'), JSON.stringify(o), () => {});
}
const isBanned = (ipHash) => (bans.get(ipHash) || 0) > now();

// ---------------------------------------------------------------- state
const players = new Map();  // token -> player
const queue = new Set();    // players waiting
const pairs = new Map();    // pairId -> pair
const connsPerIp = new Map();

/*
 player = { token, name, g, ws, ip, ipHash, state:'idle'|'wait'|'paired', pair, role,
            blocked:Set<token>, recent:Map<token,until>, chatTimes:[], actTimes:[], graceTimer }
 pair   = { id, a, b, S, log:[{role,text,ts}] }
*/

function send(p, msg) { if (p && p.ws && !p.ws.closed) p.ws.send(JSON.stringify(msg)); }
function partnerOf(p) { if (!p.pair) return null; return p.role === 'a' ? p.pair.b : p.pair.a; }
function publicInfo(p) { return { name: p.name, g: p.g }; }

function pushView(pair) {
  for (const role of ['a', 'b']) send(pair[role], { t: 'view', view: games.view(pair.S, role) });
}
function sysBoth(pair, text) { for (const role of ['a', 'b']) send(pair[role], { t: 'sys', text }); }

function broadcastStats() {
  const msg = JSON.stringify({ t: 'stats', waiting: queue.size, online: [...players.values()].filter((p) => p.ws && !p.ws.closed).length });
  for (const p of players.values()) if (p.state === 'wait' && p.ws && !p.ws.closed) p.ws.send(msg);
}

// ---------------------------------------------------------------- matching (gender-blind, random)
function canPair(x, y) {
  if (x === y) return false;
  if (x.blocked.has(y.token) || y.blocked.has(x.token)) return false;
  if ((x.recent.get(y.token) || 0) > now() || (y.recent.get(x.token) || 0) > now()) return false;
  return true;
}
function runMatcher() {
  const waiting = [...queue].filter((p) => p.ws && !p.ws.closed);
  for (let i = waiting.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [waiting[i], waiting[j]] = [waiting[j], waiting[i]]; }
  const used = new Set();
  for (const x of waiting) {
    if (used.has(x)) continue;
    const y = waiting.find((c) => !used.has(c) && canPair(x, c));
    if (!y) continue;
    used.add(x); used.add(y);
    makePair(x, y);
  }
  broadcastStats();
}
setInterval(runMatcher, 1000);

function makePair(a, b) {
  queue.delete(a); queue.delete(b);
  const pair = { id: uid(), a, b, S: games.newPairState(), log: [] };
  pairs.set(pair.id, pair);
  for (const [p, role] of [[a, 'a'], [b, 'b']]) { p.state = 'paired'; p.pair = pair; p.role = role; }
  send(a, { t: 'matched', partner: publicInfo(b) });
  send(b, { t: 'matched', partner: publicInfo(a) });
  pushView(pair);
}

function endPair(pair, leaver, reason) {
  if (!pairs.has(pair.id)) return;
  pairs.delete(pair.id);
  for (const p of [pair.a, pair.b]) {
    const q = p === pair.a ? pair.b : pair.a;
    p.recent.set(q.token, now() + AVOID_REMATCH_MS);
    p.pair = null; p.role = null; p.state = 'idle';
    if (p !== leaver) send(p, { t: 'partner_left', reason });
  }
}

// ---------------------------------------------------------------- message handling
function rateOk(arr, burst, windowMs) {
  const t = now();
  while (arr.length && arr[0] < t - windowMs) arr.shift();
  if (arr.length >= burst) return false;
  arr.push(t); return true;
}

function onMessage(p, raw) {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'profile': {
      const name = cleanName(m.name);
      if (!name) return send(p, { t: 'error', code: 'name', text: 'そのニックネームは使えません（連絡先や不適切な言葉は使えません）' });
      p.name = name;
      p.g = ['m', 'f', 'n'].includes(m.g) ? m.g : 'n';
      return send(p, { t: 'profile_ok', name: p.name, g: p.g });
    }
    case 'search': {
      if (!p.name) return send(p, { t: 'error', code: 'name', text: 'ニックネームを設定してください' });
      if (p.state !== 'idle') return;
      p.state = 'wait'; queue.add(p);
      send(p, { t: 'searching' });
      return runMatcher();
    }
    case 'cancel': {
      if (p.state === 'wait') { queue.delete(p); p.state = 'idle'; }
      return broadcastStats();
    }
    case 'act': {
      if (p.state !== 'paired' || !p.pair) return;
      if (!rateOk(p.actTimes, ACT_BURST, ACT_WINDOW_MS)) return;
      const res = games.apply(p.pair.S, p.role, m.a);
      if (res.changed) { pushView(p.pair); for (const n of res.notes) sysBoth(p.pair, n); }
      return;
    }
    case 'chat': {
      if (p.state !== 'paired' || !p.pair || typeof m.text !== 'string') return;
      const text = m.text.normalize('NFC').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 200);
      if (!text) return;
      if (!rateOk(p.chatTimes, CHAT_BURST, CHAT_WINDOW_MS)) return send(p, { t: 'chat_rejected', id: m.id, text: '送信が速すぎます。少し待ってから送ってください' });
      const why = checkChat(text);
      if (why) return send(p, { t: 'chat_rejected', id: m.id, text: why });
      const ts = now();
      p.pair.log.push({ role: p.role, text, ts }); if (p.pair.log.length > 40) p.pair.log.shift();
      send(p, { t: 'chat', from: 'me', id: m.id, text, ts });
      send(partnerOf(p), { t: 'chat', from: 'partner', text, ts });
      return;
    }
    case 'leave': {
      if (p.state === 'wait') { queue.delete(p); p.state = 'idle'; }
      if (p.pair) {
        const q = partnerOf(p);
        if (m.block && q) p.blocked.add(q.token);
        endPair(p.pair, p, m.block ? 'blocked' : 'left');
      }
      send(p, { t: 'left' });
      return;
    }
    case 'report': {
      if (!p.pair) return;
      const q = partnerOf(p);
      const reason = String(m.reason || '').slice(0, 300);
      const entry = {
        ts: new Date().toISOString(), pairId: p.pair.id,
        reporter: hash('t:' + p.token), reported: hash('t:' + q.token), reportedIp: q.ipHash,
        reportedName: q.name, reason,
        // the recent conversation is kept ONLY in memory during a pair; it is written only when someone reports
        log: p.pair.log.map((l) => ({ who: l.role === p.role ? 'reporter' : 'reported', text: l.text, ts: l.ts })),
      };
      fs.appendFile(path.join(DATA_DIR, 'reports.jsonl'), JSON.stringify(entry) + '\n', () => {});
      const list = (reportsAgainst.get(q.ipHash) || []).filter((r) => r.ts > now() - BAN_MS && r.by !== p.ipHash);
      list.push({ by: p.ipHash, ts: now() });
      reportsAgainst.set(q.ipHash, list);
      p.blocked.add(q.token);
      endPair(p.pair, p, 'blocked');
      send(p, { t: 'left', reported: true });
      if (new Set(list.map((r) => r.by)).size >= REPORTS_TO_BAN) {
        bans.set(q.ipHash, now() + BAN_MS); saveBans();
        for (const x of players.values()) if (x.ipHash === q.ipHash && x.ws) { send(x, { t: 'banned' }); x.ws.close(4003); }
      }
      return;
    }
    case 'ping': return send(p, { t: 'pong' });
    default:
  }
}

// ---------------------------------------------------------------- connection lifecycle
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || 'unknown';
}

function attach(ws, req, token) {
  const ip = clientIp(req), ipHash = hash('ip:' + ip);
  if (isBanned(ipHash)) { ws.send(JSON.stringify({ t: 'banned' })); return ws.close(4003); }
  const n = (connsPerIp.get(ip) || 0) + 1;
  if (n > MAX_CONN_PER_IP) { ws.send(JSON.stringify({ t: 'error', code: 'busy', text: '接続数が多すぎます' })); return ws.close(4008); }
  connsPerIp.set(ip, n);

  let p = /^[a-f0-9]{32}$/.test(token || '') ? players.get(token) : null;
  let resumed = false;
  if (p) {
    // resume (same browser reconnecting)
    if (p.ws && !p.ws.closed) { send(p, { t: 'replaced' }); p.ws.close(4001); }
    clearTimeout(p.graceTimer); p.graceTimer = null;
    p.ws = ws; p.ip = ip; p.ipHash = ipHash; resumed = true;
  } else {
    token = crypto.randomBytes(16).toString('hex');
    p = { token, name: '', g: 'n', ws, ip, ipHash, state: 'idle', pair: null, role: null,
      blocked: new Set(), recent: new Map(), chatTimes: [], actTimes: [], graceTimer: null };
    players.set(token, p);
  }

  send(p, { t: 'hello', token: p.token, name: p.name, g: p.g, state: p.state, resumed });
  if (p.state === 'paired' && p.pair) {
    const q = partnerOf(p);
    send(p, { t: 'matched', partner: publicInfo(q), resumed: true });
    send(p, { t: 'view', view: games.view(p.pair.S, p.role) });
    send(q, { t: 'partner_back' });
  } else if (p.state === 'wait') {
    queue.add(p); send(p, { t: 'searching' });
  }

  ws.on('message', (raw) => { try { onMessage(p, raw); } catch (e) { console.error('handler error', e); } });
  ws.on('close', () => {
    const c = (connsPerIp.get(ip) || 1) - 1; if (c <= 0) connsPerIp.delete(ip); else connsPerIp.set(ip, c);
    if (p.ws !== ws) return; // replaced by a newer connection
    queue.delete(p);
    if (p.state === 'paired' && p.pair) send(partnerOf(p), { t: 'partner_away' });
    p.graceTimer = setTimeout(() => {
      if (p.ws !== ws) return;
      if (p.pair) endPair(p.pair, p, 'disconnected');
      if (p.state === 'wait') p.state = 'idle';
      players.delete(p.token);
      broadcastStats();
    }, RECONNECT_GRACE_MS);
    broadcastStats();
  });
}

// heartbeat: drop dead sockets (phones that vanished without closing)
setInterval(() => {
  for (const p of players.values()) {
    const ws = p.ws; if (!ws || ws.closed) continue;
    if (!ws.isAlive) { ws.close(1001); continue; }
    ws.ping();
  }
}, HEARTBEAT_MS);

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'",
};

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, SEC_HEADERS); return res.end('not found'); }
    const ext = path.extname(file);
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  });
}

function adminOk(req) { return ADMIN_TOKEN && req.headers['x-admin-token'] === ADMIN_TOKEN; }

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (req.url.startsWith('/admin/')) {
    if (!adminOk(req)) { res.writeHead(404); return res.end(); }
    if (req.url === '/admin/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ players: players.size, waiting: queue.size, pairs: pairs.size, bans: [...bans.values()].filter((v) => v > now()).length }));
    }
    if (req.url === '/admin/reports') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      return fs.createReadStream(path.join(DATA_DIR, 'reports.jsonl')).on('error', () => res.end('')).pipe(res);
    }
    res.writeHead(404); return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res);
});

server.on('upgrade', (req, socket) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { return socket.destroy(); }
  if (u.pathname !== '/ws') return socket.destroy();
  const origin = req.headers.origin;
  if (origin) {
    let ok;
    if (ALLOWED_ORIGINS.length) ok = ALLOWED_ORIGINS.includes(origin);
    else { try { ok = new URL(origin).host === req.headers.host; } catch (e) { ok = false; } }
    if (!ok) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  }
  const ws = handleUpgrade(req, socket, { maxPayload: 8 * 1024 });
  if (ws) attach(ws, req, u.searchParams.get('token'));
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`ふたりミッション server: http://localhost:${PORT}`));
}

module.exports = { server, _state: { players, queue, pairs } };
