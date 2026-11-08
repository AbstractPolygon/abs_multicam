'use strict';
// .msi update flow (Windows only) against a local fake GitHub release: the app must find the newer release, download
// the .msi, accept it only when its SHA-256 matches the hash the release lists, and "Update" must run an msiexec upgrade
// of that file and start the app again. A wrong hash must be refused (the app falls back to the download page).
const http = require('http'), crypto = require('crypto');
const fs = require('fs'), os = require('os'), path = require('path');
const electron = require('electron');

if (process.platform !== 'win32') { console.log('skipped (the .msi path is Windows only)'); process.exit(0); }
let ok = true;
const check = (n, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${x}`); if (!c) ok = false; };

const version = '9.9.9';
const name = `ABS_MultiCam-${version}-win-x64.msi`;
const payload = crypto.randomBytes(400 * 1024);

function run(label, digest) {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url);
      const base = `http://127.0.0.1:${server.address().port}`;
      if (req.url === '/releases/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ tag_name: `v${version}`, html_url: `${base}/release`, assets: [{ name, browser_download_url: `${base}/dl/${name}`, digest }] }));
      }
      if (req.url === `/dl/${name}`) { res.writeHead(200, { 'Content-Length': payload.length }); return res.end(payload); }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicam-msi-'));
      fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
      const dry = path.join(dir, 'msiexec-command.txt');
      const env = { ...process.env, MULTICAM_FAKE: '1', MULTICAM_SMOKE: '12', MULTICAM_SMOKE_DIR: dir, MULTICAM_SMOKE_UI: '',
        MULTICAM_FORCE_MSI: '1', MULTICAM_RELEASE_API: `http://127.0.0.1:${server.address().port}`, MULTICAM_MSI_DRYRUN: dry };
      delete env.ELECTRON_RUN_AS_NODE; delete env.MULTICAM_UPDATE_URL; delete env.PORTABLE_EXECUTABLE_FILE;
      const child = require('child_process').spawn(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
      const killer = setTimeout(() => child.kill(), 60000);
      child.on('exit', () => {
        clearTimeout(killer); server.close();
        const r = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
        const cmd = fs.existsSync(dry) ? fs.readFileSync(dry, 'utf8') : '';
        const tmp = path.join(os.tmpdir(), name);
        resolve({ label, hits, r, cmd, tmp, logs: (r.logs || []).filter((l) => /update/i.test(l)).join(' | ') });
      });
    });
  });
}

(async () => {
  try { fs.unlinkSync(path.join(os.tmpdir(), name)); } catch (_) { /* none */ }
  const good = await run('matching hash', 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex'));
  console.log('log:', good.logs);
  check('good hash: the .msi was downloaded', good.hits.includes(`/dl/${name}`));
  check('good hash: update is offered as an install of the right version', good.r.update && good.r.update.version === version && good.r.update.mode === 'install', JSON.stringify(good.r.update));
  check('good hash: the downloaded file is exactly the release file', fs.existsSync(good.tmp) && fs.readFileSync(good.tmp).equals(payload));
  check('good hash: Update runs msiexec /i on that file and restarts the app', /msiexec \/i "[^"]*9\.9\.9-win-x64\.msi" \/passive/.test(good.cmd) && /&& start ""/.test(good.cmd), good.cmd);
  try { fs.unlinkSync(good.tmp); } catch (_) { /* gone */ }

  const bad = await run('wrong hash', 'sha256:' + '0'.repeat(64));
  console.log('log:', bad.logs);
  check('wrong hash: the file is refused and removed', !fs.existsSync(bad.tmp));
  check('wrong hash: falls back to the download page, nothing is installed', bad.r.update && bad.r.update.mode === 'open' && bad.cmd === '', JSON.stringify(bad.r.update));

  const none = await run('no hash listed', undefined);
  check('no hash listed: nothing is downloaded, falls back to the download page', !none.hits.includes(`/dl/${name}`) && none.r.update && none.r.update.mode === 'open', JSON.stringify(none.r.update));

  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
