'use strict';
// Unit tests for the DOM-free core: parser, colour conversion, presentation, control opcodes.
const assert = require('assert');
const { core, OP, makeFrame, FrameParser, Renderer, f16, f8, concat, rng, genFrames, runJS } = require('./lib');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); }
}
const collect = () => { const got = []; return { got, parser: new FrameParser((c, p) => got.push([c, Array.from(p)])) }; };

console.log('FrameParser');
test('parses a frame delivered one byte at a time', () => {
  const { got, parser } = collect();
  const bytes = concat([f16(OP.PIXEL, 1, 2, 3), makeFrame(OP.FLUSH), f8(OP.TEXT_SIZE, 2)]);
  for (const b of bytes) parser.feed(Uint8Array.of(b));
  assert.deepStrictEqual(got.map(g => g[0]), [OP.PIXEL, OP.FLUSH, OP.TEXT_SIZE]);
  assert.deepStrictEqual(got[0][1], [1, 0, 2, 0, 3, 0]);
});
test('frames may straddle arbitrary message boundaries (random chunking, 200 streams)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const frames = genFrames(seed);
    const whole = collect();
    whole.parser.feed(concat(frames));
    const split = collect();
    const all = concat(frames), r = rng(seed);
    for (let o = 0; o < all.length;) { const n = 1 + Math.floor(r() * 50); split.parser.feed(all.subarray(o, o + n)); o += n; }
    assert.strictEqual(split.got.length, frames.length);
    assert.deepStrictEqual(split.got, whole.got);
  }
});
test('resynchronises after garbage, zero length and oversized length', () => {
  const { got, parser } = collect();
  parser.feed(concat([
    Uint8Array.of(0x00, 0x13, 0x37),                 // junk
    Uint8Array.of(0xA5, 0x00, 0x00),                 // len 0 is invalid
    Uint8Array.of(0xA5, 0xFF, 0xFF),                 // len 65535 > limit
    f16(OP.PIXEL, 5, 6, 7)
  ]));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0][0], OP.PIXEL);
  assert.ok(parser.stats.syncErrors > 0 && parser.stats.invalid > 0);
});
test('grows its buffer for a large frame and keeps working', () => {
  const { got, parser } = collect();
  const big = new Uint8Array(12000).fill(0x5A);
  parser.feed(makeFrame(OP.BITMAP, big));
  parser.feed(f8(OP.TEXT_SIZE, 3));
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0][1].length, 12000);
});

console.log('Colour conversion');
test('RGB565 -> RGBA matches the iPhone app formula for all 65536 values', () => {
  const lut = core.makeLut();
  const le = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  assert.ok(le, 'test assumes a little-endian host');
  for (let v = 0; v < 65536; v++) {
    const r = Math.trunc(((v >> 11) & 0x1F) * 255 / 31), g = Math.trunc(((v >> 5) & 0x3F) * 255 / 63), b = Math.trunc((v & 0x1F) * 255 / 31);
    const want = (255 << 24 | b << 16 | g << 8 | r) >>> 0;
    if (lut[v] !== want) assert.fail(`0x${v.toString(16)}: got ${lut[v].toString(16)} want ${want.toString(16)}`);
  }
  assert.strictEqual(lut[0xFFFF], 0xFFFFFFFF);
  assert.strictEqual(lut[0x0000], 0xFF000000);
  assert.strictEqual(lut[0xF800] & 0xFFFFFF, 0x0000FF);          // red -> r=255 (ABGR)
});

console.log('Presentation');
function present(rend) {
  rend.snapshot();
  const s = rend.snapSize(), out = new Uint32Array(s.w * s.h);
  rend.presentSnapshot(out);
  return { out, w: s.w, h: s.h };
}
test('every rotation presents the logical view upright (each logical pixel lands at (x,y))', () => {
  const lut = core.makeLut();
  for (let rot = 0; rot < 4; rot++) {
    const r = new Renderer();
    r.exec(OP.BEGIN, Uint8Array.from([5, 0, 3, 0]));                 // 5x3 physical
    r.exec(OP.SET_ROTATION, Uint8Array.of(rot));
    const lw = r.lw, lh = r.lh;
    assert.deepStrictEqual([lw, lh], rot & 1 ? [3, 5] : [5, 3]);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) r.px(x, y, 1 + y * lw + x);   // unique colour per logical pixel
    const { out, w, h } = present(r);
    assert.deepStrictEqual([w, h], [lw, lh]);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++)
      assert.strictEqual(out[y * lw + x], lut[1 + y * lw + x], `rot ${rot} (${x},${y})`);
  }
});
test('invert flips the presented colours (XOR 0xFFFF) without altering the framebuffer', () => {
  const lut = core.makeLut();
  const r = new Renderer();
  r.exec(OP.BEGIN, Uint8Array.from([4, 0, 4, 0]));
  r.exec(OP.FILL_SCREEN, Uint8Array.from([0x34, 0x12]));
  r.exec(OP.INVERT, Uint8Array.of(1));
  const a = present(r);
  assert.strictEqual(a.out[0], lut[0x1234 ^ 0xFFFF]);
  assert.strictEqual(r.fb[0], 0x1234);
  r.exec(OP.INVERT, Uint8Array.of(0));
  assert.strictEqual(present(r).out[0], lut[0x1234]);
});
test('a FLUSH freezes the frame: later drawing does not leak into the snapshot', () => {
  const lut = core.makeLut();
  const r = new Renderer();
  r.exec(OP.BEGIN, Uint8Array.from([4, 0, 4, 0]));
  r.exec(OP.FILL_SCREEN, Uint8Array.from([0xE0, 0x07]));           // green
  r.exec(OP.FLUSH, new Uint8Array(0));
  r.exec(OP.FILL_SCREEN, Uint8Array.from([0x1F, 0x00]));           // blue, not flushed yet
  const out = new Uint32Array(16);
  r.presentSnapshot(out);
  assert.strictEqual(out[0], lut[0x07E0]);
  assert.ok(r.dirty, 'unflushed drawing should leave the renderer dirty (idle auto-present)');
});

console.log('Control opcodes');
function withEvents() {
  const ev = [];
  // record events; _emit() always passes two args, so drop trailing undefineds
  const r = new Renderer(new Proxy({}, { get: (_, name) => (...a) => { while (a.length && a[a.length - 1] === undefined) a.pop(); ev.push([name, ...a]); } }));
  return { r, ev };
}
test('BEGIN is a full reset (state, rotation, cursor, text attributes)', () => {
  const { r } = withEvents();
  r.exec(OP.BEGIN, Uint8Array.from([20, 0, 10, 0]));
  r.exec(OP.SET_ROTATION, Uint8Array.of(1));
  r.exec(OP.TEXT_SIZE, Uint8Array.of(3));
  r.exec(OP.TEXT_WRAP, Uint8Array.of(0));
  r.exec(OP.CP437, Uint8Array.of(1));
  r.exec(OP.TEXT_COLOR_BG, Uint8Array.from([1, 0, 2, 0]));
  r.exec(OP.CURSOR, Uint8Array.from([7, 0, 9, 0]));
  r.exec(OP.FILL_SCREEN, Uint8Array.from([9, 0]));
  r.exec(OP.BEGIN, Uint8Array.from([20, 0, 10, 0]));
  assert.deepStrictEqual([r.rot, r.tsx, r.tsy, r.wrap, r.cp437, r.fg, r.bg, r.cx, r.cy], [0, 1, 1, true, false, 0xFFFF, 0xFFFF, 0, 0]);
  assert.ok(r.fb.every(v => v === 0), 'surface is cleared to black');
  assert.deepStrictEqual([r.lw, r.lh], [20, 10]);
});
test('setTextColor(c) sets both foreground and background (Adafruit semantics)', () => {
  const { r } = withEvents();
  r.exec(OP.BEGIN, Uint8Array.from([8, 0, 8, 0]));
  r.exec(OP.TEXT_COLOR_BG, Uint8Array.from([1, 0, 2, 0]));
  r.exec(OP.TEXT_COLOR, Uint8Array.from([0x34, 0x12]));
  assert.deepStrictEqual([r.fg, r.bg], [0x1234, 0x1234]);
});
test('text size 0 behaves as 1', () => {
  const { r } = withEvents();
  r.exec(OP.TEXT_SIZE, Uint8Array.of(0));
  assert.deepStrictEqual([r.tsx, r.tsy], [1, 1]);
});
test('title, buttons, touch control, ping and close are delivered as events', () => {
  const { r, ev } = withEvents();
  r.exec(OP.TITLE, new TextEncoder().encode('Héllo'));
  r.exec(OP.ADD_BUTTON, Uint8Array.from([0xF2, 3, 0x4F, 0x4B, 0x21]));
  r.exec(OP.CLEAR_BUTTONS, new Uint8Array(0));
  r.exec(OP.TOUCH_BEGIN, Uint8Array.from([0, 0x64, 0x00]));
  r.exec(OP.TOUCH_BEGIN, new Uint8Array(0));                       // payload omitted -> defaults
  r.exec(OP.TOUCH_DELAY, Uint8Array.from([0x2C, 0x01]));
  r.exec(OP.TOUCH_END, new Uint8Array(0));
  r.exec(OP.PING, new Uint8Array(0));
  const names = ev.map(e => e[0]);
  assert.deepStrictEqual(names, ['title', 'addButton', 'clearButtons', 'touchBegin', 'touchBegin', 'touchDelay', 'touchEnd', 'ping']);
  assert.strictEqual(ev[0][1], 'Héllo');
  assert.deepStrictEqual(ev[1].slice(1), [0xF2, 'OK!']);
  assert.deepStrictEqual(ev[3].slice(1), [0, 100]);
  assert.deepStrictEqual(ev[4].slice(1), [0, 50]);
  assert.deepStrictEqual(ev[5].slice(1), [300]);
});
test('short payloads and unknown opcodes are counted, never thrown', () => {
  const { r } = withEvents();
  r.exec(OP.BEGIN, Uint8Array.from([8, 0, 8, 0]));
  for (const op of [OP.PIXEL, OP.LINE, OP.FILL_RECT, OP.CIRCLE, OP.FILL_TRI, OP.BITMAP, OP.CURSOR, OP.ADD_BUTTON]) r.exec(op, Uint8Array.of(1));
  r.exec(0x7E, new Uint8Array(0));
  assert.strictEqual(r.stats.bad, 8);
  assert.strictEqual(r.stats.unknown, 1);
});
test('BEGIN with absurd dimensions is rejected and the old surface is kept', () => {
  const { r } = withEvents();
  r.exec(OP.BEGIN, Uint8Array.from([8, 0, 8, 0]));
  r.exec(OP.BEGIN, Uint8Array.from([0xFF, 0xFF, 0xFF, 0xFF]));
  r.exec(OP.BEGIN, Uint8Array.from([0, 0, 5, 0]));
  assert.deepStrictEqual([r.W, r.H], [8, 8]);
  assert.strictEqual(r.stats.bad, 2);
});
test('CLOSE_DISPLAY clears the screen and notifies', () => {
  const { r, ev } = withEvents();
  r.exec(OP.BEGIN, Uint8Array.from([4, 0, 4, 0]));
  r.exec(OP.FILL_SCREEN, Uint8Array.from([0xFF, 0xFF]));
  r.exec(OP.CLOSE, new Uint8Array(0));
  assert.ok(r.fb.every(v => v === 0));
  assert.ok(ev.some(e => e[0] === 'close'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
