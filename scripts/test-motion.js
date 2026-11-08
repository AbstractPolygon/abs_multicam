'use strict';
// Unit test of the movement detector (pixelmatch based) with synthetic frames, no app needed.
const pixelmatch = require('pixelmatch');
const M = require('../renderer/motion.js');
const { WIDTH: W, HEIGHT: H, LEVELS } = M;

let seed = 1; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
function frame({ noise = 0, square = null, bright = 0 }) {
  const f = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0;
    let v = 90 + ((x / W) * 60);                              // soft gradient background
    if (square && x >= square.x && x < square.x + square.s && y >= square.y && y < square.y + square.s) v = 230;
    v += (rnd() - 0.5) * 2 * noise + bright;                           // sensor noise, +/- noise levels per channel
    f[i * 4] = f[i * 4 + 1] = f[i * 4 + 2] = v; f[i * 4 + 3] = 255;
  }
  return f;
}
// ratio measured at the same lag the app uses, after the history has filled
function measure(level, make) {
  const d = M.createDetector(pixelmatch); let r = 0, max = 0;
  for (let i = 0; i < 12; i++) { r = d.feed(make(i), level); if (i >= M.LAG) max = Math.max(max, r); }
  return max;
}
let ok = true;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name} ${extra}`); if (!cond) ok = false; };

const scenes = {
  'static, no noise':        () => frame({}),
  'static, light noise (+-3)': () => frame({ noise: 3 }),
  'static, heavy noise (+-8)': () => frame({ noise: 8 }),
  'light flicker (brightness jumps +-30 between frames)': (i) => frame({ noise: 3, bright: ((i * 7) % 5) * 15 - 30 }),
  'auto-exposure ramp (brightness +12 per frame)': (i) => frame({ noise: 3, bright: i * 12 }),
  'small object moving (10x10)': (i) => frame({ noise: 3, square: { x: 10 + i * 6, y: 30, s: 10 } }),
  'medium object moving (24x24)': (i) => frame({ noise: 3, square: { x: 10 + i * 8, y: 30, s: 24 } }),
  'large object moving (60x60)': (i) => frame({ noise: 3, square: { x: 5 + i * 8, y: 15, s: 60 } })
};
const triggers = {};
for (const [name, make] of Object.entries(scenes)) {
  const row = LEVELS.map((L, lv) => { const r = measure(lv, make); return { r, fires: r >= L.ratio }; });
  triggers[name] = row.map((x) => x.fires);
  console.log(`     ${name.padEnd(30)} ` + row.map((x, lv) => `${LEVELS[lv].name} ${(x.r * 100).toFixed(2)}%${x.fires ? ' FIRES' : ''}`).join(' | '));
}
check('no level fires on a static scene without noise', triggers['static, no noise'].every((f) => !f));
check('no level fires on light sensor noise', triggers['static, light noise (+-3)'].every((f) => !f));
check('no level fires on heavy sensor noise', triggers['static, heavy noise (+-8)'].every((f) => !f));
check('no level fires on light flicker', triggers['light flicker (brightness jumps +-30 between frames)'].every((f) => !f));
check('no level fires on an auto-exposure brightness ramp', triggers['auto-exposure ramp (brightness +12 per frame)'].every((f) => !f));
check('Subtle fires on a small moving object', triggers['small object moving (10x10)'][0]);
check('High does NOT fire on a small moving object', !triggers['small object moving (10x10)'][2]);
check('Normal fires on a medium moving object', triggers['medium object moving (24x24)'][1]);
check('High fires on a large moving object', triggers['large object moving (60x60)'][2]);
check('all levels fire on a large moving object', triggers['large object moving (60x60)'].every(Boolean));

// trigger state machine
const t = M.createTrigger({ startSamples: 2, holdMs: 8000 });
const seq = [];
let now = 0; const step = (moving) => { now += 250; const e = t.update(moving, now); if (e) seq.push(`${e}@${now}`); };
step(true); check('one moving sample does not start', !t.active);
step(true); check('two in a row start', t.active);
for (let i = 0; i < 20; i++) step(false); check('still active during the hold time', t.active);
for (let i = 0; i < 20; i++) step(false); check('stops after the hold time without movement', !t.active, seq.join(' '));
step(true); step(false); step(true); check('isolated blips do not start', !t.active);
check('start/stop events came in order', seq.length === 2 && seq[0].startsWith('start') && seq[1].startsWith('stop'), seq.join(' '));

console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
