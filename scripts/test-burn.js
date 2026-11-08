'use strict';
// "Burn camera name and time into the video": records with the option on and off and checks that only the
// labelled recording has bright text pixels in the bottom-left corner. Needs ffmpeg (FFMPEG env or PATH).
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const electron = require('electron');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const keep = process.argv[2];                       // optional: folder to copy the labelled frame into

function record(burnIn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `multicam-burn-${burnIn}-`));
  fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'userdata', 'settings.json'), JSON.stringify({ burnIn, codec: 'h264', segmentMinutes: 5, width: 1280, height: 720 }));
  const env = { ...process.env, MULTICAM_FAKE: '1', MULTICAM_SMOKE: '9', MULTICAM_SMOKE_DIR: dir }; delete env.ELECTRON_RUN_AS_NODE;
  spawnSync(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  const cam = path.join(dir, 'out', 'cam1');
  const file = path.join(cam, fs.readdirSync(cam).find((f) => f.endsWith('.webm')));
  return { dir, file };
}
function whitePixels(file) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-ss', '4', '-i', file, '-frames:v', '1', '-vf', 'crop=iw*0.6:ih*0.2:0:ih*0.8,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  if (r.status !== 0 || !r.stdout.length) return -1;
  let n = 0; for (const b of r.stdout) if (b > 235) n++;
  return n;
}
let ok = true;
const check = (n, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${x}`); if (!c) ok = false; };
const on = record(true), off = record(false);
const wOn = whitePixels(on.file), wOff = whitePixels(off.file);
check('labelled recording has bright text pixels in the bottom-left corner', wOn > 300, `(${wOn} bright pixels)`);
check('normal recording has (almost) none there', wOff >= 0 && wOff < 100, `(${wOff} bright pixels)`);
const dec = spawnSync(ffmpeg, ['-v', 'error', '-i', on.file, '-f', 'null', '-']);
check('labelled recording decodes', dec.status === 0);
if (keep) { fs.mkdirSync(keep, { recursive: true }); spawnSync(ffmpeg, ['-y', '-v', 'error', '-ss', '4', '-i', on.file, '-frames:v', '1', path.join(keep, 'burn-frame.png')]); }
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
