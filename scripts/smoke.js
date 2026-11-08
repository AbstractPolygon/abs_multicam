'use strict';
// Headless self-test: launches the app with N fake cameras (Chromium's built-in test devices),
// records for a few seconds with very short segments, then checks that every camera produced files.
//   node scripts/smoke.js [cameras=4] [seconds=12]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cameras = parseInt(process.argv[2] || '4', 10);
const seconds = parseInt(process.argv[3] || '12', 10);
const electron = require('electron');                   // path to the electron binary
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicam-smoke-'));

const uiTest = process.argv[4] === 'ui';                   // node scripts/smoke.js 3 14 ui
const env = { ...process.env, MULTICAM_FAKE: String(cameras), MULTICAM_SMOKE: String(seconds),
  MULTICAM_SMOKE_DIR: dir, MULTICAM_SEG_MIN: '0.1' };    // 6-second segments
if (uiTest) { env.MULTICAM_SMOKE_UI = '1'; if (cameras !== 3) { console.error('UI test needs exactly 3 cameras'); process.exit(2); } }
delete env.ELECTRON_RUN_AS_NODE;

const args = ['.'];
if (process.platform === 'linux') args.push('--no-sandbox');   // typical in CI containers
console.log(`smoke test: ${cameras} fake camera(s), ${seconds}s, data in ${dir}`);
const child = spawn(electron, args, { cwd: path.join(__dirname, '..'), env, stdio: 'inherit' });

const killer = setTimeout(() => { console.error('TIMEOUT: app did not finish'); child.kill(); }, (seconds + 40) * 1000);
child.on('exit', () => {
  clearTimeout(killer);
  const file = path.join(dir, 'result.json');
  if (!fs.existsSync(file)) { console.error('FAIL: no result.json (app did not complete the run)'); process.exit(1); }
  const { report, files } = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log('cameras:', report.map((c) => `${c.name} [${c.info}] ${c.bytes}B ${c.status}`).join(' | '));
  console.log('files:', files.length, files.map((f) => `${f.file}=${f.size}`).join(', '));
  let ok = report.length === cameras;
  for (const c of report) {
    const mine = files.filter((f) => f.file.startsWith(c.folder + path.sep) && f.size > 0);
    if (!mine.length) { ok = false; console.error(`FAIL: no data for ${c.name}`); }
  }
  if (uiTest) {
    const uiFile = path.join(dir, 'ui-result.json');
    const ui = fs.existsSync(uiFile) ? JSON.parse(fs.readFileSync(uiFile, 'utf8')) : { error: 'no ui-result.json' };
    console.log('ui:', JSON.stringify(ui));
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const check = (name, cond) => { if (!cond) { ok = false; console.error(`FAIL: ${name}`); } else console.log(`ok: ${name}`); };
    check('slots start 1,2,3', eq(ui.start, { cam1: 1, cam2: 2, cam3: 3 }));
    check('click highlights only that card', eq(ui.selected, ['cam2']));
    check('dropdown swaps slots', eq(ui.afterDropdown, { cam1: 3, cam2: 2, cam3: 1 }));
    check('drag & drop reorders', eq(ui.afterDrag, { cam1: 2, cam2: 1, cam3: 3 }));
    check('grid order follows slots', eq(ui.cssOrder, { cam1: '2', cam2: '1', cam3: '3' }));
    check('fullscreen button works', ui.fullscreen === true);
    check('fullscreen exits', ui.exited === true);
    const ic = ui.icons || {};
    check('toolbar buttons are icons with tooltips', ['btnRecord', 'btnPreview', 'btnFolder', 'btnSettings'].every((id) => ic[id] && ic[id].svg && ic[id].text === '' && ic[id].tip));
    check('record button shows stop while recording', ic.btnRecord && /stop/i.test(ic.btnRecord.tip));
    check('preview icon toggles', ui.previewToggled === true);
    check('movement slider hidden until "Record on movement" is checked', ui.motionHiddenByDefault === true && ui.motionShownWhenChecked === true && ui.motionHiddenWhenUnchecked === true);
    const o = ui.order || {};
    check('settings order: auto-start, record on movement, slider, encoder', o.autostartThenMotion && o.motionThenEncoder && o.levelThenEncoder);
    check('output folder is last, just above Apply/Close', o.outputLastBeforeApply);
    check('tiles show only resolution/fps (no "asked")', typeof ui.tileInfo === 'string' && !/asked/.test(ui.tileInfo));
    const tl = ui.tile || {};
    check('record indicator is in the top-left corner of the video', tl.recTopLeft);
    check('"live" is in the bottom-left corner', tl.liveBottomLeft && tl.live === 'live');
    check('timecode is to the right of "live"', tl.tcRightOfLive);
    check('timecode looks like HH:MM:SS:FF and keeps running', tl.tcFormat && tl.tcTicks);
    check('full-screen button still top-right', tl.fsTopRight);
    check('default file size cap is 4 GB', ui.maxFileBytes === 4 * 1024 ** 3, `(${ui.maxFileBytes})`);
    const hd = ui.header || {};
    check('version shown next to the app name', hd.version === 'v' + require('../package.json').version && hd.versionNextToName && hd.sameBaseline, `(${hd.version})`);
    check('camera count sits next to the tile size slider', hd.countBeforeSlider && hd.countNextToSlider && /^3 cameras$/.test(hd.countText), `(${hd.countText})`);
    console.log('screenshot:', path.join(dir, 'screenshot.png'));
    check('no File/Edit/View menu bar (Windows/Linux)', process.platform === 'darwin' || (ui.menu && ui.menu.appMenu === 'none' && ui.menu.barVisible === false));
    const slots = Object.fromEntries(report.map((c) => [c.folder, c.slot]));
    check('final report matches', eq(slots, { cam1: 2, cam2: 1, cam3: 3 }));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'userdata', 'settings.json'), 'utf8')).cameras;
    const keys = Object.values(saved).map((c) => c.slot);
    check('slots saved and unique', keys.length === 3 && new Set(keys).size === 3);
  }
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
});
