#!/usr/bin/env node
'use strict';
/*
 * Mock ESP32 for developing and testing web/index.html without hardware.
 *
 *   node tools/mock_server.js [--port 8080] [--replay stream.bin] [--chunk 512]
 *
 * Serves web/index.html at http://localhost:<port>/ and speaks the real display protocol over
 * a WebSocket at /ws, exactly like WebTransport on the ESP32 will. Zero dependencies.
 *
 * Default demo (mirrors the Web_HelloWorld example): draws Hello World, enables touch and paints
 * a dot wherever you touch. T1 clears the screen, T2 cycles the rotation.
 * --replay sends the raw bytes of a captured stream in --chunk sized pieces (frames straddle
 * messages on purpose, like real life) instead of running the demo.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'web', 'index.html');

function loadCore(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/<script id="gfx-core">([\s\S]*?)<\/script>/);
  const mod = { exports: {} };
  new Function('module', 'exports', m[1])(mod, mod.exports);
  return mod.exports;
}
const { OP, BC, FrameParser, makeFrame } = loadCore(HTML);

// ---- frame encoders ---------------------------------------------------------------
const le16 = (...v) => { const b = new Uint8Array(v.length * 2); v.forEach((x, i) => { b[2 * i] = x & 255; b[2 * i + 1] = (x >> 8) & 255; }); return b; };
const f16 = (cmd, ...v) => makeFrame(cmd, le16(...v));
const f8 = (cmd, v) => makeFrame(cmd, Uint8Array.of(v));
const text = (s) => [...s].map((ch) => f8(OP.WRITE_CHAR, ch.charCodeAt(0)));
const rgb565 = (r, g, b) => ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);

// ---- minimal RFC 6455 server side -------------------------------------------------
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
class WsSession {
  constructor(socket) {
    this.socket = socket;
    this.frames = [];                     // back-channel frames received: { cmd, payload:number[] }
    this.listeners = [];
    this.closed = false;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.parser = new FrameParser((cmd, p) => { const f = { cmd, payload: Array.from(p) }; this.frames.push(f); this.listeners.forEach((l) => l(f)); });
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => { this.closed = true; this.onclose && this.onclose(); });
    socket.on('error', () => {});
  }
  send(bytes) {                           // one binary WebSocket message
    if (this.closed) return;
    const n = bytes.length;
    let head;
    if (n < 126) head = Buffer.from([0x82, n]);
    else if (n < 65536) head = Buffer.from([0x82, 126, n >> 8, n & 255]);
    else { head = Buffer.alloc(10); head[0] = 0x82; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
    this.socket.write(Buffer.concat([head, Buffer.from(bytes)]));
  }
  sendFrames(frames) { this.send(Buffer.concat(frames.map((f) => Buffer.from(f)))); }
  close() { if (!this.closed) { this.socket.write(Buffer.from([0x88, 0])); this.socket.end(); } }
  on(l) { this.listeners.push(l); }
  async waitFrame(pred, ms = 2000) {
    const hit = () => this.frames.find(pred);
    if (hit()) return hit();
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timed out waiting for a frame')), ms);
      this.on(() => { const f = hit(); if (f) { clearTimeout(t); res(f); } });
    });
  }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0F, masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7F, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + (masked ? 4 : 0) + len) return;
      let payload = b.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len);
      if (masked) { const key = b.subarray(off, off + 4); payload = Buffer.from(payload.map((x, i) => x ^ key[i & 3])); }
      this.buf = b.subarray(off + (masked ? 4 : 0) + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this.socket.write(Buffer.concat([Buffer.from([0x8A, payload.length]), payload])); continue; }   // ping -> pong
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.fragments.push(payload);
        if (fin) { this.parser.feed(new Uint8Array(Buffer.concat(this.fragments))); this.fragments = []; }
      }
    }
  }
}

// ---- the default demo "sketch" ----------------------------------------------------
function demo(s) {
  let rot = 0, color = 0;
  const palette = [rgb565(255, 80, 80), rgb565(80, 220, 120), rgb565(90, 160, 255), rgb565(255, 210, 70)];
  const static_ = () => {
    const W = rot & 1 ? 320 : 240;
    s.sendFrames([
      f16(OP.FILL_SCREEN, 0x0000),
      f16(OP.FILL_RECT, 0, 0, W, 28, rgb565(30, 60, 140)),
      f16(OP.TEXT_COLOR, 0xFFFF), f8(OP.TEXT_SIZE, 2), f16(OP.CURSOR, 8, 6), ...text('Hello World'),
      f16(OP.TEXT_COLOR_BG, rgb565(255, 210, 70), 0x0000), f8(OP.TEXT_SIZE, 1), f16(OP.CURSOR, 8, 40),
      ...text('Mock ESP32 - rotation ' + rot * 90), f16(OP.CURSOR, 8, 52), ...text('Touch to paint. T1 clear, T2 rotate.'),
      f16(OP.ROUNDRECT, 8, 70, 100, 50, 10, rgb565(90, 160, 255)),
      f16(OP.FILL_CIRCLE, 150, 95, 22, rgb565(80, 220, 120)),
      f16(OP.TRI, 190, 120, 215, 72, 235, 120, rgb565(255, 80, 80)),
      makeFrame(OP.FLUSH)
    ]);
  };
  s.sendFrames([f16(OP.BEGIN, 240, 320)]);
  static_();
  s.sendFrames([makeFrame(OP.TITLE, Buffer.from('Mock ESP32')), makeFrame(OP.TOUCH_BEGIN, Uint8Array.of(0, 30, 0))]);
  s.on((f) => {
    const p = f.payload;
    if (f.cmd === BC.TOUCH_DOWN || f.cmd === BC.TOUCH_MOVE) {
      const x = p[0] | (p[1] << 8), y = p[2] | (p[3] << 8);
      if (f.cmd === BC.TOUCH_DOWN) color = (color + 1) % palette.length;
      s.sendFrames([f16(OP.FILL_CIRCLE, x, y, 4, palette[color]), makeFrame(OP.FLUSH)]);
    } else if (f.cmd === BC.KEY1) static_();
    else if (f.cmd === BC.KEY2) { rot = (rot + 1) & 3; s.sendFrames([f8(OP.SET_ROTATION, rot)]); static_(); }
    else if (f.cmd === BC.REDRAW || (f.cmd === BC.AVAILABLE && p[0] === 1)) static_();
  });
  const ping = setInterval(() => s.send(makeFrame(OP.PING)), 3000);
  s.onclose = () => clearInterval(ping);
}

// ---- server -----------------------------------------------------------------------
// opts: { port, onSession(session), htmlPath }
function startMockServer(opts = {}) {
  const htmlPath = opts.htmlPath || HTML;
  const sessions = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(htmlPath));
    } else { res.writeHead(404); res.end('not found'); }
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (req.url !== '/ws' || !key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const s = new WsSession(socket);
    sessions.push(s);
    (opts.onSession || demo)(s);
  });
  return new Promise((resolve) => server.listen(opts.port || 0, '127.0.0.1', () => {
    resolve({
      port: server.address().port, sessions, server,
      close: () => new Promise((r) => { sessions.forEach((s) => s.socket.destroy()); server.close(() => r()); })
    });
  }));
}

module.exports = { startMockServer, WsSession, f16, f8, text, rgb565 };

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
  const replay = arg('replay');
  const chunk = parseInt(arg('chunk', '512'), 10);
  const onSession = replay ? (s) => {
    const data = fs.readFileSync(replay);
    let off = 0;
    const t = setInterval(() => { if (off >= data.length || s.closed) return clearInterval(t); s.send(data.subarray(off, off + chunk)); off += chunk; }, 10);
  } : demo;
  startMockServer({ port: parseInt(arg('port', '8080'), 10), onSession }).then((m) => {
    console.log(`mock ESP32 on http://localhost:${m.port}/  (${replay ? 'replaying ' + replay : 'Hello World demo'})`);
  });
}
