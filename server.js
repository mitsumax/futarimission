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
 *   ADMIN_TOKEN       enables the admin page at /admin (enter this token there)
 *   DATA_DIR          where reports.jsonl / bans.json are written (default ./data)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { handleUpgrade } = require('./ws');
const games = require('./games');
const { checkChat, cleanName } = require('./filter');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const HASH_SALT = process.env.HASH_SALT || crypto.randomBytes(16).toString('hex');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));

// ---- tunables ----
const RECONNECT_GRACE_MS = 20_000;   // keep a pair alive while a phone briefly drops
const HEARTBEAT_MS = 25_000;
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP) || 30; // mobile carriers share IPs (CGNAT)
const CHAT_BURST = 5, CHAT_WINDOW_MS = 6_000;  // max 5 messages per 6s
const ACT_BURST = 20, ACT_WINDOW_MS = 4_000;
const REPORTS_TO_BAN = 3;            // distinct reporters within 24h → temporary ban
const BAN_MS = 24 * 3600_000;
const ROOM_TTL_MS = 30 * 60_000;     // an unused invite expires after 30 min
const ROOM_LOOKUPS = 12, ROOM_LOOKUP_WINDOW_MS = 60_000; // code guesses per player per minute
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const PREFER_NEW_MS = 3 * 60_000;   // for 3 min, prefer someone new — but rematch if nobody else is waiting

fs.mkdirSync(DATA_DIR, { recursive: true });
const STAMPS = ['fun', 'team', 'thanks', 'again'];
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
const rooms = new Map();    // code -> { code, host, created }  (private rooms for inviting a friend)
const pairs = new Map();    // pairId -> pair
const connsPerIp = new Map();

/*
 player = { token, name, g, ws, ip, ipHash, state:'idle'|'wait'|'hosting'|'paired', pair, role, room,
            blocked:Set<token>, recent:Map<token,until>, chatTimes:[], actTimes:[], graceTimer }
 pair   = { id, a, b, S, log:[{role,text,ts}] }
*/

function send(p, msg) { if (p && p.ws && !p.ws.closed) p.ws.send(JSON.stringify(msg)); }
function partnerOf(p) { if (!p.pair) return null; return p.role === 'a' ? p.pair.b : p.pair.a; }
function publicInfo(p) { return { name: p.name }; }   // gender is not collected or shown

function pushView(pair) {
  const t = now();
  for (const role of ['a', 'b']) send(pair[role], { t: 'view', view: games.view(pair.S, role, t) });
}
function sysBoth(pair, text) { for (const role of ['a', 'b']) send(pair[role], { t: 'sys', text }); }

function broadcastStats() {
  const msg = JSON.stringify({ t: 'stats', waiting: queue.size, online: [...players.values()].filter((p) => p.ws && !p.ws.closed).length });
  for (const p of players.values()) if (p.state === 'wait' && p.ws && !p.ws.closed) p.ws.send(msg);
}

// ---------------------------------------------------------------- matching (gender-blind, random)
// Only a block prevents a match. Same IP / same Wi-Fi / previous partner are all allowed.
function canPair(x, y) {
  if (x === y) return false;
  if (x.blocked.has(y.token) || y.blocked.has(x.token)) return false;
  return true;
}
const playedRecently = (x, y) => (x.recent.get(y.token) || 0) > now() || (y.recent.get(x.token) || 0) > now();
function runMatcher() {
  const waiting = [...queue].filter((p) => p.ws && !p.ws.closed);
  for (let i = waiting.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [waiting[i], waiting[j]] = [waiting[j], waiting[i]]; }
  const used = new Set();
  for (const x of waiting) {
    if (used.has(x)) continue;
    const free = waiting.filter((c) => !used.has(c) && canPair(x, c));
    const y = free.find((c) => !playedRecently(x, c)) || free[0];   // someone new first, else the previous partner
    if (!y) continue;
    used.add(x); used.add(y);
    makePair(x, y);
  }
  broadcastStats();
}
setInterval(runMatcher, 1000);

// time limits (お絵かき伝言)
setInterval(() => {
  const t = now();
  for (const pair of pairs.values()) {
    const res = games.tick(pair.S, t);
    if (res.changed) { pushView(pair); for (const n of res.notes) sysBoth(pair, n); }
  }
}, 500);

function makePair(a, b) {
  queue.delete(a); queue.delete(b);
  const pair = { id: uid(), a, b, S: games.newPairState(), log: [] };
  pairs.set(pair.id, pair);
  for (const [p, role] of [[a, 'a'], [b, 'b']]) { p.state = 'paired'; p.pair = pair; p.role = role; }
  send(a, { t: 'matched', partner: publicInfo(b) });
  send(b, { t: 'matched', partner: publicInfo(a) });
  pushView(pair);
}

// ---------------------------------------------------------------- private rooms
function newRoomCode() {
  for (;;) {
    let c = '';
    const bytes = crypto.randomBytes(6);
    for (const b of bytes) c += ROOM_ALPHABET[b % ROOM_ALPHABET.length];
    if (!rooms.has(c)) return c;
  }
}
const normCode = (c) => String(c || '').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
function closeRoom(p) {
  if (p.room) { rooms.delete(p.room); p.room = null; }
  if (p.state === 'hosting') p.state = 'idle';
}
setInterval(() => {
  for (const r of rooms.values()) {
    if (r.created + ROOM_TTL_MS < now()) { closeRoom(r.host); send(r.host, { t: 'room_expired' }); }
  }
}, 30_000);

function endPair(pair, leaver, reason) {
  if (!pairs.has(pair.id)) return;
  pairs.delete(pair.id);
  for (const p of [pair.a, pair.b]) {
    const q = p === pair.a ? pair.b : pair.a;
    p.recent.set(q.token, now() + PREFER_NEW_MS);
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
      return send(p, { t: 'profile_ok', name: p.name });
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
      if (p.state === 'hosting') closeRoom(p);
      return broadcastStats();
    }
    case 'host': {   // create a private room and get an invite code
      if (!p.name) return send(p, { t: 'error', code: 'name', text: 'ニックネームを設定してください' });
      if (p.state === 'hosting' && p.room) return send(p, { t: 'hosting', code: p.room });
      if (p.state !== 'idle') return;
      const code = newRoomCode();
      rooms.set(code, { code, host: p, created: now() });
      p.state = 'hosting'; p.room = code;
      return send(p, { t: 'hosting', code });
    }
    case 'room_info': {   // who invited me? (works before choosing a nickname)
      if (!rateOk(p.roomTimes || (p.roomTimes = []), ROOM_LOOKUPS, ROOM_LOOKUP_WINDOW_MS)) return send(p, { t: 'room_info', ok: false, reason: 'busy' });
      const r = rooms.get(normCode(m.code));
      if (!r || !r.host.ws || r.host.ws.closed || r.host === p) return send(p, { t: 'room_info', ok: false });
      return send(p, { t: 'room_info', ok: true, code: r.code, host: r.host.name });
    }
    case 'join_room': {
      if (!p.name) return send(p, { t: 'error', code: 'name', text: 'ニックネームを設定してください' });
      if (p.state !== 'idle') return;
      if (!rateOk(p.roomTimes || (p.roomTimes = []), ROOM_LOOKUPS, ROOM_LOOKUP_WINDOW_MS))
        return send(p, { t: 'room_error', text: '試した回数が多すぎます。1分ほど待ってからもう一度どうぞ' });
      const code = normCode(m.code);
      const r = rooms.get(code);
      if (!r || r.host === p || r.host.state !== 'hosting' || !r.host.ws || r.host.ws.closed || !canPair(r.host, p))
        return send(p, { t: 'room_error', text: 'その部屋は見つかりませんでした。コードを確かめるか、招待した人にもう一度リンクを送ってもらってください' });
      const host = r.host;
      closeRoom(host);
      return makePair(host, p);
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
      const why = games.chatGuard(p.pair.S, p.role, text) || checkChat(text);
      if (why) return send(p, { t: 'chat_rejected', id: m.id, text: why });
      const ts = now();
      p.pair.log.push({ role: p.role, text, ts }); if (p.pair.log.length > 40) p.pair.log.shift();
      send(p, { t: 'chat', from: 'me', id: m.id, text, ts });
      send(partnerOf(p), { t: 'chat', from: 'partner', text, ts });
      const ng = games.onChat(p.pair.S, p.role, text);   // NGワードトーク
      if (ng.hit) sysBoth(p.pair, `💣 NGワード「${ng.hit}」！ ${p.name}さんが言ってしまった…`);
      if (ng.changed) pushView(p.pair);
      return;
    }
    case 'leave': {
      if (p.state === 'wait') { queue.delete(p); p.state = 'idle'; }
      if (p.state === 'hosting') closeRoom(p);
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
        id: uid(), ts: new Date().toISOString(), pairId: p.pair.id,
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
    case 'stamp': {
      if (p.state !== 'paired' || !p.pair || !STAMPS.includes(m.id)) return;
      if (!rateOk(p.stampTimes || (p.stampTimes = []), 3, 10_000)) return;
      send(p, { t: 'stamp', id: m.id, from: 'me' });
      send(partnerOf(p), { t: 'stamp', id: m.id, from: 'partner' });
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
    p = { token, name: '', ws, ip, ipHash, state: 'idle', pair: null, role: null,
      blocked: new Set(), recent: new Map(), chatTimes: [], actTimes: [], graceTimer: null };
    players.set(token, p);
  }

  send(p, { t: 'hello', token: p.token, name: p.name, state: p.state, resumed });
  if (p.state === 'paired' && p.pair) {
    const q = partnerOf(p);
    send(p, { t: 'matched', partner: publicInfo(q), resumed: true });
    send(p, { t: 'view', view: games.view(p.pair.S, p.role) });
    send(q, { t: 'partner_back' });
  } else if (p.state === 'wait') {
    queue.add(p); send(p, { t: 'searching' });
  } else if (p.state === 'hosting' && p.room) {
    send(p, { t: 'hosting', code: p.room });
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
      if (p.state === 'hosting') closeRoom(p);
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
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'self'; base-uri 'none'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'",
};

// Only these files are public. Everything else in the folder (server code, data) is never served.
const PUBLIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/favicon.svg': 'favicon.svg', '/admin': 'admin.html' };

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = new URL(req.url, 'http://x').pathname; } catch (e) { res.writeHead(400); return res.end(); }
  const name = PUBLIC_FILES[urlPath];
  if (!name) { res.writeHead(404, SEC_HEADERS); return res.end('not found'); }
  const file = path.join(__dirname, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, SEC_HEADERS); return res.end('not found'); }
    const ext = path.extname(file);
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  });
}

function adminOk(req) {
  const got = String(req.headers['x-admin-token'] || '');
  if (!ADMIN_TOKEN || got.length !== ADMIN_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(ADMIN_TOKEN));
}

// ---- admin data
const HANDLED_FILE = path.join(DATA_DIR, 'handled.json');
let handled = {};
try { handled = JSON.parse(fs.readFileSync(HANDLED_FILE, 'utf8')); } catch (e) { /* none */ }

function readReports(limit) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(DATA_DIR, 'reports.jsonl'), 'utf8').split('\n').filter(Boolean); } catch (e) { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const r = JSON.parse(lines[i]);
      r.id = r.id || ('L' + i);
      r.handled = !!handled[r.id];
      r.bannedUntil = (bans.get(r.reportedIp) || 0) > now() ? bans.get(r.reportedIp) : null;
      r.reportsAgainst = (reportsAgainst.get(r.reportedIp) || []).filter((x) => x.ts > now() - BAN_MS).length;
      out.push(r);
    } catch (e) { /* skip broken line */ }
  }
  return out;
}

function readBody(req, max = 10_000) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); resolve(null); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { resolve(null); } });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function banIp(ipHash, ms) {
  bans.set(ipHash, now() + ms); saveBans();
  for (const x of players.values()) if (x.ipHash === ipHash && x.ws && !x.ws.closed) { send(x, { t: 'banned' }); x.ws.close(4003); }
}

async function handleAdmin(req, res, u) {
  if (!adminOk(req)) return json(res, 401, { error: 'unauthorized' });
  const route = req.method + ' ' + u.pathname;
  if (route === 'GET /admin/api/stats') {
    const dayAgo = now() - 24 * 3600_000;
    const reportsToday = readReports(1000).filter((r) => Date.parse(r.ts) > dayAgo).length;
    return json(res, 200, {
      online: [...players.values()].filter((p) => p.ws && !p.ws.closed).length,
      waiting: queue.size, pairs: pairs.size,
      bans: [...bans.values()].filter((v) => v > now()).length,
      reportsToday, uptimeSec: Math.round(process.uptime()),
    });
  }
  if (route === 'GET /admin/api/reports') {
    const limit = Math.min(500, Number(u.searchParams.get('limit')) || 200);
    return json(res, 200, readReports(limit));
  }
  if (route === 'GET /admin/api/bans') {
    return json(res, 200, [...bans.entries()].filter(([, v]) => v > now()).map(([ipHash, until]) => ({ ipHash, until })));
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'bad body' });
    if (u.pathname === '/admin/api/ban' && /^[a-f0-9]{24}$/.test(body.ipHash || '')) {
      const hours = Math.min(24 * 365, Math.max(1, Number(body.hours) || 24));
      banIp(body.ipHash, hours * 3600_000);
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/admin/api/unban' && typeof body.ipHash === 'string') {
      bans.delete(body.ipHash); reportsAgainst.delete(body.ipHash); saveBans();
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/admin/api/handled' && typeof body.id === 'string' && body.id.length < 40) {
      if (body.handled) handled[body.id] = now(); else delete handled[body.id];
      fs.writeFile(HANDLED_FILE, JSON.stringify(handled), () => {});
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  if (u.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (u.pathname.startsWith('/admin/api/')) {
    handleAdmin(req, res, u).catch((e) => { console.error('admin error', e); json(res, 500, { error: 'server error' }); });
    return;
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

module.exports = { server, _state: { players, queue, pairs, rooms } };
