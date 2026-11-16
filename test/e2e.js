'use strict';
// End-to-end: the real page JavaScript (web/index.html) running in jsdom, talking WebSocket to
// the mock ESP32. Covers connect handshake, presentation timing, buttons, touch, ping, reconnect.
const assert = require('assert');
const { JSDOM } = require('jsdom');
const { startMockServer } = require('../tools/mock_server');
const { core, OP, makeFrame, f16, f8 } = require('./lib');
const { BC } = core;
const lut = core.makeLut();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000, what = 'condition') {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(10); }
}
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
}

(async () => {
  const sessions = [];
  const mock = await startMockServer({ htmlPath: process.env.E2E_HTML, onSession: (s) => sessions.push(s) });
  const presented = [];                                 // every putImageData: { w, h, px: Uint32Array }
  const dom = await JSDOM.fromURL(`http://127.0.0.1:${mock.port}/?flush=50`, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(window) {
      window.TextDecoder = TextDecoder;                 // jsdom does not expose it; browsers do
      window.HTMLCanvasElement.prototype.getContext = function () {
        return {
          createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: (img) => presented.push({ w: img.width, h: img.height, px: new Uint32Array(img.data.buffer.slice(0)) })
        };
      };
    }
  });
  const { window } = dom, { document } = window;
  const canvas = document.getElementById('screen');
  const lastFrame = () => presented[presented.length - 1];
  const S = () => sessions[sessions.length - 1];

  // jsdom has no layout: give the canvas a 2x on-screen rect at (100,50) so pointer mapping works
  const rect = () => { const w = (lastFrame() ? lastFrame().w : 16) * 2, h = (lastFrame() ? lastFrame().h : 8) * 2; return { left: 100, top: 50, right: 100 + w, bottom: 50 + h, width: w, height: h }; };
  canvas.getBoundingClientRect = rect;
  const ptr = (type, x, y, id = 1) => {
    const ev = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'pointerId', { value: id }); Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
    canvas.dispatchEvent(ev);
  };
  const touchFrames = () => S().frames.filter((f) => f.cmd === BC.TOUCH_DOWN || f.cmd === BC.TOUCH_MOVE || f.cmd === BC.TOUCH_UP);

  console.log('Connection');
  await test('page loads, connects and announces DISPLAY_AVAILABLE(1) after ~100 ms', async () => {
    await until(() => S(), 3000, 'websocket connection');
    const f = await S().waitFrame((f) => f.cmd === BC.AVAILABLE, 2000);
    assert.deepStrictEqual(f.payload, [1]);
    assert.ok(document.getElementById('dot').className.includes('open'));
  });

  console.log('Rendering');
  await test('frames split across WebSocket messages are drawn and presented on FLUSH', async () => {
    const bytes = Buffer.concat([
      f16(OP.BEGIN, 16, 8), f16(OP.FILL_SCREEN, 0xF800), f16(OP.PIXEL, 3, 2, 0x07E0), makeFrame(OP.FLUSH)
    ].map((f) => Buffer.from(f)));
    for (const part of [bytes.subarray(0, 5), bytes.subarray(5, 21), bytes.subarray(21)]) { S().send(part); await sleep(5); }
    await until(() => lastFrame() && lastFrame().w === 16, 2000, 'first presented frame');
    const fr = lastFrame();
    assert.deepStrictEqual([fr.w, fr.h], [16, 8]);
    assert.strictEqual(fr.px[0], lut[0xF800]);
    assert.strictEqual(fr.px[2 * 16 + 3], lut[0x07E0]);
  });
  await test('a FLUSH freezes the frame: drawing after it is not shown until the idle timeout', async () => {
    const n = presented.length;
    S().sendFrames([f16(OP.FILL_SCREEN, 0x001F), makeFrame(OP.FLUSH), f16(OP.FILL_SCREEN, 0xFFE0)]);   // blue, flush, then yellow (no flush)
    await until(() => presented.length > n, 1000, 'frame after flush');
    assert.strictEqual(presented[n].px[0], lut[0x001F], 'first presented frame must be the flushed (blue) one');
    await until(() => lastFrame().px[0] === lut[0xFFE0], 1000, 'idle auto-present of the unflushed drawing');
  });
  await test('rotation re-orients the presented frame (16x8 -> 8x16)', async () => {
    S().sendFrames([f8(OP.SET_ROTATION, 1), f16(OP.FILL_SCREEN, 0), f16(OP.PIXEL, 1, 2, 0xFFFF), makeFrame(OP.FLUSH)]);
    await until(() => lastFrame().w === 8 && lastFrame().h === 16, 1000, 'rotated frame');
    assert.strictEqual(lastFrame().px[2 * 8 + 1], lut[0xFFFF]);
    S().sendFrames([f8(OP.SET_ROTATION, 0), makeFrame(OP.FLUSH)]);
    await until(() => lastFrame().w === 16, 1000, 'rotation back');
  });

  console.log('Title, buttons, keys, ping');
  await test('title is shown', async () => {
    S().send(makeFrame(OP.TITLE, Buffer.from('Test Rig')));
    await until(() => document.getElementById('title').textContent === 'Test Rig', 1000, 'title');
    assert.strictEqual(document.title, 'Test Rig');
  });
  await test('T1/T2 buttons send KEY1/KEY2; ADD_BUTTON relabels; CLEAR_BUTTONS removes', async () => {
    const btns = () => [...document.querySelectorAll('#buttons button')];
    assert.deepStrictEqual(btns().map((b) => b.textContent), ['T1', 'T2']);
    btns()[0].click(); btns()[1].click();
    await S().waitFrame((f) => f.cmd === BC.KEY1);
    await S().waitFrame((f) => f.cmd === BC.KEY2);
    S().send(makeFrame(OP.ADD_BUTTON, Uint8Array.from([0xF3, 2, 0x47, 0x6F])));       // KEY2 -> "Go"
    await until(() => btns()[1] && btns()[1].textContent === 'Go', 1000, 'relabel');
    S().send(makeFrame(OP.CLEAR_BUTTONS));
    await until(() => btns().length === 0, 1000, 'buttons cleared');
    S().send(makeFrame(OP.ADD_BUTTON, Uint8Array.from([0xF2, 1, 0x41])));             // add KEY1 "A" back
    await until(() => btns().length === 1 && btns()[0].textContent === 'A', 1000, 'add button');
  });
  await test('PING is answered with PONG', async () => {
    S().send(makeFrame(OP.PING));
    await S().waitFrame((f) => f.cmd === BC.PONG);
  });

  console.log('Touch');
  await test('no touch events are sent until the sketch sends TOUCH_BEGIN', async () => {
    ptr('pointerdown', 111, 57); ptr('pointerup', 111, 57);
    await sleep(100);
    assert.strictEqual(touchFrames().length, 0);
  });
  await test('DOWN / MOVE / UP carry logical coordinates, z=128, and clamp outside the canvas', async () => {
    S().send(makeFrame(OP.TOUCH_BEGIN, Uint8Array.from([0, 0, 0])));                  // mode 0, interval 0 = every move
    await sleep(50);
    ptr('pointerdown', 111, 57);                                                       // logical (5,3) at 2x
    ptr('pointermove', 121, 61);                                                       // logical (10,5)
    ptr('pointermove', -500, 9999);                                                    // far outside: clamped to (0,7)
    ptr('pointerup', -500, 9999);
    await until(() => touchFrames().length >= 4, 1000, 'touch frames');
    const t = touchFrames().slice(-4);
    assert.deepStrictEqual(t.map((f) => f.cmd), [BC.TOUCH_DOWN, BC.TOUCH_MOVE, BC.TOUCH_MOVE, BC.TOUCH_UP]);
    assert.deepStrictEqual(t[0].payload, [5, 0, 3, 0, 128]);
    assert.deepStrictEqual(t[1].payload, [10, 0, 5, 0, 128]);
    assert.deepStrictEqual(t[2].payload, [0, 0, 7, 0, 128]);
    assert.deepStrictEqual(t[3].payload, []);
  });
  await test('a press that starts outside the canvas is ignored', async () => {
    const n = touchFrames().length;
    ptr('pointerdown', 20, 20); ptr('pointerup', 20, 20);
    await sleep(80);
    assert.strictEqual(touchFrames().length, n);
  });
  await test('moves are throttled to interval_ms, with the latest position delivered after the wait', async () => {
    S().send(makeFrame(OP.TOUCH_DELAY, Uint8Array.from([200, 0])));
    await sleep(50);
    const n = touchFrames().length;
    ptr('pointerdown', 101, 51);
    for (let x = 103; x <= 121; x += 2) ptr('pointermove', x, 53);                     // burst of moves inside the interval
    await sleep(80);
    assert.strictEqual(touchFrames().length - n, 1, 'only DOWN so far');
    await until(() => touchFrames().length - n === 2, 1000, 'trailing move');
    const mv = touchFrames()[n + 1];
    assert.strictEqual(mv.cmd, BC.TOUCH_MOVE);
    assert.deepStrictEqual(mv.payload.slice(0, 4), [10, 0, 1, 0]);                     // last x (121-100)/2=10, y (53-50)/2=1
    ptr('pointerup', 121, 53);
    await until(() => touchFrames().length - n === 3 && touchFrames()[n + 2].cmd === BC.TOUCH_UP, 1000, 'UP');
  });
  await test('TOUCH_END stops reporting', async () => {
    S().send(makeFrame(OP.TOUCH_END));
    await sleep(50);
    const n = touchFrames().length;
    ptr('pointerdown', 111, 57); ptr('pointerup', 111, 57);
    await sleep(80);
    assert.strictEqual(touchFrames().length, n);
  });

  console.log('Tab visibility and reconnect');
  await test('hiding the tab sends AVAILABLE(0); showing it sends AVAILABLE(1) then REDRAW_REQUEST', async () => {
    const mark = S().frames.length;
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
    await until(() => S().frames.slice(mark).some((f) => f.cmd === BC.AVAILABLE && f.payload[0] === 0), 1000, 'AVAILABLE(0)');
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
    await until(() => {
      const after = S().frames.slice(mark);
      const iAvail = after.findIndex((f) => f.cmd === BC.AVAILABLE && f.payload[0] === 1);
      const iRedraw = after.findIndex((f) => f.cmd === BC.REDRAW);
      return iAvail >= 0 && iRedraw > iAvail;                  // AVAILABLE(1) first, then REDRAW_REQUEST
    }, 1000, 'AVAILABLE(1) then REDRAW_REQUEST');
  });
  await test('after the ESP32 drops the connection the page shows it, reconnects, and re-announces', async () => {
    const before = sessions.length;
    S().socket.destroy();
    await until(() => /Disconnected/.test(document.getElementById('conn').textContent), 1500, 'disconnected status');
    await until(() => sessions.length > before, 4000, 'reconnect');
    await S().waitFrame((f) => f.cmd === BC.AVAILABLE, 2000);
    await until(() => document.getElementById('dot').className.includes('open'), 1000, 'open again');
    S().sendFrames([f16(OP.BEGIN, 4, 4), f16(OP.FILL_SCREEN, 0x07E0), makeFrame(OP.FLUSH)]);    // a fresh BEGIN works after reconnect
    await until(() => lastFrame().w === 4 && lastFrame().px[0] === lut[0x07E0], 1500, 'frame after reconnect');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  window.close();
  await mock.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
