'use strict';
// Runs php-store/store.php under PHP's built-in server and checks the app's storage against it.
// Run: node test-store.js   (skipped automatically when PHP is not installed)
const assert = require('assert');
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { Storage } = require('./storage');

try { execSync('php -v', { stdio: 'ignore' }); } catch (e) { console.log('store tests skipped (php not installed)'); process.exit(0); }

const TOKEN = 'x'.repeat(20) + 'test-token-0123456789';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futari-store-'));
fs.writeFileSync(path.join(dir, 'store.php'), fs.readFileSync(path.join(__dirname, 'php-store', 'store.php'), 'utf8').replace('__STORE_TOKEN__', TOKEN));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log() {}, warn() {} };
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };

function startPhp(port) {
  const p = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', dir], { stdio: 'ignore' });
  return p;
}
async function waitUp(url) { for (let i = 0; i < 50; i++) { try { await fetch(url); return; } catch (e) { await sleep(100); } } throw new Error('php did not start'); }

(async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const url = `http://127.0.0.1:${port}/store.php`;
  let php = startPhp(port); await waitUp(url);

  await t('wrong token is rejected; GET is rejected', async () => {
    const r = await fetch(url, { method: 'POST', headers: { 'x-store-token': 'nope' }, body: '{"action":"ping"}' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual((await fetch(url)).status, 405);
  });

  await t('reports / bans / handled survive a "restart" (new Storage instance)', async () => {
    const a = new Storage({ url, token: TOKEN, log: quiet });
    assert.strictEqual(await a.init(), true);
    a.addReport({ id: 'r1', ts: new Date().toISOString(), reason: 'テスト', log: [{ who: 'reported', text: 'こんにちは', ts: Date.now() }] });
    a.bans.set('a'.repeat(24), Date.now() + 3600_000); a.saveBans();
    a.handled.r1 = Date.now(); a.saveHandled();
    for (let i = 0; i < 40 && a.status().pending; i++) await sleep(50);
    assert.strictEqual(a.status().pending, 0); a.stop();
    const b = new Storage({ url, token: TOKEN, log: quiet });
    await b.init(); b.stop();
    assert.strictEqual(b.reports.length, 1);
    assert.strictEqual(b.reports[0].log[0].text, 'こんにちは');
    assert.ok(b.bans.get('a'.repeat(24)) > Date.now());
    assert.ok(b.handled.r1);
  });

  await t('stored files show nothing when opened directly in a browser', async () => {
    for (const f of ['reports', 'bans', 'handled']) {
      const body = await (await fetch(`http://127.0.0.1:${port}/data/${f}.php`)).text();
      assert.ok(!body.includes('こんにちは') && !body.includes('aaaa'), f + ' leaked');
    }
    const raw = fs.readFileSync(path.join(dir, 'data', 'reports.php'), 'utf8');
    assert.ok(raw.startsWith('<?php exit; ?>') && raw.includes('こんにちは'));
  });

  await t('reports older than 180 days are removed on the server', async () => {
    const s = new Storage({ url, token: TOKEN, log: quiet }); await s.init();
    s.addReport({ id: 'old', ts: new Date(Date.now() - 200 * 86400_000).toISOString(), log: [] });
    s.addReport({ id: 'new2', ts: new Date().toISOString(), log: [] });
    for (let i = 0; i < 40 && s.status().pending; i++) await sleep(50);
    s.stop();
    const fresh = new Storage({ url, token: TOKEN, log: quiet }); await fresh.init(); fresh.stop();
    const ids = fresh.reports.map((r) => r.id);
    assert.ok(!ids.includes('old') && ids.includes('new2'));
  });

  await t('rental server down → writes are queued and sent later; bans are not overwritten before loading', async () => {
    php.kill(); await sleep(200);
    const s = new Storage({ url, token: TOKEN, log: quiet });
    assert.strictEqual(await s.init(1500), false);
    assert.strictEqual(s.status().ok, false);
    s.addReport({ id: 'queued1', ts: new Date().toISOString(), log: [] });
    s.bans.set('b'.repeat(24), Date.now() + 3600_000); s.saveBans();
    await sleep(300);
    assert.ok(s.status().pending >= 1);
    php = startPhp(port); await waitUp(url);
    await s._loadRemote();                         // what the 30s retry timer does
    for (let i = 0; i < 60 && s.status().pending; i++) await sleep(50);
    s.stop();
    const check = new Storage({ url, token: TOKEN, log: quiet }); await check.init(); check.stop();
    assert.ok(check.reports.some((r) => r.id === 'queued1'));
    assert.ok(check.bans.get('a'.repeat(24)), 'earlier ban kept (merged, not overwritten)');
    assert.ok(check.bans.get('b'.repeat(24)), 'ban made while offline was saved');
  });

  await t('chat text that looks like an attack is stored intact (sent as Base64, not raw)', async () => {
    const nasty = "' OR 1=1; DROP TABLE x; -- <script>alert(1)</script> ../../etc/passwd union select";
    const s = new Storage({ url, token: TOKEN, log: quiet }); await s.init();
    s.addReport({ id: 'waf1', ts: new Date().toISOString(), log: [{ who: 'reported', text: nasty, ts: Date.now() }] });
    for (let i = 0; i < 40 && s.status().pending; i++) await sleep(50);
    s.stop();
    const c = new Storage({ url, token: TOKEN, log: quiet }); await c.init(); c.stop();
    assert.strictEqual(c.reports.find((r) => r.id === 'waf1').log[0].text, nasty);
  });

  await t('duplicate report ids (retries) are stored once', async () => {
    const s = new Storage({ url, token: TOKEN, log: quiet }); await s.init();
    s.queue.push({ action: 'append_report', report: { id: 'dup', ts: new Date().toISOString(), log: [] } });
    s.queue.push({ action: 'append_report', report: { id: 'dup', ts: new Date().toISOString(), log: [] } });
    await s.flush(); s.stop();
    const c = new Storage({ url, token: TOKEN, log: quiet }); await c.init(); c.stop();
    assert.strictEqual(c.reports.filter((r) => r.id === 'dup').length, 1);
  });

  php.kill();
  console.log(`\n${n} store tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
