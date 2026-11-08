'use strict';
// Raspberry Pi behaviour (simulated with MULTICAM_FAKE_PI=1): a first run starts with lighter settings and the Pi
// hardware encoder setting (it only takes effect where the hardware exists); a user's saved settings are never overridden; other machines keep the normal defaults.
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const electron = require('electron');
let ok = true;
const check = (n, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${x}`); if (!c) ok = false; };

function run(extraEnv, saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicam-pi-'));
  fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
  if (saved) fs.writeFileSync(path.join(dir, 'userdata', 'settings.json'), JSON.stringify(saved));
  const env = { ...process.env, MULTICAM_FAKE: '1', MULTICAM_SMOKE: '5', MULTICAM_SMOKE_DIR: dir, ...extraEnv }; delete env.ELECTRON_RUN_AS_NODE;
  spawnSync(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  return JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
}
let r = run({ MULTICAM_FAKE_PI: '1' });
const s = r.settingsSnapshot;
check('Pi first run: 640x480 at 15 fps, 1 Mbps, smaller tiles', r.isPi && s.width === 640 && s.height === 480 && s.fps === 15 && s.bitrateKbps === 1000 && s.tileMin === 320, JSON.stringify(s));
check('Pi first run: asks for the Pi hardware encoder, Chromium itself encodes nothing on the GPU', s.encoder === 'v4l2' && r.gpu.pref === 'v4l2' && r.gpu.encode !== 'enabled', JSON.stringify(r.gpu));
check('Pi first run: cameras still record', r.report.length === 1 && r.files.length >= 1, '(' + r.files.length + ' files)');
r = run({ MULTICAM_FAKE_PI: '1' }, { width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 });
check('Pi with saved settings: the user\'s choices are kept', r.settingsSnapshot.width === 1920 && r.settingsSnapshot.fps === 30 && r.settingsSnapshot.bitrateKbps === 6000, JSON.stringify(r.settingsSnapshot));
r = run({});
check('other machines keep the normal defaults', !r.isPi && r.settingsSnapshot.width === 1280 && r.settingsSnapshot.height === 720 && r.settingsSnapshot.fps === 30 && r.settingsSnapshot.encoder === 'high', JSON.stringify(r.settingsSnapshot));
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
