'use strict';
// Re-wrap ABS_MultiCam recordings as .mov files that carry an embedded timecode track, so Premiere,
// DaVinci Resolve, Final Cut etc. can sync all cameras automatically ("synchronize by timecode").
//
//   node scripts/export-timecode.js <recordings folder> [--out <folder>] [--ffmpeg <path>]
//                                   [--crf 18] [--preset veryfast] [--overwrite]
//
// For every <segment>.webm that has a <segment>.json sidecar it writes <out>/<camera folder>/<segment>.mov
// (H.264, constant frame rate = the timecode frame rate, no audio) whose start timecode is the time of day the
// segment started, taken from the PC clock shared by all cameras. It also writes sync.csv listing every file.
// Needs ffmpeg (on PATH, or pass --ffmpeg, or set FFMPEG). Re-encoding is why this is a separate step.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes(name);
const root = argv.find((a, i) => !a.startsWith('--') && !['--out', '--ffmpeg', '--crf', '--preset'].includes(argv[i - 1]));
if (!root || flag('--help')) {
  console.log('usage: node scripts/export-timecode.js <recordings folder> [--out <folder>] [--ffmpeg <path>] [--crf 18] [--preset veryfast] [--overwrite]');
  process.exit(root ? 0 : 2);
}
const ffmpeg = opt('--ffmpeg', process.env.FFMPEG || 'ffmpeg');
const outRoot = path.resolve(opt('--out', path.join(root, 'timecode_export')));
const crf = opt('--crf', '18');
const preset = opt('--preset', 'veryfast');

const probe = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) { console.error(`ffmpeg not found (tried "${ffmpeg}"). Install it or pass --ffmpeg <path>.`); process.exit(2); }

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (p.startsWith(outRoot)) continue;                   // don't re-read our own output
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

const items = [];
for (const f of walk(path.resolve(root))) {
  if (!f.endsWith('.json')) continue;
  let meta; try { meta = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
  if (meta.app !== 'ABS_MultiCam' || !meta.timecodeStart) continue;
  const webm = f.replace(/\.json$/, '.webm');
  if (fs.existsSync(webm)) items.push({ webm, meta });
}
items.sort((a, b) => a.meta.startEpochMs - b.meta.startEpochMs);
if (!items.length) { console.error('no ABS_MultiCam segments with sidecars found in ' + root); process.exit(1); }

const rows = [['camera', 'folder', 'slot', 'source', 'output', 'startLocal', 'startUtc', 'timecodeStart', 'fps', 'durationMs', 'status']];
let failed = 0;
for (const { webm, meta } of items) {
  const folder = meta.folder || path.basename(path.dirname(webm));
  const outDir = path.join(outRoot, folder);
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, path.basename(webm).replace(/\.webm$/, '.mov'));
  let status = 'ok';
  if (fs.existsSync(out) && !flag('--overwrite')) status = 'skipped (exists)';
  else {
    const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', webm, '-an',
      '-vf', `fps=${meta.timecodeFps}`, '-c:v', 'libx264', '-preset', preset, '-crf', crf, '-pix_fmt', 'yuv420p',
      '-timecode', meta.timecodeStart, '-metadata', `creation_time=${meta.startUtc}`, out], { encoding: 'utf8' });
    if (r.status !== 0) { status = 'FAILED: ' + String(r.stderr || r.error).trim().split('\n').pop(); failed++; }
  }
  console.log(`${status.padEnd(8)} ${path.relative(outRoot, out)}  tc ${meta.timecodeStart} @${meta.timecodeFps}`);
  rows.push([meta.camera, folder, meta.slot, path.basename(webm), path.relative(outRoot, out), meta.startLocal, meta.startUtc,
    meta.timecodeStart, meta.timecodeFps, meta.durationMs ?? '', status]);
}
const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
fs.writeFileSync(path.join(outRoot, 'sync.csv'), csv);
console.log(`\n${items.length - failed}/${items.length} exported to ${outRoot}\nsync list: ${path.join(outRoot, 'sync.csv')}`);
process.exit(failed ? 1 : 0);
