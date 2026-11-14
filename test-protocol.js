'use strict';
// Protocol / integration tests against a real server instance. Run: node test-protocol.js (Node >= 22)
process.env.TRUST_PROXY = '1';
process.env.ADMIN_TOKEN = 'test-admin-token-123';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'futari-test-' + Date.now());
const assert = require('assert');
const { server, _state } = require('./server');

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

  await t('same-gender players are matched (gender-blind)', async () => {
    const { A, B, mA, mB } = await joinAndMatch('10.0.0.1', '10.0.0.2');
    assert.strictEqual(mA.partner.name, 'はなこ'); assert.strictEqual(mB.partner.name, 'たろう');
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

  console.log(`\n${n} protocol tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
