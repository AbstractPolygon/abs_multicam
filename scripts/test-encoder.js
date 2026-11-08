'use strict';
// Encoder tests. For each choice (best GPU, second GPU, CPU, and the old "auto" value) the app is started
// with that setting saved, records from cameras, and the script checks which GPU Chromium used, the
// video-encode status, whether Chromium's capture process crashed, and that every file decodes.
// Then it drives the real UI (pick CPU, press Apply) and checks that the app restarts with CPU encoding.
//   node scripts/test-encoder.js [seconds=10] [--real]     --real: use the attached cameras instead of fake ones
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const seconds = parseInt(process.argv.slice(2).find((a) => /^\d+$/.test(a)) || '10', 10);
const real = process.argv.includes('--real');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const hasFfmpeg = !spawnSync(ffmpeg, ['-version']).error;
const gpuCase = (g) => g.encode === 'enabled' && g.active.length === 1;
const cases = [
  { mode: 'high', expect: gpuCase },
  { mode: 'cpu', expect: (g) => g.encode !== 'enabled' },
  { mode: 'auto', expect: gpuCase }                       // old saved value: must behave like "high"
];

function launch(dir, extraEnv) {
  return new Promise((resolve) => {
    const env = { ...process.env, MULTICAM_FAKE: real ? '0' : '2', MULTICAM_SMOKE: String(seconds), MULTICAM_SMOKE_DIR: dir, MULTICAM_SEG_MIN: '0.1', ...extraEnv };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const killer = setTimeout(() => child.kill(), (seconds + 40) * 1000);
    child.on('exit', () => { clearTimeout(killer); resolve(out); });
  });
}
const readResult = (dir) => { const f = path.join(dir, 'result.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
const mkdir = (tag, settings) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `multicam-enc-${tag}-`));
  fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'userdata', 'settings.json'), JSON.stringify(settings));
  return dir;
};
function decodeCheck(dir, result) {
  if (!hasFfmpeg) return { bad: [], text: 'ffmpeg not found (decode check skipped)' };
  const bad = result.files.filter((x) => x.size > 0 && spawnSync(ffmpeg, ['-v', 'error', '-i', path.join(dir, 'out', x.file), '-f', 'null', '-'], { encoding: 'utf8' }).status !== 0);
  return { bad, text: bad.length ? `UNREADABLE: ${bad.map((b) => b.file).join(', ')}` : `all ${result.files.length} files decode` };
}

(async () => {
  let ok = true;
  const active = {};
  for (const c of cases) {
    const dir = mkdir(c.mode, { encoder: c.mode, codec: 'h264' });
    const out = await launch(dir, {});
    const result = readResult(dir);
    const crashes = out.split('\n').filter((l) => l.includes('child-process-gone')).length;
    if (!result) { console.log(`FAIL ${c.mode}: no result`); ok = false; continue; }
    const g = result.gpu || { active: [], encode: '?' };
    active[c.mode] = g.active.join(',');
    const n = result.report.length;
    const withData = result.report.filter((r) => result.files.some((x) => x.file.startsWith(r.folder + path.sep) && x.size > 0)).length;
    const dec = decodeCheck(dir, result);
    const expectPref = c.mode === 'auto' ? 'auto' : c.mode;
    const pass = c.expect(g) && g.pref === expectPref && n > 0 && withData === n && !dec.bad.length && crashes === 0;
    if (!pass) ok = false;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${c.mode.padEnd(4)} encode=${g.encode} GPU=[${g.active.join(', ')}] cameras=${n} with data=${withData} capture crashes=${crashes}  ${dec.text}`);
  }
  if (active.auto !== active.high) { ok = false; console.log('FAIL old "auto" does not use the same GPU as "high"'); } else console.log('ok   old "auto" value uses the same GPU as "high"');

  // UI flow: choose CPU in the dropdown and press Apply -> app must restart with CPU encoding and keep recording
  const dir = mkdir('ui', { encoder: 'high', codec: 'h264' });
  await launch(dir, { MULTICAM_SMOKE_ENC: 'cpu' });
  let r = null;
  for (let i = 0; i < 60 && !(r && r.gpu && r.gpu.pref === 'cpu'); i++) { await new Promise((res) => setTimeout(res, 1000)); r = readResult(dir); }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'userdata', 'settings.json'), 'utf8')).encoder;
  const uiPass = !!(r && r.gpu && r.gpu.pref === 'cpu' && r.gpu.encode !== 'enabled' && saved === 'cpu' && r.report.length > 0);
  if (!uiPass) ok = false;
  console.log(`${uiPass ? 'ok  ' : 'FAIL'} UI: choose CPU + Apply -> saved="${saved}", restarted with pref=${r && r.gpu ? r.gpu.pref : 'none'} encode=${r && r.gpu ? r.gpu.encode : '?'} cameras=${r ? r.report.length : 0}`);
  await new Promise((res) => setTimeout(res, 1500));      // let the relaunched instance exit
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
