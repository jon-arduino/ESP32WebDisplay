'use strict';
// Shared helpers for the ESP32WebDisplay test suite.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Load the DOM-free core straight out of web/index.html, so the tests exercise the exact
// code that ships to the browser.
function loadCore() {
  const html = fs.readFileSync(process.env.CORE_HTML || path.join(ROOT, 'web', 'index.html'), 'utf8');
  const m = html.match(/<script id="gfx-core">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('gfx-core script block not found in web/index.html');
  const mod = { exports: {} };
  new Function('module', 'exports', m[1])(mod, mod.exports);
  return mod.exports;
}
const core = loadCore();
const { OP, makeFrame, FrameParser, Renderer } = core;

// mulberry32 PRNG - deterministic, seedable
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- encoders (the same bytes ESP32PhoneDisplay puts on the wire) ----------------
const le16 = (...v) => { const b = new Uint8Array(v.length * 2); v.forEach((x, i) => { b[2 * i] = x & 255; b[2 * i + 1] = (x >> 8) & 255; }); return b; };
const f16 = (cmd, ...v) => makeFrame(cmd, le16(...v));
const f8 = (cmd, v) => makeFrame(cmd, Uint8Array.of(v));
function bitmapFrame(cmd, head, data) {
  const h = le16(...head);
  const p = new Uint8Array(h.length + data.length);
  p.set(h); p.set(data, h.length);
  return makeFrame(cmd, p);
}
const concat = (frames) => {
  const n = frames.reduce((s, f) => s + f.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const f of frames) { out.set(f, o); o += f.length; }
  return out;
};

const OP_NAMES = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));

// ---- fuzz stream generator -----------------------------------------------------
const SIZES = [[240, 320], [320, 240], [128, 64], [100, 77], [64, 64], [17, 9], [200, 200], [480, 320], [8, 8]];

function genFrames(seed) {
  const r = rng(seed);
  const ri = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = (a) => a[Math.floor(r() * a.length)];
  const col = () => ri(0, 65535);
  const frames = [];
  const [W, H] = pick(SIZES);
  const M = Math.max(W, H);
  frames.push(f16(OP.BEGIN, W, H));
  const coord = () => (r() < 0.85 ? ri(-20, M + 20) : ri(-300, 600));
  const len = () => (r() < 0.85 ? ri(-10, M + 30) : ri(-200, 500));
  const rad = () => (r() < 0.9 ? ri(0, 40) : ri(-5, 90));

  const text = () => {
    if (r() < 0.5) frames.push(f16(OP.TEXT_COLOR, col()));
    else frames.push(f16(OP.TEXT_COLOR_BG, col(), col()));
    frames.push(f8(OP.TEXT_SIZE, ri(0, 5)));
    frames.push(f8(OP.TEXT_WRAP, ri(0, 1)));
    frames.push(f8(OP.CP437, ri(0, 1)));
    frames.push(f16(OP.CURSOR, ri(-20, M), ri(-20, M)));
    const n = ri(1, 30);
    for (let i = 0; i < n; i++) {
      const c = r() < 0.7 ? ri(32, 126) : r() < 0.5 ? pick([10, 13, 10]) : r() < 0.4 ? pick([255, 254, 177, 176, 175]) : ri(0, 255);
      frames.push(f8(OP.WRITE_CHAR, c));
    }
  };
  const bitmap = () => {
    const w = ri(0, 40), h = ri(0, 40);
    const full = ((w + 7) >> 3) * h;
    const have = r() < 0.2 ? ri(0, full) : full;        // sometimes truncated: missing bytes read as 0
    const data = Uint8Array.from({ length: have }, () => ri(0, 255));
    if (r() < 0.5) frames.push(bitmapFrame(OP.BITMAP, [coord(), coord(), w, h], data));
    else frames.push(bitmapFrame(OP.BITMAP_BG, [coord(), coord(), w, h, col(), col()], data));
  };

  const ops = [
    [3, () => frames.push(f16(OP.FILL_SCREEN, col()))],
    [5, () => frames.push(f8(OP.SET_ROTATION, ri(0, 3)))],
    [8, () => frames.push(f16(OP.PIXEL, coord(), coord(), col()))],
    [10, () => frames.push(f16(OP.LINE, coord(), coord(), coord(), coord(), col()))],
    [6, () => frames.push(f16(OP.HLINE, coord(), coord(), len(), col()))],
    [6, () => frames.push(f16(OP.VLINE, coord(), coord(), len(), col()))],
    [8, () => frames.push(f16(OP.RECT, coord(), coord(), len(), len(), col()))],
    [8, () => frames.push(f16(OP.FILL_RECT, coord(), coord(), len(), len(), col()))],
    [6, () => frames.push(f16(OP.ROUNDRECT, coord(), coord(), len(), len(), rad(), col()))],
    [6, () => frames.push(f16(OP.FILL_ROUNDRECT, coord(), coord(), len(), len(), rad(), col()))],
    [6, () => frames.push(f16(OP.CIRCLE, coord(), coord(), rad(), col()))],
    [6, () => frames.push(f16(OP.FILL_CIRCLE, coord(), coord(), rad(), col()))],
    [5, () => frames.push(f16(OP.TRI, coord(), coord(), coord(), coord(), coord(), coord(), col()))],
    [5, () => frames.push(f16(OP.FILL_TRI, coord(), coord(), coord(), coord(), coord(), coord(), col()))],
    [6, bitmap],
    [14, text],
    [1, () => frames.push(f16(OP.BEGIN, ...pick(SIZES)))],     // mid-stream BEGIN must fully reset
    [2, () => frames.push(makeFrame(OP.FLUSH))]
  ];
  const total = ops.reduce((s, o) => s + o[0], 0);
  const n = ri(40, 160);
  for (let i = 0; i < n; i++) {
    let x = r() * total;
    for (const [w, fn] of ops) { if ((x -= w) < 0) { fn(); break; } }
  }
  frames.push(makeFrame(OP.FLUSH));
  return frames;
}

// Run frames through the browser core, delivering the bytes in random-sized chunks
// (so frames straddle "WebSocket messages" like they do in real life).
function runJS(frames, chunkSeed) {
  const rend = new Renderer();
  const parser = new FrameParser((c, p) => rend.exec(c, p));
  const all = concat(frames);
  const r = rng(chunkSeed || 1);
  for (let off = 0; off < all.length;) {
    const n = 1 + Math.floor(r() * 700);
    parser.feed(all.subarray(off, off + n));
    off += n;
  }
  return { rend, parser };
}

module.exports = { ROOT, core, OP, OP_NAMES, makeFrame, FrameParser, Renderer, rng, le16, f16, f8, bitmapFrame, concat, genFrames, runJS };
