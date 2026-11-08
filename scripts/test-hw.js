'use strict';
// Hardware-encoder recording path (Raspberry Pi 4/3: ffmpeg h264_v4l2m2m). There is no Pi here, so ffmpeg's software
// libx264 stands in for the hardware encoder (MULTICAM_HW_ENCODER) - everything else is the real pipeline:
// camera frames -> main process -> ffmpeg -> fragmented .mp4 segments. Also tests the fallbacks.
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const electron = require('electron');
const ffmpeg = require('ffmpeg-static');

function run(name, { seconds, settings = {}, env: extra = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `multicam-hw-${name}-`));
  fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'userdata', 'settings.json'), JSON.stringify({ codec: 'h264', ...settings }));
  const env = { ...process.env, MULTICAM_FAKE: '2', MULTICAM_SMOKE: String(seconds), MULTICAM_SMOKE_DIR: dir, ...extra }; delete env.ELECTRON_RUN_AS_NODE;
  spawnSync(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore', timeout: (seconds + 60) * 1000 });
  const out = path.join(dir, 'out'), cams = {};
  if (fs.existsSync(out)) for (const c of fs.readdirSync(out)) {
    if (c === 'snapshots') continue;
    const files = fs.readdirSync(path.join(out, c)).sort();
    cams[c] = {
      media: files.filter((f) => /\.(mp4|webm)$/.test(f)).map((f) => path.join(out, c, f)),
      side: files.filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(out, c, f), 'utf8')))
    };
  }
  return { dir, cams, result: JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')) };
}
const info = (f) => spawnSync(ffmpeg, ['-hide_banner', '-i', f], { encoding: 'utf8' }).stderr;
const decode = (f) => spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-stats', '-i', f, '-f', 'null', '-'], { encoding: 'utf8' });
const decodedSeconds = (f) => { const m = [...decode(f).stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)].pop(); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0; };
let ok = true;
const check = (n, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${x}`); if (!c) ok = false; };
const HW = { MULTICAM_HW_ENCODER: 'libx264' };

// A: normal hardware-path recording, 6 s segments
let r = run('rec', { seconds: 17, settings: { encoder: 'v4l2', segmentMinutes: 0.1 }, env: HW });
const names = Object.keys(r.cams);
check('two cameras recorded', names.length === 2, names.join(','));
for (const c of names) {
  const { media, side } = r.cams[c];
  check(`${c}: segments are .mp4 (no .webm), at least 2`, media.length >= 2 && media.every((f) => f.endsWith('.mp4')), `(${media.length} files)`);
  const bad = media.filter((f) => decode(f).status !== 0 || !/Video: h264/.test(info(f)));
  check(`${c}: every file decodes and is H.264`, bad.length === 0, bad.join(', '));
  check(`${c}: picture size is the camera's (1280x720)`, media.every((f) => /1280x720/.test(info(f))));
  const tcOk = media.every((f) => { const s = JSON.parse(fs.readFileSync(f.replace(/\.mp4$/, '.json'), 'utf8')); return info(f).includes('timecode        : ' + s.timecodeStart); });
  check(`${c}: timecode track equals the sidecar start timecode`, tcOk);
  check(`${c}: sidecar says mp4 / h264 / encoder`, side.every((s) => s.container === 'mp4' && s.codec === 'h264' && s.encoder === 'libx264' && s.durationMs > 0 && s.file.endsWith('.mp4')), JSON.stringify(side[0] && { c: side[0].container, e: side[0].encoder }));
  const gaps = side.slice(1).map((s, i) => s.startEpochMs - (side[i].startEpochMs + side[i].durationMs));
  check(`${c}: no gap between files`, gaps.every((g) => g <= 80), `(gaps ms: ${gaps.join(', ')})`);
  const off = media.map((f, i) => Math.abs(decodedSeconds(f) - side[i].durationMs / 1000));
  check(`${c}: each file's length matches its recorded duration (no stalls or lost time)`, off.every((d) => d < 1.5), `(differences s: ${off.map((d) => d.toFixed(2)).join(', ')})`);
}

// B: the size cap splits hardware-path files too
r = run('cap', { seconds: 30, settings: { encoder: 'v4l2', segmentMinutes: 60, bitrateKbps: 1000 }, env: { ...HW, MULTICAM_MAX_FILE_MB: '1', MULTICAM_FAKE: '1' } });
const cap = r.cams.cam1;
const sizes = cap ? cap.media.map((f) => fs.statSync(f).size) : [];
check('size cap: split into several files', sizes.length >= 3, `(${sizes.length} files: ${sizes.map((s) => (s / 1048576).toFixed(2)).join(', ')} MB)`);
check('size cap: no file is over 1 MB', sizes.every((s) => s <= 1048576));
check('size cap: every file decodes', cap && cap.media.every((f) => decode(f).status === 0));

// C: the encoder fails (does not exist): recording carries on in software and nothing is lost or left empty
r = run('fail', { seconds: 12, settings: { encoder: 'v4l2' }, env: { MULTICAM_HW_ENCODER: 'notarealencoder', MULTICAM_HW_ASSUME: '1', MULTICAM_FAKE: '1' } });
const f1 = r.cams.cam1 || { media: [], side: [] };
check('failing encoder: the log says it fell back to software', (r.result.logs || []).some((l) => /hardware encoder failed.*software/.test(l)), '');
check('failing encoder: recording continued as .webm with data', f1.media.some((f) => f.endsWith('.webm') && fs.statSync(f).size > 10000), f1.media.map((f) => path.basename(f)).join(', '));
check('failing encoder: no empty .mp4 or orphan sidecar left behind', !f1.media.some((f) => f.endsWith('.mp4')) && f1.side.every((s) => s.file.endsWith('.webm')));

// D: hardware option chosen but no such hardware (this PC): software recording, no errors
r = run('none', { seconds: 10, settings: { encoder: 'v4l2' }, env: { MULTICAM_FAKE: '1' } });
const n1 = r.cams.cam1 || { media: [] };
check('no hardware present: records normally in software (.webm)', n1.media.length >= 1 && n1.media.every((f) => f.endsWith('.webm')) && !(r.result.logs || []).some((l) => /hardware encoder/.test(l)), n1.media.map((f) => path.basename(f)).join(', '));

// E: burn-in label together with the hardware path
r = run('burn', { seconds: 12, settings: { encoder: 'v4l2', burnIn: true, width: 1280, height: 720 }, env: { ...HW, MULTICAM_FAKE: '1' } });
const b1 = r.cams.cam1;
let white = -1;
if (b1 && b1.media[0]) {
  const o = spawnSync(ffmpeg, ['-v', 'error', '-ss', '4', '-i', b1.media[0], '-frames:v', '1', '-vf', 'crop=iw*0.6:ih*0.2:0:ih*0.8,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  if (o.status === 0) { white = 0; for (const b of o.stdout) if (b > 235) white++; }
}
check('burn-in + hardware path: the label is in the recorded picture', white > 300, `(${white} bright pixels)`);

// F: the encoder dropdown offers the Pi option only where the hardware works
r = run('ui-hw', { seconds: 14, env: { ...HW, MULTICAM_FAKE: '3', MULTICAM_SMOKE_UI: '1' } });
const uiHw = JSON.parse(fs.readFileSync(path.join(r.dir, 'ui-result.json'), 'utf8'));
check('hardware available: the dropdown offers "Raspberry Pi hardware (H.264)"', /Raspberry Pi hardware \(H\.264\)/.test(uiHw.encoder || ''), JSON.stringify(uiHw.encoder));
r = run('ui-nohw', { seconds: 14, env: { MULTICAM_FAKE: '3', MULTICAM_SMOKE_UI: '1' } });
const uiNo = JSON.parse(fs.readFileSync(path.join(r.dir, 'ui-result.json'), 'utf8'));
check('no hardware: the dropdown does not offer it', !/Raspberry/.test(uiNo.encoder || ''), JSON.stringify(uiNo.encoder));

console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
