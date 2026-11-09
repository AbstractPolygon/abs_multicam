'use strict';
// "Save recordings as MP4": every finished file becomes an .mp4 with a real duration, working seek and a
// timecode track that matches the sidecar; no .webm / .part files are left; VP8 is converted to H.264;
// and .webm files left over from an earlier session are converted after start-up. Uses ffmpeg-static from node_modules.
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const electron = require('electron');
const ffmpeg = require('ffmpeg-static');

function run(codec, prepare) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `multicam-mp4-${codec}-`));
  fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'userdata', 'settings.json'), JSON.stringify({ saveMp4: true, codec, segmentMinutes: 0.1 }));
  if (prepare) prepare(dir);
  const env = { ...process.env, MULTICAM_FAKE: '2', MULTICAM_SMOKE: prepare ? '16' : '13', MULTICAM_SMOKE_DIR: dir }; delete env.ELECTRON_RUN_AS_NODE;
  spawnSync(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  return dir;
}
const info = (f) => spawnSync(ffmpeg, ['-hide_banner', '-i', f], { encoding: 'utf8' }).stderr;
let ok = true;
const check = (n, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${x}`); if (!c) ok = false; };

function verify(label, dir, expectCodec) {
  const out = path.join(dir, 'out'), mp4 = [], leftovers = [];
  for (const cam of fs.readdirSync(out)) for (const f of fs.readdirSync(path.join(out, cam))) {
    if (f.endsWith('.mp4') && !f.endsWith('.part.mp4')) mp4.push(path.join(out, cam, f));
    else if (f.endsWith('.webm') || f.endsWith('.part.mp4')) leftovers.push(f);
  }
  check(`${label}: files were converted to .mp4`, mp4.length >= 4, `(${mp4.length} files)`);
  check(`${label}: no .webm or .part files left behind`, leftovers.length === 0, leftovers.join(', '));
  const bad = mp4.filter((f) => !/Duration: \d\d:\d\d:\d\d\.\d\d/.test(info(f)) || spawnSync(ffmpeg, ['-v', 'error', '-ss', '2', '-i', f, '-frames:v', '3', '-f', 'null', '-']).status !== 0);
  check(`${label}: every file has a duration and seeks and decodes`, bad.length === 0, bad.map((b) => path.basename(b)).join(', '));
  const codecOk = mp4.every((f) => new RegExp('Video: ' + expectCodec).test(info(f)));
  check(`${label}: video codec is ${expectCodec}`, codecOk);
  let tcOk = true, sideOk = true;
  for (const f of mp4) {
    const side = JSON.parse(fs.readFileSync(f.replace(/\.mp4$/, '.json'), 'utf8'));
    if (!info(f).includes('timecode        : ' + side.timecodeStart)) tcOk = false;
    if (side.file !== path.basename(f) || side.container !== 'mp4') sideOk = false;
  }
  check(`${label}: timecode track equals the sidecar start timecode`, tcOk);
  check(`${label}: sidecar points at the .mp4`, sideOk);
}

verify('H.264 (copied)', run('h264'), 'h264');
verify('VP8 (re-encoded)', run('vp8'), 'h264');

// leftovers from an earlier session
const dirL = run('h264', (dir) => {
  const cam = path.join(dir, 'out', 'cam9'); fs.mkdirSync(cam, { recursive: true });
  const src = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('multicam-mp4-h264-')).map((d) => path.join(os.tmpdir(), d, 'out', 'cam1')).find((d) => fs.existsSync(d));
  const tmp = fs.readdirSync(src).find((f) => f.endsWith('.mp4'));
  // make a real old .webm by re-wrapping an mp4 as webm is not possible for h264; use a tiny VP8 clip instead
  spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '3', '-c:v', 'libvpx', path.join(cam, 'cam9_20200101_000000.webm')]);
  const old = new Date(Date.now() - 3600e3); fs.utimesSync(path.join(cam, 'cam9_20200101_000000.webm'), old, old);
  fs.writeFileSync(path.join(cam, 'cam9_20200102_000000.part.mp4'), 'junk');
});
const leftCam = path.join(dirL, 'out', 'cam9');
const names = fs.readdirSync(leftCam);
check('leftover .webm from an earlier session is converted after start-up', names.includes('cam9_20200101_000000.mp4') && !names.includes('cam9_20200101_000000.webm'), names.join(', '));
check('stale .part.mp4 is removed', !names.includes('cam9_20200102_000000.part.mp4'));
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
