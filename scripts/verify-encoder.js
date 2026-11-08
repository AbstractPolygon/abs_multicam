'use strict';
// Measures which GPU's video-encode engine the app really uses (Windows only, uses real cameras).
//   node scripts/verify-encoder.js [seconds=12]
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const electron = require('electron');
const seconds = parseInt(process.argv[2] || '12', 10);
if (process.platform !== 'win32') { console.error('Windows only'); process.exit(2); }

function run(mode, codec) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `multicam-ver-${mode}-`));
    fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'userdata', 'settings.json'), JSON.stringify({ encoder: mode, codec, bitrateKbps: 6000, segmentMinutes: 5 }));
    const env = { ...process.env, MULTICAM_SMOKE: String(seconds + 8), MULTICAM_SMOKE_DIR: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = spawn(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
    setTimeout(() => {                                   // let cameras open and recording settle first
      const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'sample-gpu.ps1'), '-RootPid', String(app.pid), '-Seconds', String(seconds)], { encoding: 'utf8' });
      let m = {}; try { m = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (_) { m = { error: (r.stderr || r.stdout || '').slice(0, 300) }; }
      app.on('exit', () => {
        const f = path.join(dir, 'result.json');
        const res = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
        resolve({ m, res });
      });
    }, 7000);
  });
}

(async () => {
  const rows = [];
  for (const [mode, codec] of [['high', 'h264'], ['cpu', 'h264'], ['high', 'vp8']]) {
    const { m, res } = await run(mode, codec);
    const gpu = res && res.gpu ? res.gpu.active.join(',') : '?';
    const enc = m.encodeByLuid || {};
    const luids = Object.keys(enc);
    const desc = luids.length ? luids.map((l) => `LUID ${l.slice(-8)} (${m.dedicatedMB && m.dedicatedMB[l] != null ? m.dedicatedMB[l] + ' MB dedicated' : '?'}): avg ${enc[l].avg}% max ${enc[l].max}%`).join('; ') : 'no video-encode engine activity';
    console.log(`${mode.padEnd(4)} ${codec.padEnd(4)} active GPU=[${gpu}]  encode engine: ${desc}  | app CPU ${m.appCpuCores} cores busy  cameras=${res ? res.report.length : '?'}${m.error ? ' ERR ' + m.error : ''}`);
    rows.push({ mode, codec, enc, gpu });
  }
})();
