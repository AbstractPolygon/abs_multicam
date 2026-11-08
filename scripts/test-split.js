'use strict';
// Checks the per-file size cap: with a tiny cap (MB, via MULTICAM_MAX_FILE_MB) every file must stay under it,
// recording must continue into new files without gaps, and every file must decode.
//   node scripts/test-split.js [capMB=4]
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const electron = require('electron');
const capMB = parseInt(process.argv[2] || '4', 10), seconds = 30;
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicam-split-'));
fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
fs.writeFileSync(path.join(dir, 'userdata', 'settings.json'), JSON.stringify({ segmentMinutes: 60, bitrateKbps: 4000 }));
const env = { ...process.env, MULTICAM_FAKE: '2', MULTICAM_SMOKE: String(seconds), MULTICAM_SMOKE_DIR: dir, MULTICAM_MAX_FILE_MB: String(capMB) };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
child.on('exit', () => {
  let ok = true;
  const check = (name, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name} ${extra}`); if (!cond) ok = false; };
  const cap = capMB * 1024 * 1024, out = path.join(dir, 'out');
  const hasFfmpeg = !spawnSync(ffmpeg, ['-version']).error;
  for (const cam of fs.readdirSync(out).sort()) {
    const files = fs.readdirSync(path.join(out, cam)).filter((f) => f.endsWith('.webm')).sort();
    const side = files.map((f) => JSON.parse(fs.readFileSync(path.join(out, cam, f.replace('.webm', '.json')), 'utf8')));
    const sizes = files.map((f) => fs.statSync(path.join(out, cam, f)).size);
    check(`${cam}: split into several files`, files.length >= 3, `(${files.length} files, sizes MB: ${sizes.map((s) => (s / 1048576).toFixed(2)).join(', ')})`);
    check(`${cam}: no file is over the ${capMB} MB cap`, sizes.every((s) => s <= cap));
    const gaps = side.slice(1).map((s, i) => s.startEpochMs - (side[i].startEpochMs + side[i].durationMs));
    check(`${cam}: next file starts before the previous one ends (no gap)`, gaps.every((g) => g <= 50), `(gaps ms: ${gaps.join(', ')})`);
    if (hasFfmpeg) check(`${cam}: every file decodes`, files.every((f) => spawnSync(ffmpeg, ['-v', 'error', '-i', path.join(out, cam, f), '-f', 'null', '-']).status === 0));
  }
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
});
