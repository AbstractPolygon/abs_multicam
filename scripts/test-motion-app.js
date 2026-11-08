'use strict';
// End-to-end test of "Record on movement": plays prepared clips through the app's fake camera and checks
// what gets recorded. Clips are generated here (.y4m), so no real camera or footage is needed.
//   node scripts/test-motion-app.js [level=1]
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const electron = require('electron');
const level = parseInt(process.argv[2] || '1', 10);

const W = 320, H = 240, FPS = 10;
function writeClip(file, frames) {          // frames: array of functions (x,y)->luma
  const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`)];
  for (const f of frames) {
    const y = Buffer.alloc(W * H), u = Buffer.alloc(W * H / 4, 128), v = Buffer.alloc(W * H / 4, 128);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) y[j * W + i] = f(i, j);
    parts.push(Buffer.from('FRAME\n'), y, u, v);
  }
  fs.writeFileSync(file, Buffer.concat(parts));
}
const bg = (i, j) => 80 + (i / W) * 60;
const still = () => bg;
const moving = (n) => (i, j) => { const x = 10 + (n * 14) % (W - 90), y = 60; return i >= x && i < x + 70 && j >= y && j < y + 70 ? 235 : bg(i, j); };
const clips = {
  still:  { frames: Array.from({ length: 100 }, still), seconds: 25 },
  moving: { frames: Array.from({ length: 100 }, (_, n) => moving(n)), seconds: 25 },
  // 3 s of movement, then 15 s still, repeating: expect a recording around each burst
  bursts: { frames: [...Array.from({ length: 30 }, (_, n) => moving(n)), ...Array.from({ length: 150 }, still)], seconds: 50 }
};

function run(name, clip, motion, extra = {}) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `multicam-mot-${name}-`));
    fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'userdata', 'settings.json'), JSON.stringify({ motion, motionLevel: level, segmentMinutes: 5 }));
    const file = path.join(dir, `${name}.y4m`); if (clip.frames) writeClip(file, clip.frames);
    const env = { ...process.env, MULTICAM_FAKE: '1', ...(clip.frames ? { MULTICAM_FAKE_FILE: file } : {}), MULTICAM_SMOKE: String(clip.seconds), MULTICAM_SMOKE_DIR: dir, ...extra };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
    const killer = setTimeout(() => child.kill(), (clip.seconds + 40) * 1000);
    child.on('exit', () => {
      clearTimeout(killer);
      const out = path.join(dir, 'out');
      const sidecars = [];
      if (fs.existsSync(out)) for (const c of fs.readdirSync(out)) for (const f of fs.readdirSync(path.join(out, c))) if (f.endsWith('.json')) sidecars.push(JSON.parse(fs.readFileSync(path.join(out, c, f), 'utf8')));
      const f = path.join(dir, 'result.json');
      resolve({ sidecars, result: fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null });
    });
  });
}

(async () => {
  let ok = true;
  const check = (name, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name} ${extra}`); if (!cond) ok = false; };
  console.log(`movement level ${level}`);

  let r = await run('still', clips.still, true);
  check('movement ON, nothing moves -> nothing recorded', r.result && r.sidecars.length === 0, `(segments: ${r.sidecars.length})`);

  r = await run('moving', clips.moving, true);
  const movingMs = r.sidecars.reduce((s, x) => s + (x.durationMs || 0), 0);
  check('movement ON, constant movement -> recording happens', r.sidecars.length >= 1 && movingMs > 12000, `(segments: ${r.sidecars.length}, recorded ${(movingMs / 1000).toFixed(1)} s of ${clips.moving.seconds} s)`);

  r = await run('moving-off', clips.still, false);
  const offMs = r.sidecars.reduce((s, x) => s + (x.durationMs || 0), 0);
  check('movement OFF, nothing moves -> records continuously as before', r.sidecars.length >= 1 && offMs > 15000, `(recorded ${(offMs / 1000).toFixed(1)} s)`);

  r = await run('bursts', clips.bursts, true);
  const d = r.sidecars.map((x) => (x.durationMs || 0) / 1000);
  const total = d.reduce((a, b) => a + b, 0);
  check('bursts -> exactly one recording per burst (the 18 s clip repeats 3 times in 50 s)', r.sidecars.length === 3, `(segments: ${r.sidecars.length}, lengths: ${d.map((x) => x.toFixed(1)).join(', ')} s)`);
  check('bursts -> recording stops after the quiet period (not the whole 50 s)', total > 0 && total < 35, `(total ${total.toFixed(1)} s of 50 s)`);
  check('bursts -> each recording covers the burst plus the hold time (about 8 to 16 s)', d.length > 0 && d.every((x) => x >= 7 && x <= 18));

  // two cameras, movement only in camera 1: camera 2 must not record
  r = await run('isolation', { seconds: 25 }, true, { MULTICAM_FAKE: '2', MULTICAM_SMOKE_FEED: '1' });
  const by = (f) => r.sidecars.filter((x) => x.folder === f);
  const rep = r.result ? Object.fromEntries(r.result.report.map((c) => [c.folder, c])) : {};
  check('two cameras, movement in camera 1 only -> camera 1 records', by('cam1').length >= 1, `(segments: ${by('cam1').length}, triggers: ${rep.cam1 && rep.cam1.triggers})`);
  check('two cameras, movement in camera 1 only -> camera 2 does NOT record', by('cam2').length === 0 && rep.cam2 && rep.cam2.triggers === 0, `(segments: ${by('cam2').length}, triggers: ${rep.cam2 && rep.cam2.triggers})`);

  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
