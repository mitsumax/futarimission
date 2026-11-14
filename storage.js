'use strict';
/**
 * Moderation records: reports (append-only, kept RETENTION_DAYS), bans (ipHash -> until ms), handled (reportId -> ts).
 *
 * - Default: files in DATA_DIR (works on a paid Render plan with a Disk, or locally).
 * - With STORE_URL + STORE_TOKEN: saved on the operator's rental server (e.g. Core Server) via php-store/store.php,
 *   so records survive restarts and redeploys on Render's free plan (whose disk is wiped).
 *
 * Everything is kept in memory for fast reads; writes are persisted in the background.
 * Remote writes that fail are queued and retried, and bans/handled are never written
 * before the remote copy has been loaded once (so a restart can't wipe them).
 */
const fs = require('fs');
const path = require('path');

class Storage {
  constructor({ dataDir, url, token, retentionDays = 180, log = console }) {
    this.dataDir = dataDir;
    this.url = url || '';
    this.token = token || '';
    this.mode = this.url && this.token ? 'remote' : 'local';
    this.retentionMs = retentionDays * 24 * 3600_000;
    this.log = log;
    this.reports = [];          // oldest first
    this.bans = new Map();
    this.handled = {};
    this.loaded = false;
    this.lastOkAt = null;
    this.lastError = null;
    this.queue = [];            // pending remote ops: { action, ...payload }
    this.dirty = { bans: false, handled: false };
    this.flushing = false;
    this.timer = null;
    if (this.mode === 'local') this._loadLocal();
  }

  // ------------------------------------------------------------------ lifecycle
  /** Remote: load once (retrying in the background on failure). Resolves within `waitMs` either way. */
  async init(waitMs = 8000) {
    if (this.mode === 'local') return true;
    const attempt = this._loadRemote().catch(() => false);
    const ok = await Promise.race([attempt, new Promise((r) => setTimeout(() => r(false), waitMs))]);
    this.timer = setInterval(() => {
      if (!this.loaded) this._loadRemote().catch(() => {});
      else this.flush();
    }, 30_000);
    if (this.timer.unref) this.timer.unref();
    return ok;
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  status() {
    return {
      mode: this.mode === 'remote' ? 'remote' : 'local',
      loaded: this.mode === 'local' ? true : this.loaded,
      ok: this.mode === 'local' ? true : this.loaded && !this.lastError,
      lastOkAt: this.lastOkAt, lastError: this.lastError,
      pending: this.queue.length + (this.dirty.bans ? 1 : 0) + (this.dirty.handled ? 1 : 0),
      reports: this.reports.length,
    };
  }

  // ------------------------------------------------------------------ API used by the server
  addReport(entry) {
    this.reports.push(entry);
    if (this.mode === 'local') {
      fs.appendFile(path.join(this.dataDir, 'reports.jsonl'), JSON.stringify(entry) + '\n', () => {});
    } else {
      this.queue.push({ action: 'append_report', report: entry });
      this.flush();
    }
  }

  saveBans() {
    if (this.mode === 'local') {
      fs.writeFile(path.join(this.dataDir, 'bans.json'), JSON.stringify(this._bansObj()), () => {});
    } else { this.dirty.bans = true; this.flush(); }
  }

  saveHandled() {
    if (this.mode === 'local') {
      fs.writeFile(path.join(this.dataDir, 'handled.json'), JSON.stringify(this.handled), () => {});
    } else { this.dirty.handled = true; this.flush(); }
  }

  /** Drop reports older than the retention period. Returns how many were removed from memory. */
  prune(nowMs = Date.now()) {
    const cutoff = nowMs - this.retentionMs;
    const before = this.reports.length;
    this.reports = this.reports.filter((r) => Date.parse(r.ts) >= cutoff);
    const removed = before - this.reports.length;
    if (this.mode === 'local') {
      const file = path.join(this.dataDir, 'reports.jsonl');
      let lines = [];
      try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch (e) { return removed; }
      const keep = lines.filter((l) => { try { return Date.parse(JSON.parse(l).ts) >= cutoff; } catch (e) { return false; } });
      if (keep.length !== lines.length) fs.writeFileSync(file, keep.length ? keep.join('\n') + '\n' : '');
      return Math.max(removed, lines.length - keep.length);
    }
    this.queue.push({ action: 'prune' }); this.flush();
    return removed;
  }

  // ------------------------------------------------------------------ local files
  _loadLocal() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    try {
      const lines = fs.readFileSync(path.join(this.dataDir, 'reports.jsonl'), 'utf8').split('\n').filter(Boolean);
      for (const l of lines) { try { this.reports.push(JSON.parse(l)); } catch (e) { /* skip broken line */ } }
    } catch (e) { /* none yet */ }
    try {
      const b = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'bans.json'), 'utf8'));
      for (const [k, v] of Object.entries(b)) if (v > Date.now()) this.bans.set(k, v);
    } catch (e) { /* none yet */ }
    try { this.handled = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'handled.json'), 'utf8')) || {}; } catch (e) { /* none */ }
    this.loaded = true;
    this.prune();
  }

  // ------------------------------------------------------------------ remote (Sakura)
  async _call(action, payload = {}) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        // Base64 so that chat text inside reports can't trip the rental server's WAF
        headers: { 'content-type': 'text/plain', 'x-store-token': this.token },
        body: Buffer.from(JSON.stringify({ action, ...payload }), 'utf8').toString('base64'),
        signal: ctrl.signal,
      });
      let data = null;
      try { data = await res.json(); } catch (e) { /* not json */ }
      if (!res.ok || !data || data.ok !== true) {
        const err = new Error(`store ${action}: HTTP ${res.status} ${data && data.error ? data.error : ''}`.trim());
        err.status = res.status; throw err;
      }
      this.lastOkAt = Date.now(); this.lastError = null;
      return data;
    } catch (e) {
      this.lastError = String(e.message || e);
      throw e;
    } finally { clearTimeout(to); }
  }

  async _loadRemote() {
    const data = await this._call('load');
    // merge anything that happened before the first successful load
    const ids = new Set(this.reports.map((r) => r.id));
    const remote = Array.isArray(data.reports) ? data.reports : [];
    this.reports = [...remote.filter((r) => !ids.has(r.id)), ...this.reports]
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    for (const [k, v] of Object.entries(data.bans || {})) if (v > (this.bans.get(k) || 0)) this.bans.set(k, v);
    this.handled = { ...(data.handled || {}), ...this.handled };
    const hadLocalChanges = this.dirty.bans || this.dirty.handled;
    this.loaded = true;
    if (hadLocalChanges) { this.dirty.bans = true; this.dirty.handled = true; }
    this.log.log && this.log.log(`記録の保存先: レンタルサーバー（通報 ${this.reports.length}件、利用停止 ${this.bans.size}件を読み込みました）`);
    this.flush();
    return true;
  }

  async flush() {
    if (this.mode !== 'remote' || this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        try { await this._call(this.queue[0].action, this.queue[0]); }
        catch (e) { if (e.status === 400 || e.status === 413) { this.queue.shift(); continue; } throw e; }  // malformed: drop, don't block the queue
        this.queue.shift();
      }
      if (this.loaded && this.dirty.bans) { this.dirty.bans = false; await this._call('save_bans', { bans: this._bansObj() }).catch((e) => { this.dirty.bans = true; throw e; }); }
      if (this.loaded && this.dirty.handled) { this.dirty.handled = false; await this._call('save_handled', { handled: this.handled }).catch((e) => { this.dirty.handled = true; throw e; }); }
    } catch (e) {
      if (this.queue.length > 1000) this.queue.splice(0, this.queue.length - 1000);
      this.log.warn && this.log.warn('記録の保存に失敗しました（30秒後に再送します）: ' + (e.message || e));
    } finally { this.flushing = false; }
  }

  _bansObj() { const o = {}; for (const [k, v] of this.bans) if (v > Date.now()) o[k] = v; return o; }
}

module.exports = { Storage };
