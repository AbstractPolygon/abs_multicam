'use strict';
// Update flow against a local fake release server: the app must find the newer version, download it, verify it,
// and show "Update vX" - without restarting by itself. Also unit-checks the version comparison.
const http = require('http'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const electron = require('electron');
const { newer } = require('../updates.js');

let ok = true;
const check = (n, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${x}`); if (!c) ok = false; };

check('version compare: 0.2.0 > 0.1.0, 1.0.0 > 0.9.9, v0.1.1 > 0.1.0', newer('0.2.0', '0.1.0') && newer('1.0.0', '0.9.9') && newer('v0.1.1', '0.1.0'));
check('version compare: equal or older is not newer', !newer('0.1.0', '0.1.0') && !newer('0.0.9', '0.1.0') && !newer('0.1.0', 'v0.2.0'));

const pkg = require('../package.json');
const version = '9.9.9';
const file = `ABS_MultiCam-Setup-${version}-x64.exe`;
const payload = crypto.randomBytes(300 * 1024);
const sha512 = crypto.createHash('sha512').update(payload).digest('base64');
const yml = `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: ${sha512}\n    size: ${payload.length}\npath: ${file}\nsha512: ${sha512}\nreleaseDate: '2026-11-08T00:00:00.000Z'\n`;
const hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url.startsWith('/latest.yml')) { res.writeHead(200, { 'Content-Type': 'text/yaml' }); return res.end(yml); }
  if (req.url.includes(file)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length }); return res.end(payload); }
  res.writeHead(404); res.end();
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicam-upd-'));
  fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
  const env = { ...process.env, MULTICAM_FAKE: '1', MULTICAM_SMOKE: '14', MULTICAM_SMOKE_DIR: dir, MULTICAM_SMOKE_UI: '', MULTICAM_UPDATE_URL: `http://127.0.0.1:${port}` };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('child_process').spawn(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  const killer = setTimeout(() => child.kill(), 60000);
  child.on('exit', (code) => {
    clearTimeout(killer); server.close();
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    console.log('app log:', (r.logs || []).filter((l) => /update/i.test(l)).join(' | '));
    check(`app (version ${pkg.version}) asked the server for latest.yml`, hits.some((h) => h.startsWith('/latest.yml')), JSON.stringify(hits));
    check('app downloaded the new installer', hits.some((h) => h.includes(file)));
    check('app reports the update as ready, for the right version', r.update && r.update.version === version && r.update.mode === 'install', JSON.stringify(r.update));
    check('app did not restart or quit by itself before the test ended', code === 0 && r.report.length === 1);
    console.log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  });
});
