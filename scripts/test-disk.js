'use strict';
// Low-disk-space warning: the footer turns amber below twice the "keep drive free" amount (default 10 GB) and
// red below that amount. Free space is faked with MULTICAM_FAKE_FREE_GB.
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const electron = require('electron');
let ok = true;
const check = (n, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${x}`); if (!c) ok = false; };
function run(freeGB) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicam-disk-'));
  fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
  const env = { ...process.env, MULTICAM_FAKE: '1', MULTICAM_SMOKE: '5', MULTICAM_SMOKE_DIR: dir, MULTICAM_FAKE_FREE_GB: String(freeGB) }; delete env.ELECTRON_RUN_AS_NODE;
  spawnSync(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  return JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')).disk;
}
let d = run(100); check('plenty of space: normal readout', !/warn|crit/.test(d.cls) && d.text.startsWith('Free space'), `(${d.text.slice(0, 40)} | ${d.cls})`);
d = run(15);  check('15 GB free (under 2x the 10 GB keep-free): amber warning', /warn/.test(d.cls) && d.text.startsWith('Low disk space'), `(${d.text.slice(0, 40)} | ${d.cls})`);
d = run(4);   check('4 GB free (under the 10 GB keep-free): red warning', /crit/.test(d.cls) && d.text.startsWith('Low disk space'), `(${d.text.slice(0, 40)} | ${d.cls})`);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
