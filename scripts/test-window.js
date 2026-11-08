'use strict';
// Window position memory: move/resize the window, restart, and check it comes back where it was;
// a position saved on a screen that no longer exists must still open on a visible screen.
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const electron = require('electron');

function run(dir, extra) {
  const env = { ...process.env, MULTICAM_FAKE: '1', MULTICAM_SMOKE: '5', MULTICAM_SMOKE_DIR: dir, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  spawnSync(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  return JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
}
let ok = true;
const check = (n, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${x}`); if (!c) ok = false; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicam-win-'));
fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
const first = run(dir, { MULTICAM_SMOKE_SETBOUNDS: '120,90,1000,700' });
check('window moved and resized in the first run', first.bounds && first.bounds.width === 1000 && first.bounds.height === 700, JSON.stringify(first.bounds));
const second = run(dir, {});
check('second run opens at the same position and size', second.bounds && ['x', 'y', 'width', 'height'].every((k) => second.bounds[k] === first.bounds[k]), JSON.stringify(second.bounds));

const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'multicam-win2-'));
fs.mkdirSync(path.join(dir2, 'userdata'), { recursive: true });
fs.writeFileSync(path.join(dir2, 'userdata', 'settings.json'), JSON.stringify({ windowBounds: { x: -30000, y: -30000, width: 900, height: 600, maximized: false } }));
const off = run(dir2, {});
const b = off.bounds, onScreen = off.workAreas.some((a) => b.x + 100 < a.x + a.width && b.x + b.width - 100 > a.x && b.y + 50 < a.y + a.height && b.y >= a.y - 50);
check('position saved on a missing screen opens on a visible screen, same size', onScreen && b.width === 900 && b.height === 600, JSON.stringify(b));
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
