'use strict';
// Minimal, dependency-free WebSocket server (RFC 6455) — text frames only.
// Handles: handshake, masking, fragmentation, ping/pong, close, payload limits.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSConnection extends EventEmitter {
  constructor(socket, { maxPayload = 16 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.buf = Buffer.alloc(0);
    this.fragments = null;
    this.fragLen = 0;
    this.closed = false;
    this.isAlive = true;
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._finish(1006));
    socket.on('error', () => this._finish(1006));
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > this.maxPayload * 2 + 16) return this.close(1009);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (rsv) return this.close(1002);
      if (!masked) return this.close(1002); // clients must mask
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const hi = this.buf.readUInt32BE(2), lo = this.buf.readUInt32BE(6);
        if (hi !== 0) return this.close(1009);
        len = lo; off = 10;
      }
      if (len > this.maxPayload) return this.close(1009);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = this.buf[off + 4 + i] ^ mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this._onFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  _onFrame(fin, opcode, payload) {
    if (opcode >= 0x8) { // control frames
      if (!fin || payload.length > 125) return this.close(1002);
      if (opcode === 0x8) return this.close(1000);
      if (opcode === 0x9) return this._send(0xA, payload);
      if (opcode === 0xA) { this.isAlive = true; return; }
      return this.close(1002);
    }
    if (opcode === 0x2) return this.close(1003); // binary not supported
    if (opcode === 0x1) {
      if (this.fragments) return this.close(1002);
      if (fin) return this._emitText(payload);
      this.fragments = [payload]; this.fragLen = payload.length; return;
    }
    if (opcode === 0x0) {
      if (!this.fragments) return this.close(1002);
      this.fragments.push(payload); this.fragLen += payload.length;
      if (this.fragLen > this.maxPayload) return this.close(1009);
      if (fin) { const all = Buffer.concat(this.fragments); this.fragments = null; this._emitText(all); }
      return;
    }
    this.close(1002);
  }

  _emitText(buf) {
    this.isAlive = true;
    this.emit('message', buf.toString('utf8'));
  }

  _send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    try { this.socket.write(Buffer.concat([header, payload])); } catch (e) { /* ignore */ }
  }

  send(text) { this._send(0x1, Buffer.from(text, 'utf8')); }
  ping() { this.isAlive = false; this._send(0x9, Buffer.alloc(0)); }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code, 0);
    this._send(0x8, p);
    this._finish(code);
    setTimeout(() => { try { this.socket.destroy(); } catch (e) {} }, 200);
  }

  _finish(code) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code);
  }
}

function handleUpgrade(req, socket, opts = {}) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = (req.headers['upgrade'] || '').toLowerCase();
  if (!key || upgrade !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  socket.setTimeout(0);
  return new WSConnection(socket, opts);
}

module.exports = { handleUpgrade, WSConnection };
