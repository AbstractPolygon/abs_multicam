'use strict';
// Depth view. Part 1: the pure helpers (sizes, tensor, smoothing, colours). Part 2 (needs the model file, pass its path as
// argument or set MULTICAM_DEPTH_MODEL): the real app with a fake camera downloads nothing, loads the model from its
// models folder, runs it on the camera picture and shows a colour depth map.
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const electron = require('electron');
const Depth = require('../renderer/depth.js');

let ok = true;
const check = (n, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${x}`); if (!c) ok = false; };

for (const [w, h] of [[1280, 720], [640, 480], [720, 1280], [1920, 1080], [320, 240]]) {
  for (const q of ['fast', 'normal', 'fine']) {
    const s = Depth.inputSize(w, h, q);
    check(`input size ${w}x${h} ${q}: multiples of 14, aspect kept`, s.w % 14 === 0 && s.h % 14 === 0 && Math.abs(s.w / s.h - w / h) < 0.12, `${s.w}x${s.h}`);
  }
}
const t = Depth.toTensor(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]), 2, 1);
check('tensor is planar and normalised', t.length === 6 && Math.abs(t[0] - (1 - 0.485) / 0.229) < 1e-4 && Math.abs(t[2] - (0 - 0.456) / 0.224) < 1e-4 && Math.abs(t[3] - (1 - 0.456) / 0.224) < 1e-4);
const sm = Depth.createSmoother();
const ramp = Float32Array.from({ length: 100 }, (_, i) => 5 + i * 0.5);
const u = sm.apply(ramp);
check('smoother maps the nearest value to 255 and the farthest to 0', u[99] === 255 && u[0] === 0, `${u[0]}..${u[99]}`);
const noisy = Float32Array.from(ramp, (v, i) => v + (i % 2 ? 3 : -3));
const u2 = sm.apply(noisy);
check('smoothing damps a one-frame jump', Math.abs(u2[50] - u[50]) < Math.abs(((noisy[50] - 5) / 49.5) * 255 - u[50]) + 1);
const rgba = Depth.colorize(new Uint8ClampedArray([0, 255]), new Uint8ClampedArray(8));
check('colours: far is dark blue, near is dark red, opaque', rgba[2] > rgba[0] && rgba[4] > rgba[6] && rgba[3] === 255 && rgba[7] === 255, Array.from(rgba).join(','));

const model = process.argv.slice(2).find((a) => !a.startsWith('--')) || process.env.MULTICAM_DEPTH_MODEL;
if (!model || !fs.existsSync(model)) { console.log('app part skipped (no model file given)'); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicam-depth-'));
fs.mkdirSync(path.join(dir, 'userdata', 'models'), { recursive: true });
if (!process.argv.includes('--download')) fs.copyFileSync(model, path.join(dir, 'userdata', 'models', 'depth-anything-v2-small.onnx'));   // --download: the app fetches it itself
const env = { ...process.env, MULTICAM_FAKE: '1', MULTICAM_SMOKE: process.argv.includes('--download') ? '150' : '45', MULTICAM_SMOKE_DIR: dir, MULTICAM_SMOKE_DEPTH: '1' };
delete env.ELECTRON_RUN_AS_NODE;
spawnSync(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore', timeout: 240000 });
const r = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
const p = r.depthProbe || {};
console.log('depth:', JSON.stringify(p));
console.log((r.logs || []).filter((l) => /depth/i.test(l)).join(' | '));
check('depth view is on (depth only) and visible', p.mode === 2 && p.visible);
check('the model produced frames', p.frames >= 3, String(p.frames));
check('the model file is in the app data folder, complete', fs.existsSync(path.join(dir, 'userdata', 'models', 'depth-anything-v2-small.onnx')) && fs.statSync(path.join(dir, 'userdata', 'models', 'depth-anything-v2-small.onnx')).size === 99060839);
check('no leftover .part file', !fs.existsSync(path.join(dir, 'userdata', 'models', 'depth-anything-v2-small.onnx.part')));
check('the depth map has a real picture (many colours)', p.colors > 20, String(p.colors));
check('the tile shows the speed', /depth [\d.]+ fps/.test(p.stat || ''), p.stat);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
