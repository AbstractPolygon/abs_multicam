'use strict';
// Loop cleanup must delete only the app's own recordings (<camera>_YYYYMMDD_HHMMSS[_n].webm|mp4) and never other videos
// that happen to sit in the output folder. Runs the real app for ~70 s (cleanup runs once a minute).
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');
let ok = true;
const check = (n, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${x}`); if (!c) ok = false; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicam-clean-'));
const out = path.join(dir, 'out');
fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
fs.writeFileSync(path.join(dir, 'userdata', 'settings.json'), JSON.stringify({ maxAgeHours: 1, outputDir: out }));
const old = new Date(Date.now() - 48 * 3600e3);
const mk = (rel) => { const f = path.join(out, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(2048)); fs.utimesSync(f, old, old); return f; };
const ownA = mk('camX/camX_20200101_000000.webm'), ownB = mk('camX/camX_20200101_000100_1.mp4'), ownSide = mk('camX/camX_20200101_000000.json');
const foreign = [mk('holiday.mp4'), mk('camX/notes_final.mp4'), mk('Family/birthday.webm'), mk('Family/IMG_20200101_000000.mp4.bak')];

const env = { ...process.env, MULTICAM_FAKE: '1', MULTICAM_SMOKE: '75', MULTICAM_SMOKE_DIR: dir, MULTICAM_SMOKE_UI: '' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
const killer = setTimeout(() => child.kill(), 120000);
child.on('exit', () => {
  clearTimeout(killer);
  check('own old recordings (.webm and .mp4) were removed', !fs.existsSync(ownA) && !fs.existsSync(ownB));
  foreign.forEach((f) => check(`foreign file kept: ${path.relative(out, f)}`, fs.existsSync(f)));
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
});
