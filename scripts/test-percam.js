'use strict';
// Per-camera overrides, driven through the real tile controls: movement sensitivity, stop-after time, bitrate.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const electron = require('electron');

function run(name, { seconds, settings = {}, env: extra }) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `multicam-pc-${name}-`));
    fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'userdata', 'settings.json'), JSON.stringify({ codec: 'h264', ...settings }));
    const env = { ...process.env, MULTICAM_FAKE: '2', MULTICAM_SMOKE: String(seconds), MULTICAM_SMOKE_DIR: dir, ...extra };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
    const killer = setTimeout(() => child.kill(), (seconds + 40) * 1000);
    child.on('exit', () => {
      clearTimeout(killer);
      const out = path.join(dir, 'out'), per = {};
      if (fs.existsSync(out)) for (const c of fs.readdirSync(out)) {
        per[c] = { files: [], seconds: 0, bytes: 0 };
        for (const f of fs.readdirSync(path.join(out, c))) {
          if (f.endsWith('.json')) { const j = JSON.parse(fs.readFileSync(path.join(out, c, f), 'utf8')); per[c].seconds += (j.durationMs || 0) / 1000; }
          else { const sz = fs.statSync(path.join(out, c, f)).size; per[c].files.push(sz); per[c].bytes += sz; }
        }
      }
      resolve(per);
    });
  });
}
let ok = true;
const check = (n, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${x}`); if (!c) ok = false; };

(async () => {
  // 1) sensitivity: a small movement both cameras see. Camera 1 = High (ignores it), camera 2 = Subtle (records).
  let r = await run('level', { seconds: 20, settings: { motion: true, motionLevel: 1 }, env: { MULTICAM_SMOKE_FEED: 'small', MULTICAM_SMOKE_PERCAM: JSON.stringify({ cam1: { 'o-motion': '2' }, cam2: { 'o-motion': '0' } }) } });
  check('per-camera sensitivity: High camera ignores a small movement', !r.cam1 || r.cam1.files.length === 0, JSON.stringify(r.cam1));
  check('per-camera sensitivity: Subtle camera records it', r.cam2 && r.cam2.files.length >= 1, `(${r.cam2 && r.cam2.seconds.toFixed(1)} s)`);

  // 2) stop-after: movement for 5 s only. Camera 1 stops after 3 s, camera 2 after 15 s.
  r = await run('hold', { seconds: 34, settings: { motion: true, motionLevel: 0 }, env: { MULTICAM_SMOKE_FEED: 'small-burst', MULTICAM_SMOKE_PERCAM: JSON.stringify({ cam1: { 'o-hold': '3' }, cam2: { 'o-hold': '15' } }) } });
  const a = r.cam1 && r.cam1.seconds, b = r.cam2 && r.cam2.seconds;
  check('per-camera stop-after: camera 1 (3 s) stops sooner than camera 2 (15 s)', a > 0 && b > 0 && b - a >= 7, `(camera 1 recorded ${a && a.toFixed(1)} s, camera 2 ${b && b.toFixed(1)} s)`);

  // 3) bitrate: same picture, camera 1 at 0.5 Mbps and camera 2 at 20 Mbps (applies from the next file)
  r = await run('bitrate', { seconds: 30, settings: { segmentMinutes: 0.1 }, env: { MULTICAM_SMOKE_PERCAM: JSON.stringify({ cam1: { 'o-bitrate': '500' }, cam2: { 'o-bitrate': '20000' } }) } });
  const late = (c) => c.files.slice(1).reduce((s, x) => s + x, 0);   // skip the first file, written before the override
  check('per-camera bitrate: the 20 Mbps camera writes more than the 0.5 Mbps one', r.cam1 && r.cam2 && late(r.cam2) > late(r.cam1) * 1.5, `(cam1 ${Math.round(late(r.cam1) / 1024)} KB, cam2 ${Math.round(late(r.cam2) / 1024)} KB)`);
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
