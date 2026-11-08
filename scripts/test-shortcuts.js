'use strict';
// Keyboard shortcuts and snapshots, driven in the real window: R record, P preview, S snapshot (selected camera,
// else all), the tile's snapshot button, Esc closes Settings, and shortcuts are ignored while typing in a field.
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const electron = require('electron');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicam-keys-'));
fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
const env = { ...process.env, MULTICAM_FAKE: '3', MULTICAM_SMOKE: '18', MULTICAM_SMOKE_DIR: dir, MULTICAM_SMOKE_KEYS: '1' }; delete env.ELECTRON_RUN_AS_NODE;
spawnSync(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });

let ok = true;
const check = (n, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${x}`); if (!c) ok = false; };
const k = JSON.parse(fs.readFileSync(path.join(dir, 'keys-result.json'), 'utf8'));
check('R stops recording, R again starts it', /Stop/.test(k.recInitial) && /Start/.test(k.recAfterR) && /Stop/.test(k.recAfterR2), `(${k.recInitial} -> ${k.recAfterR} -> ${k.recAfterR2})`);
check('P toggles the preview', k.prevInitial !== k.prevAfterP, `(${k.prevInitial} -> ${k.prevAfterP})`);
check('shortcuts are ignored while typing in a field', k.recWhileTyping === k.recAfterR2);
check('Esc closes Settings', k.settingsClosedByEsc === true);
check('snapshot button has a tooltip with its key', /S/.test(k.snapTitle || ''), `(${k.snapTitle})`);

const snaps = path.join(dir, 'out', 'snapshots');
const files = fs.existsSync(snaps) ? fs.readdirSync(snaps) : [];
const byCam = (c) => files.filter((f) => f.startsWith(c + '_')).length;
// selected camera (cam from tile 2) once; then all three cameras once; then tile 1's button once => 1 + 3 + 1 = 5 files
check('5 snapshots saved (selected: 1, all: 3, button: 1)', files.length === 5, `(${files.length}: ${files.join(', ')})`);
let valid = true, sizes = new Set();
for (const f of files) {
  const b = fs.readFileSync(path.join(snaps, f));
  if (b.length < 1000 || b.readUInt32BE(0) !== 0x89504e47) { valid = false; continue; }
  sizes.add(`${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`);          // PNG header: width, height
}
check('every snapshot is a real PNG at the camera resolution', valid && sizes.size === 1 && !sizes.has('0x0'), `(${[...sizes].join(', ')})`);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
