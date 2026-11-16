'use strict';
// Pixel-exactness test: the browser renderer vs the REAL Adafruit_GFX (GFXcanvas16).
// Usage: node test/pixel_exact.js [numStreams=300] [firstSeed=1]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT, OP_NAMES, concat, genFrames, runJS } = require('./lib');

const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
const ref = path.join(__dirname, 'ref', 'gfx_ref');
if (!fs.existsSync(ref)) {
  console.error('reference receiver not built - run test/ref/build.sh first');
  process.exit(2);
}

function runRef(frames, limit) {
  const inp = path.join(outDir, 'stream.bin'), out = path.join(outDir, 'ref.bin');
  fs.writeFileSync(inp, concat(frames));
  execFileSync(ref, limit === undefined ? [inp, out] : [inp, out, String(limit)]);
  const b = fs.readFileSync(out);
  if (b.length < 5) return null;
  const W = b[0] | (b[1] << 8), H = b[2] | (b[3] << 8), rot = b[4];
  const px = new Uint16Array(W * H);
  for (let i = 0; i < W * H; i++) px[i] = b[5 + 2 * i] | (b[6 + 2 * i] << 8);
  return { W, H, rot, px };
}
function diff(js, rf) {
  if (!rf) return js.W === 0 ? null : 'reference produced no canvas';
  if (js.W !== rf.W || js.H !== rf.H) return `size ${js.W}x${js.H} vs ref ${rf.W}x${rf.H}`;
  if (js.rot !== rf.rot) return `rotation ${js.rot} vs ref ${rf.rot}`;
  let bad = 0, first = -1;
  for (let i = 0; i < rf.px.length; i++) if (js.fb[i] !== rf.px[i]) { bad++; if (first < 0) first = i; }
  if (!bad) return null;
  return `${bad} pixels differ, first at raw (${first % rf.W},${(first / rf.W) | 0}): js=0x${js.fb[first].toString(16)} ref=0x${rf.px[first].toString(16)}`;
}
function describe(frame) {
  const cmd = frame[3], p = frame.subarray(4);
  const vals = [];
  for (let i = 0; i + 1 < p.length && vals.length < 8; i += 2) vals.push(((p[i] | (p[i + 1] << 8)) << 16) >> 16);
  return `${OP_NAMES[cmd] || '0x' + cmd.toString(16)} payload=${p.length}B ${vals.join(',')}`;
}

const N = parseInt(process.argv[2] || '300', 10), first = parseInt(process.argv[3] || '1', 10);
let failures = 0, cmds = 0;
for (let seed = first; seed < first + N; seed++) {
  const frames = genFrames(seed);
  cmds += frames.length;
  const { rend } = runJS(frames, seed * 7 + 3);
  const msg = diff(rend, runRef(frames));
  if (!msg) continue;
  failures++;
  console.log(`seed ${seed}: MISMATCH - ${msg}`);
  // find the first command after which the renderers disagree
  for (let k = 1; k <= frames.length; k++) {
    const m = diff(runJS(frames.slice(0, k), 1).rend, runRef(frames.slice(0, k), k));
    if (m) { console.log(`   first divergence at command #${k}: ${describe(frames[k - 1])}\n   ${m}`); break; }
  }
  if (failures >= 5) { console.log('stopping after 5 failures'); break; }
}
console.log(failures ? `FAILED: ${failures} stream(s) differ` : `OK: ${N} random streams (${cmds} commands) are pixel-identical to Adafruit_GFX`);
process.exit(failures ? 1 : 0);
