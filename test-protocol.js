'use strict';
// Protocol / integration tests against a real server instance. Run: node test-protocol.js (Node >= 22)
process.env.TRUST_PROXY = '1';
process.env.ADMIN_TOKEN = 'test-admin-token-123';
process.env.MIN_AGE = '16';
process.env.CONTACT_EMAIL = 'help<x>@example.com';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'futari-test-' + Date.now());
const assert = require('assert');
const { server, _state, pruneReports } = require('./server');

let PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(ip = '10.0.0.1', token = '') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${token ? '?token=' + token : ''}`, { headers: { 'x-forwarded-for': ip } });
    const c = { ws, inbox: [], waiters: [] };
    c.send = (m) => ws.send(JSON.stringify(m));
    c.next = (t, ms = 3000) => new Promise((res, rej) => {
      const i = c.inbox.findIndex((m) => m.t === t);
      if (i >= 0) return res(c.inbox.splice(i, 1)[0]);
      const to = setTimeout(() => rej(new Error('timeout waiting for ' + t)), ms);
      c.waiters.push({ t, res: (m) => { clearTimeout(to); res(m); } });
    });
    c.last = (t) => [...c.inbox].reverse().find((m) => m.t === t);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const w = c.waiters.findIndex((x) => x.t === m.t);
      if (w >= 0) c.waiters.splice(w, 1)[0].res(m); else c.inbox.push(m);
    };
    ws.onopen = () => resolve(c);
    ws.onerror = reject;
  });
}

async function joinAndMatch(ipA, ipB, nameA = 'たろう', nameB = 'はなこ') {
  const A = await client(ipA), B = await client(ipB);
  A.hello = await A.next('hello'); B.hello = await B.next('hello');
  A.send({ t: 'profile', name: nameA, g: 'm' }); await A.next('profile_ok');
  B.send({ t: 'profile', name: nameB, g: 'm' }); await B.next('profile_ok');
  A.send({ t: 'search' }); B.send({ t: 'search' });
  const mA = await A.next('matched'), mB = await B.next('matched');
  return { A, B, mA, mB };
}

let n = 0;
async function t(name, fn) { await fn(); n++; console.log('  ✓', name); }

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;

  await t('players are matched; no gender is stored or sent (even if a client sends one)', async () => {
    const { A, B, mA, mB } = await joinAndMatch('10.0.0.1', '10.0.0.2');
    assert.strictEqual(mA.partner.name, 'はなこ'); assert.strictEqual(mB.partner.name, 'たろう');
    assert.deepStrictEqual(Object.keys(mA.partner), ['name']);
    assert.ok(![..._state.players.values()].some((p) => 'g' in p), 'server keeps no gender field');
    A.ws.close(); B.ws.close(); await sleep(50);
  });

  await t('lock: the operator\'s socket never receives the code', async () => {
    const { A, B } = await joinAndMatch('10.0.1.1', '10.0.1.2');
    await A.next('view'); await B.next('view');
    A.send({ t: 'act', a: { type: 'pick', game: 'lock' } });
    const vA = await A.next('view'), vB = await B.next('view');
    const op = vA.view.play.instr ? vB : vA, ins = vA.view.play.instr ? vA : vB;
    assert.ok(!('code' in op.view.play)); assert.ok(Array.isArray(ins.view.play.code));
    A.ws.close(); B.ws.close(); await sleep(50);
  });

  await t('chat: delivered to partner; contact info rejected and not delivered', async () => {
    const { A, B } = await joinAndMatch('10.0.2.1', '10.0.2.2');
    A.send({ t: 'chat', text: 'よろしく！', id: 'x1' });
    assert.strictEqual((await B.next('chat')).text, 'よろしく！');
    A.send({ t: 'chat', text: 'LINE交換しよ 090-1111-2222', id: 'x2' });
    await A.next('chat_rejected');
    await sleep(150);
    assert.ok(!B.inbox.some((m) => m.t === 'chat' && m.text.includes('090')));
    A.ws.close(); B.ws.close(); await sleep(50);
  });

  await t('chat: rate limited after a burst', async () => {
    const { A, B } = await joinAndMatch('10.0.3.1', '10.0.3.2');
    for (let i = 0; i < 8; i++) A.send({ t: 'chat', text: 'あ' + i, id: 'r' + i });
    await A.next('chat_rejected');
    A.ws.close(); B.ws.close(); await sleep(50);
  });

  await t('reconnect within grace resumes the same pair and view', async () => {
    const { A, B } = await joinAndMatch('10.0.4.1', '10.0.4.2');
    const token = A.hello.token;
    A.ws.close();
    await B.next('partner_away');
    const A2 = await client('10.0.4.1', token);
    const h = await A2.next('hello'); assert.strictEqual(h.resumed, true);
    const m = await A2.next('matched'); assert.strictEqual(m.resumed, true);
    await A2.next('view'); await B.next('partner_back');
    A2.ws.close(); B.ws.close(); await sleep(50);
  });


  await t('without a block, the same two people (same IP) re-match right away', async () => {
    const { A, B } = await joinAndMatch('10.2.0.1', '10.2.0.1');
    A.send({ t: 'leave' }); await B.next('partner_left');
    A.send({ t: 'search' }); B.send({ t: 'search' });
    assert.strictEqual((await A.next('matched', 4000)).partner.name, 'はなこ');
    await B.next('matched');
    A.ws.close(); B.ws.close(); await sleep(50);
  });

  await t('someone new is preferred over the previous partner when both are waiting', async () => {
    const { A, B } = await joinAndMatch('10.2.1.1', '10.2.1.2');
    A.send({ t: 'leave' }); await B.next('partner_left');
    const C = await client('10.2.1.3'); await C.next('hello');
    C.send({ t: 'profile', name: 'あたらしい', g: 'n' }); await C.next('profile_ok');
    C.send({ t: 'search' }); A.send({ t: 'search' }); B.send({ t: 'search' });
    const mC = await C.next('matched', 4000);
    assert.ok(['たろう', 'はなこ'].includes(mC.partner.name), 'newcomer is matched instead of the old pair re-matching');
    await sleep(300);
    const oldPairRematched = A.inbox.some((m) => m.t === 'matched' && m.partner.name === 'はなこ');
    assert.ok(!oldPairRematched);
    A.ws.close(); B.ws.close(); C.ws.close(); await sleep(50);
  });


  await t('private room: create → look up → join by code (lower-case ok) → paired', async () => {
    const H = await client('10.3.0.1'); await H.next('hello');
    H.send({ t: 'profile', name: 'ホスト', g: 'f' }); await H.next('profile_ok');
    H.send({ t: 'host' });
    const { code } = await H.next('hosting');
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
    const G = await client('10.3.0.2'); await G.next('hello');
    G.send({ t: 'room_info', code });
    const info = await G.next('room_info'); assert.strictEqual(info.ok, true); assert.strictEqual(info.host, 'ホスト');
    G.send({ t: 'profile', name: 'ゲスト', g: 'm' }); await G.next('profile_ok');
    G.send({ t: 'join_room', code: code.toLowerCase() });
    assert.strictEqual((await G.next('matched')).partner.name, 'ホスト');
    assert.strictEqual((await H.next('matched')).partner.name, 'ゲスト');
    assert.ok(!_state.rooms.has(code), 'room is consumed once used');
    // a third person cannot use the same code
    const X = await client('10.3.0.3'); await X.next('hello');
    X.send({ t: 'profile', name: 'さんにんめ', g: 'n' }); await X.next('profile_ok');
    X.send({ t: 'join_room', code }); await X.next('room_error');
    H.ws.close(); G.ws.close(); X.ws.close(); await sleep(50);
  });

  await t('private room: wrong code, closed room, blocked user are all refused; hosts are not randomly matched', async () => {
    const H = await client('10.3.1.1'); await H.next('hello');
    H.send({ t: 'profile', name: 'ホスト2', g: 'n' }); await H.next('profile_ok');
    H.send({ t: 'host' }); const { code } = await H.next('hosting');
    const R = await client('10.3.1.9'); await R.next('hello');
    R.send({ t: 'profile', name: 'ランダム', g: 'n' }); await R.next('profile_ok');
    R.send({ t: 'search' }); await sleep(1500);
    assert.ok(!R.inbox.some((m) => m.t === 'matched'), 'host must not be pulled into random matching');
    const G = await client('10.3.1.2'); await G.next('hello');
    G.send({ t: 'profile', name: 'ゲスト2', g: 'n' }); await G.next('profile_ok');
    G.send({ t: 'join_room', code: 'ZZZZZZ' }); await G.next('room_error');
    H.send({ t: 'cancel' }); await sleep(50);
    G.send({ t: 'join_room', code }); await G.next('room_error');
    // blocked
    H.send({ t: 'host' }); const { code: code2 } = await H.next('hosting');
    H.blockedToken = [..._state.players.values()].find((p) => p.name === 'ゲスト2').token;
    [..._state.players.values()].find((p) => p.name === 'ホスト2').blocked.add(H.blockedToken);
    G.send({ t: 'join_room', code: code2 }); await G.next('room_error');
    H.ws.close(); G.ws.close(); R.ws.close(); await sleep(50);
  });

  await t('private room: guessing codes is rate-limited; host can reconnect and keep the room', async () => {
    const G = await client('10.3.2.2'); await G.next('hello');
    G.send({ t: 'profile', name: 'あてずっぽう', g: 'n' }); await G.next('profile_ok');
    for (let i = 0; i < 13; i++) G.send({ t: 'join_room', code: 'AAAAA' + 'BCDEFGHJKMNPQ'[i] });
    let msgs = []; for (let i = 0; i < 13; i++) msgs.push(await G.next('room_error'));
    assert.ok(msgs.some((m) => m.text.includes('多すぎ')));
    const H = await client('10.3.2.1'); H.hello = await H.next('hello');
    H.send({ t: 'profile', name: 'ホスト3', g: 'n' }); await H.next('profile_ok');
    H.send({ t: 'host' }); const { code } = await H.next('hosting');
    H.ws.close(); await sleep(100);
    const H2 = await client('10.3.2.1', H.hello.token);
    assert.strictEqual((await H2.next('hello')).state, 'hosting');
    assert.strictEqual((await H2.next('hosting')).code, code);
    H2.ws.close(); G.ws.close(); await sleep(50);
  });


  await t('ngword: the chat line is delivered, then the game ends with the speaker as loser', async () => {
    const { A, B } = await joinAndMatch('10.4.0.1', '10.4.0.2');
    await A.next('view'); await B.next('view');
    A.send({ t: 'act', a: { type: 'pick', game: 'ngword' } });
    const v = (await A.next('view')).view; await B.next('view');
    assert.ok(v.play.topic && !('ng' in v.play));
    const pair = [..._state.pairs.values()].find((x) => x.S.game === 'ngword');
    const word = pair.S.data.ng[0][0];
    B.send({ t: 'chat', text: word + 'ってよくない？', id: 'n1' });
    assert.ok((await A.next('chat')).text.includes(word));
    const sys = await A.next('sys'); assert.ok(sys.text.startsWith('💣') && sys.text.includes('はなこ'));
    let res; for (;;) { const m = await A.next('view'); if (m.view.phase === 'result') { res = m.view.result; break; } }
    assert.strictEqual(res.loser, 'partner'); assert.strictEqual(res.ng.length, 3);
    A.ws.close(); B.ws.close(); await sleep(50);
  });

  await t('leave with block → never re-matched with that person', async () => {
    const { A, B } = await joinAndMatch('10.0.5.1', '10.0.5.2');
    A.send({ t: 'leave', block: true }); await B.next('partner_left');
    A.send({ t: 'search' }); B.send({ t: 'search' });
    await sleep(2500);
    assert.ok(!A.inbox.some((m) => m.t === 'matched')); assert.ok(!B.inbox.some((m) => m.t === 'matched'));
    A.ws.close(); B.ws.close(); await sleep(50);
  });

  await t('3 reports from different people → temporary ban; report log written', async () => {
    const badIp = '10.0.9.9';
    for (let i = 0; i < 3; i++) {
      const { A, B } = await joinAndMatch(badIp, `10.0.8.${i}`, 'わるもの', 'ひと' + i);
      B.send({ t: 'chat', text: 'いいね', id: 'c' });
      await A.next('chat');
      B.send({ t: 'report', reason: 'いやがらせ' });
      await A.next('partner_left');
      if (i < 2) { A.ws.close(); B.ws.close(); await sleep(50); }
      else { await A.next('banned'); B.ws.close(); }
    }
    await sleep(100);
    const C = await client(badIp);
    await C.next('banned');
    const fs = require('fs'), path = require('path');
    const lines = fs.readFileSync(path.join(process.env.DATA_DIR, 'reports.jsonl'), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 3);
    const e = JSON.parse(lines[0]);
    assert.ok(e.log.length >= 1 && !JSON.stringify(e).includes(badIp), 'raw IP must not be logged');
  });

  await t('bad names rejected', async () => {
    const A = await client('10.0.6.1'); await A.next('hello');
    A.send({ t: 'profile', name: 'line_abc', g: 'f' });
    assert.strictEqual((await A.next('error')).code, 'name');
    A.ws.close();
  });

  await t('index served; server code never served', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/`); assert.strictEqual(r.status, 200);
    assert.ok((await r.text()).includes('ふたり'));
    const r2 = await fetch(`http://127.0.0.1:${PORT}/server.js`); assert.strictEqual(r2.status, 404);
    const r4 = await fetch(`http://127.0.0.1:${PORT}/%2e%2e/server.js`); assert.ok([403, 404].includes(r4.status));
    const r3 = await fetch(`http://127.0.0.1:${PORT}/healthz`); assert.strictEqual(r3.status, 200);
    // no third-party requests: pages reference no external hosts, and the CSP forbids them
    const fs2 = require('fs');
    for (const f of ['index.html', 'admin.html']) {
      const html = fs2.readFileSync(require('path').join(__dirname, f), 'utf8');
      const ext = (html.match(/(?:src|href)=["']https?:\/\/[^"']+/g) || []);
      assert.deepStrictEqual(ext, [], f + ' loads external resources');
    }
    const csp = r.headers.get('content-security-policy');
    assert.ok(!/https?:\/\//.test(csp), 'CSP allows no external hosts');
  });


  await t('stamps are relayed to the partner; unknown stamps ignored', async () => {
    const { A, B } = await joinAndMatch('10.1.0.1', '10.1.0.2');
    A.send({ t: 'stamp', id: 'fun' });
    assert.strictEqual((await B.next('stamp')).id, 'fun');
    assert.strictEqual((await A.next('stamp')).from, 'me');
    A.send({ t: 'stamp', id: '<script>' }); await sleep(150);
    assert.ok(!B.inbox.some((m) => m.t === 'stamp'));
    A.ws.close(); B.ws.close(); await sleep(50);
  });

  await t('draw: drawer\'s chat containing the answer is blocked; guesser\'s socket never gets the word', async () => {
    const { A, B } = await joinAndMatch('10.1.1.1', '10.1.1.2');
    await A.next('view'); await B.next('view');
    A.send({ t: 'act', a: { type: 'pick', game: 'draw' } });
    const vA = (await A.next('view')).view, vB = (await B.next('view')).view;
    const drawer = vA.play.drawer ? A : B, guesser = vA.play.drawer ? B : A;
    const word = (vA.play.drawer ? vA : vB).play.word;
    assert.ok(word && !('word' in (vA.play.drawer ? vB : vA).play));
    drawer.send({ t: 'chat', text: 'これは' + word + 'です', id: 'w1' });
    await drawer.next('chat_rejected');
    await sleep(120);
    assert.ok(!guesser.inbox.some((m) => m.t === 'chat'));
    guesser.send({ t: 'act', a: { type: 'guess', text: word, r: 0 } });
    assert.ok((await guesser.next('sys')).text.startsWith('⭕'));
    A.ws.close(); B.ws.close(); await sleep(50);
  });

  await t('admin API: 401 without token; stats / reports / ban / unban / handled work', async () => {
    const base = `http://127.0.0.1:${PORT}/admin/api/`;
    assert.strictEqual((await fetch(base + 'stats')).status, 401);
    assert.strictEqual((await fetch(base + 'stats', { headers: { 'x-admin-token': 'wrong-token-xxxxxxx' } })).status, 401);
    const H = { 'x-admin-token': 'test-admin-token-123', 'content-type': 'application/json' };
    const stats = await (await fetch(base + 'stats', { headers: H })).json();
    assert.ok('online' in stats && 'reportsToday' in stats);
    const reps = await (await fetch(base + 'reports', { headers: H })).json();
    assert.ok(reps.length >= 3 && reps[0].log && reps[0].id);
    const ip = reps[0].reportedIp;
    assert.ok(reps[0].bannedUntil, 'auto-banned user shows as banned');
    let r = await fetch(base + 'unban', { method: 'POST', headers: H, body: JSON.stringify({ ipHash: ip }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await (await fetch(base + 'bans', { headers: H })).json()).length, 0);
    const C = await client('10.0.9.9'); const h = await C.next('hello'); assert.ok(h.token, 'unbanned user can connect');
    r = await fetch(base + 'ban', { method: 'POST', headers: H, body: JSON.stringify({ ipHash: ip, hours: 1 }) });
    assert.strictEqual(r.status, 200);
    await C.next('banned');
    await fetch(base + 'handled', { method: 'POST', headers: H, body: JSON.stringify({ id: reps[0].id, handled: true }) });
    assert.strictEqual((await (await fetch(base + 'reports', { headers: H })).json())[0].handled, true);
    const page = await fetch(`http://127.0.0.1:${PORT}/admin`); assert.strictEqual(page.status, 200);
  });


  await t('terms & privacy pages: served with age / contact filled in (HTML-escaped); start screen shows the age', async () => {
    const terms = await (await fetch(`http://127.0.0.1:${PORT}/terms`)).text();
    const privacy = await (await fetch(`http://127.0.0.1:${PORT}/privacy`)).text();
    const index = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    for (const [name, html] of [['terms', terms], ['privacy', privacy], ['index', index]]) {
      assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), name + ' has unfilled placeholders');
    }
    assert.ok(terms.includes('16歳以上') && terms.includes('非営利') && terms.includes('最大40件') && terms.includes('180日'));
    assert.ok(terms.includes('一切の責任を負いません') && terms.includes('故意または重大な過失') && terms.includes('自己の責任において') && terms.includes('分離可能性'));
    assert.ok(terms.includes('help&lt;x&gt;@example.com') && !terms.includes('help<x>'), 'contact is escaped');
    assert.ok(privacy.includes('Cookieは使いません') && privacy.includes('help&lt;x&gt;@example.com'));
    assert.ok(index.includes('16歳以上です') && index.includes('href="/terms"') && index.includes('href="/privacy"'));
  });

  await t('reports older than 180 days are deleted automatically', async () => {
    const fs = require('fs'), path = require('path');
    const file = path.join(process.env.DATA_DIR, 'reports.jsonl');
    const old = { id: 'old1', ts: new Date(Date.now() - 181 * 86400_000).toISOString(), log: [] };
    const fresh = { id: 'new1', ts: new Date().toISOString(), log: [] };
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.writeFileSync(file, before + JSON.stringify(old) + '\n' + JSON.stringify(fresh) + '\n');
    assert.strictEqual(pruneReports(), 1);
    const ids = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).id);
    assert.ok(!ids.includes('old1') && ids.includes('new1'));
  });

  console.log(`\n${n} protocol tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
