'use strict';
// ABS_MultiCam - main process: window, settings, recording file I/O, loop cleanup.
const { app, BrowserWindow, Menu, ipcMain, dialog, session, shell, systemPreferences, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const fsp = fs.promises;

const GB = 1024 * 1024 * 1024;
const FAKE = parseInt(process.env.MULTICAM_FAKE || '0', 10) || 0;     // N fake cameras (testing)
const SMOKE = parseInt(process.env.MULTICAM_SMOKE || '0', 10) || 0;   // self-test seconds (testing)
const SMOKE_DIR = process.env.MULTICAM_SMOKE_DIR || '';
const RENDERER_DIR = path.join(__dirname, 'renderer');
const DEV = process.argv.includes('--dev');          // npm run dev: refresh the open window when files change

// One window only: launching again focuses the existing one instead of opening another.
// (Self-tests use their own data folder, so they don't count as a second instance.)
const gotLock = SMOKE ? true : app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

if (FAKE > 0) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream', `device-count=${FAKE}`);
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  if (process.env.MULTICAM_FAKE_FILE) app.commandLine.appendSwitch('use-file-for-fake-video-capture', process.env.MULTICAM_FAKE_FILE);   // tests: play a .y4m clip
}
// GPU video encoding for the recorders (used automatically when the driver supports it; otherwise software)
app.commandLine.appendSwitch('ignore-gpu-blocklist');
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'VaapiVideoEncoder,VaapiVideoDecoder');
app.commandLine.appendSwitch('disable-renderer-backgrounding');       // recording must not slow down when the window is hidden
app.commandLine.appendSwitch('disable-background-timer-throttling');
if (SMOKE && SMOKE_DIR) app.setPath('userData', path.join(SMOKE_DIR, 'userdata'));

// Encoder choice must be known before Chromium starts: high = fastest GPU, cpu = software. (Forcing the integrated GPU
// does not move video encoding off the main GPU's encoder, so there is no such option.)
let encoderPref = 'auto';
try { encoderPref = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')).encoder || 'auto'; } catch (_) {}
if (encoderPref === 'cpu') app.commandLine.appendSwitch('disable-accelerated-video-encode');
else app.commandLine.appendSwitch('force_high_performance_gpu');

// A custom, secure scheme gives the renderer a stable origin (stable camera device IDs).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

const DEFAULTS = {
  outputDir: '',
  segmentMinutes: 5,
  maxGBPerCamera: 10,
  maxAgeHours: 0,
  minFreeGB: 10,
  width: 1280,
  height: 720,
  fps: 30,
  bitrateKbps: 2500,
  codec: 'h264',
  encoder: 'high',
  motion: false,
  motionLevel: 1,
  nameFilter: '',
  autoStart: false,
  preview: true,
  tileMin: 360,
  cameras: {}
};

let settings = null;
let win = null;
let closing = false;
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  let s = { ...DEFAULTS };
  try { s = { ...s, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; } catch (_) { /* first run */ }
  if (!s.outputDir) s.outputDir = SMOKE_DIR ? path.join(SMOKE_DIR, 'out') : path.join(app.getPath('videos'), 'ABS_MultiCam');
  if (process.env.MULTICAM_SEG_MIN) s.segmentMinutes = parseFloat(process.env.MULTICAM_SEG_MIN) || s.segmentMinutes;
  return s;
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (e) { log(`could not save settings: ${e.message}`); }
}

function sanitize(p) {
  const out = {};
  const num = (k, min, max) => {
    if (p[k] === undefined) return;
    const v = Number(p[k]);
    if (Number.isFinite(v)) out[k] = Math.min(max, Math.max(min, v));
  };
  num('segmentMinutes', 0.02, 240); num('maxGBPerCamera', 0, 1e5); num('maxAgeHours', 0, 1e5);
  num('minFreeGB', 0, 1e5); num('width', 160, 7680); num('height', 120, 4320);
  num('fps', 1, 120); num('bitrateKbps', 100, 1e5); num('tileMin', 200, 1200);
  if (typeof p.outputDir === 'string' && p.outputDir) out.outputDir = p.outputDir;
  if (typeof p.nameFilter === 'string') out.nameFilter = p.nameFilter.slice(0, 100);
  if (['auto', 'vp8', 'vp9', 'h264'].includes(p.codec)) out.codec = p.codec;
  if (['high', 'cpu'].includes(p.encoder)) out.encoder = p.encoder;
  if (typeof p.motion === 'boolean') out.motion = p.motion;
  if (p.motionLevel !== undefined) out.motionLevel = Math.min(2, Math.max(0, Math.round(Number(p.motionLevel)) || 0));
  for (const k of ['autoStart', 'preview']) if (typeof p[k] === 'boolean') out[k] = p[k];
  if (p.cameras && typeof p.cameras === 'object') {
    out.cameras = {};
    for (const [id, c] of Object.entries(p.cameras)) {
      if (!c || typeof c !== 'object') continue;
      if (typeof c.folder !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(c.folder)) continue;
      const entry = {
        name: String(c.name || c.folder).slice(0, 60),
        folder: c.folder,
        enabled: c.enabled !== false
      };
      // optional per-camera resolution override (absent = use the global setting)
      const w = Number(c.width), h = Number(c.height);
      if (Number.isFinite(w) && Number.isFinite(h) && w >= 160 && w <= 7680 && h >= 120 && h <= 4320) {
        entry.width = Math.round(w); entry.height = Math.round(h);
      }
      const sl = Number(c.slot);                           // grid position (sort key)
      if (Number.isInteger(sl) && sl >= 1 && sl <= 100000) entry.slot = sl;
      const f = Number(c.fps);
      if (c.fps !== undefined && c.fps !== null && Number.isFinite(f) && f >= 1 && f <= 120) entry.fps = Math.round(f);
      out.cameras[String(id).slice(0, 200)] = entry;
    }
  }
  return out;
}

function log(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('log', msg);
}

// ---------- recording files ----------
const openRecs = new Map(); // recId -> { file, stream, bytes }
let nextRecId = 1;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

ipcMain.handle('rec:open', async (_e, folderIn) => {
  const folder = String(folderIn).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'cam';
  const dir = path.join(settings.outputDir, folder);
  await fsp.mkdir(dir, { recursive: true });
  let file = path.join(dir, `${folder}_${stamp()}.webm`);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${folder}_${stamp()}_${i}.webm`);
  const stream = fs.createWriteStream(file);
  const id = nextRecId++;
  openRecs.set(id, { file, stream, bytes: 0 });
  return { id, file };
});

ipcMain.on('rec:write', (_e, id, data) => {
  const r = openRecs.get(id);
  if (!r) return;
  const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  r.bytes += buf.length;
  r.stream.write(buf);
});

// ---------- timecode sidecar (<segment>.json) ----------
// Every camera is stamped from the same PC clock, so time-of-day timecode lines the cameras up.
const sidecarPath = (file) => file.replace(/\.webm$/, '.json');
const pad = (n, w = 2) => String(n).padStart(w, '0');

function timecodeAt(ms, fps) {                       // HH:MM:SS:FF, non-drop, local time of day
  const d = new Date(ms);
  const ff = Math.min(fps - 1, Math.floor((d.getMilliseconds() / 1000) * fps));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}:${pad(ff)}`;
}
function localIso(ms) {                              // 2026-11-07T18:25:54.123-05:00
  const d = new Date(ms);
  const off = -d.getTimezoneOffset(), a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
function writeSidecar(r) {
  try { fs.writeFileSync(sidecarPath(r.file), JSON.stringify(r.sidecar, null, 2)); } catch (_) { /* not fatal */ }
}
async function removeRec(file) {                     // delete a segment together with its sidecar
  for (const f of [file, sidecarPath(file)]) { try { await fsp.unlink(f); } catch (_) { /* already gone */ } }
}

ipcMain.handle('rec:meta', (_e, id, m) => {
  const r = openRecs.get(id);
  if (!r || !m) return;
  const start = Number(m.startEpochMs) || Date.now();
  const fps = Math.min(120, Math.max(1, Math.round(Number(m.fps) || 30)));
  r.sidecar = {
    app: 'ABS_MultiCam',
    file: path.basename(r.file),
    camera: String(m.camera || '').slice(0, 60),
    folder: String(m.folder || '').slice(0, 40),
    slot: Number(m.slot) || null,
    startLocal: localIso(start),
    startUtc: new Date(start).toISOString(),
    startEpochMs: start,
    timecodeStart: timecodeAt(start, fps),
    timecodeFps: fps,
    dropFrame: false,
    timecodeSource: 'PC clock, local time of day (same clock for every camera)',
    width: Number(m.width) || null,
    height: Number(m.height) || null,
    frameRate: Number(m.frameRate) || null,
    accuracy: 'Start = the moment the recorder was started. The first frame arrives a little later (camera and encoder delay), so this is not frame-accurate.'
  };
  writeSidecar(r);                                   // written now so it exists even if the app crashes mid-segment
});

async function finishRec(id, endMs) {
  const r = openRecs.get(id);
  if (!r) return 0;
  await new Promise((res) => r.stream.end(res));
  openRecs.delete(id);
  if (r.bytes === 0) { await removeRec(r.file); return 0; }
  if (r.sidecar) {
    const end = Number(endMs) || Date.now();
    r.sidecar.endUtc = new Date(end).toISOString();
    r.sidecar.durationMs = end - r.sidecar.startEpochMs;
    r.sidecar.bytes = r.bytes;
    writeSidecar(r);
  }
  return r.bytes;
}
ipcMain.handle('rec:close', (_e, id, endMs) => finishRec(id, endMs));

// Finish every open recording file (used before the page is reloaded or the app restarts in dev mode).
async function closeAllRecs() {
  for (const id of [...openRecs.keys()]) await finishRec(id);
}

// ---------- dev mode: refresh the same window in place ----------
function startDevWatch() {
  const later = (fn) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, 300); }; };
  // renderer files -> reload the page in the same window (recording resumes if it was running)
  fs.watch(RENDERER_DIR, { recursive: true }, later(async () => {
    await closeAllRecs();
    if (win && !win.isDestroyed()) { win.webContents.reloadIgnoringCache(); console.log('[dev] reloaded renderer'); }
  }));
  // main/preload changes can't be hot-swapped -> restart the one app instance (old one exits first)
  const restart = later(async () => {
    await closeAllRecs();
    console.log('[dev] restarting app');
    app.relaunch({ args: process.argv.slice(1) });
    app.exit(0);
  });
  fs.watch(__filename, restart);
  fs.watch(path.join(__dirname, 'preload.js'), restart);
  console.log('[dev] watching for changes');
}

// ---------- loop cleanup ----------
async function listFinished() {
  const root = settings.outputDir;
  const open = new Set([...openRecs.values()].map((r) => r.file));
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch (_) { return []; }
  const groups = [];
  for (const d of entries.filter((x) => x.isDirectory())) {
    const dir = path.join(root, d.name);
    let names = [];
    try { names = await fsp.readdir(dir); } catch (_) { continue; }
    const files = [];
    for (const n of names) {
      if (!n.endsWith('.webm')) continue;
      const f = path.join(dir, n);
      try { const st = await fsp.stat(f); files.push({ f, size: st.size, mtime: st.mtimeMs, open: open.has(f) }); } catch (_) { /* gone */ }
    }
    files.sort((a, b) => a.mtime - b.mtime);
    groups.push({ dir, files });
  }
  return groups;
}

async function freeBytes() {
  try { await fsp.mkdir(settings.outputDir, { recursive: true }); const st = await fsp.statfs(settings.outputDir); return st.bavail * st.bsize; }
  catch (_) { return null; }
}

async function runCleanup() {
  if (!settings) return;
  const cap = settings.maxGBPerCamera * GB;
  const maxAge = settings.maxAgeHours * 3600e3;
  const leftovers = [];
  for (const g of await listFinished()) {
    let total = g.files.reduce((s, x) => s + x.size, 0);
    let trimming = true;
    for (const x of g.files) {
      if (x.open) continue;
      const tooBig = cap > 0 && total > cap;
      const tooOld = maxAge > 0 && Date.now() - x.mtime > maxAge;
      if (trimming && (tooBig || tooOld)) {
        await removeRec(x.f); total -= x.size; log(`cleanup: removed ${path.basename(x.f)}`); continue;
      }
      trimming = false;
      leftovers.push(x);
    }
  }
  // free-space guard
  let free = await freeBytes();
  if (free === null || settings.minFreeGB <= 0) return;
  leftovers.sort((a, b) => a.mtime - b.mtime);
  while (free < settings.minFreeGB * GB && leftovers.length) {
    const x = leftovers.shift();
    await removeRec(x.f); free += x.size; log(`low disk space: removed ${path.basename(x.f)}`);
  }
  if (free < settings.minFreeGB * GB) log('WARNING: low disk space and nothing left to delete');
}

ipcMain.handle('disk:info', async () => {
  const groups = await listFinished();
  const perCamera = groups.map((g) => ({ folder: path.basename(g.dir), files: g.files.length, bytes: g.files.reduce((s, x) => s + x.size, 0) }));
  return { free: await freeBytes(), outputDir: settings.outputDir, perCamera };
});

// ---------- settings / misc IPC ----------
ipcMain.handle('gpu:info', async () => {
  const f = app.getGPUFeatureStatus();
  const byName = new Map();                              // one entry per physical GPU, best preference first
  let active = '';
  try {
    const i = await app.getGPUInfo('complete');
    for (const d of i.gpuDevice || []) {
      const name = d.deviceString || '';
      if (!name || /basic render/i.test(name)) continue;
      if (d.active) active = name;
      byName.set(name, Math.max(byName.get(name) || 0, d.gpuPreference || 0));
    }
  } catch (_) {}
  const gpus = [...byName].sort((a, b) => b[1] - a[1]).map(([name], k) => ({ name, id: k === 0 ? 'high' : 'low' }));
  return { encode: f.video_encode, gpus, active };
});
ipcMain.handle('app:relaunch', async () => {             // encoder choice only takes effect at start-up
  await closeAllRecs();
  app.relaunch({ args: process.argv.slice(1) });
  app.exit(0);
});
ipcMain.handle('app:env',() => ({ fake: FAKE, smoke: SMOKE, platform: process.platform, version: app.getVersion() }));
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, partial) => {
  settings = { ...settings, ...sanitize(partial || {}) };
  saveSettings();
  return settings;
});
ipcMain.handle('dialog:chooseDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.outputDir });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('shell:openFolder', async () => {
  await fsp.mkdir(settings.outputDir, { recursive: true });
  return shell.openPath(settings.outputDir);
});
ipcMain.on('app:close-ok', () => { if (win && !win.isDestroyed()) win.destroy(); });

ipcMain.handle('smoke:done', async (_e, report) => {
  const files = [];
  for (const g of await listFinished()) for (const x of g.files) files.push({ file: path.relative(settings.outputDir, x.f), size: x.size });
  let gpu = {};
  try {
    const i = await app.getGPUInfo('complete');
    gpu = { active: (i.gpuDevice || []).filter((d) => d.active).map((d) => d.deviceString), encode: app.getGPUFeatureStatus().video_encode, pref: encoderPref };
  } catch (_) { /* ignore */ }
  let logs = [];
  try { logs = await win.webContents.executeJavaScript('window.__logbuf || []'); } catch (_) { /* ignore */ }
  const result = { report, files, gpu, logs };
  try { fs.writeFileSync(path.join(SMOKE_DIR, 'result.json'), JSON.stringify(result, null, 2)); } catch (_) { /* ignore */ }
  setTimeout(() => app.exit(0), 200);
});

// ---------- UI self-test (only used by scripts/smoke.js with MULTICAM_SMOKE_UI=1) ----------
// Drives the real UI: click-select, slot dropdown, drag & drop reorder, fullscreen.
async function runUiTest() {
  const script = `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 50 && document.querySelectorAll('.tile').length < 3; i++) await wait(100);
    const cam = (folder) => [...cams.values()].find((c) => c.cfg.folder === folder);
    const ranks = () => Object.fromEntries(['cam1', 'cam2', 'cam3'].map((f) => [f, Number(cam(f).slotSel.value)]));
    const out = { start: ranks() };
    // 1) clicking a card highlights exactly that card
    cam('cam2').el.click();
    out.selected = [...document.querySelectorAll('.tile.selected')].map((t) => [...cams.values()].find((c) => c.el === t).cfg.folder);
    // 2) slot dropdown: cam1 -> slot 3 (occupant swaps into slot 1)
    const sel = cam('cam1').slotSel; sel.value = '3'; sel.dispatchEvent(new Event('change'));
    out.afterDropdown = ranks();
    // 3) drag & drop: drag cam3 onto cam1
    const dt = new DataTransfer(); dt.setData('text/plain', cam('cam3').id);
    cam('cam1').el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    out.afterDrag = ranks();
    out.cssOrder = Object.fromEntries(['cam1', 'cam2', 'cam3'].map((f) => [f, cam(f).el.style.order]));
    // 4) fullscreen button
    cam('cam1').el.querySelector('.fsbtn').click();
    await wait(800);
    out.fullscreen = document.fullscreenElement === cam('cam1').video.parentElement;
    if (document.fullscreenElement) await document.exitFullscreen();
    await wait(300);
    out.exited = !document.fullscreenElement;
    // 5) toolbar icon buttons: icon + tooltip present, no leftover text, state icons toggle
    const b = (id) => document.getElementById(id);
    out.icons = Object.fromEntries(['btnRecord', 'btnPreview', 'btnFolder', 'btnSettings'].map((id) => [id,
      { svg: !!b(id).querySelector('svg'), text: b(id).textContent.trim(), tip: b(id).title }]));
    const before = b('btnPreview').title;
    b('btnPreview').click(); await wait(300);
    out.previewToggled = before !== b('btnPreview').title;
    b('btnPreview').click(); await wait(300);
    b('btnSettings').click(); await wait(800);          // opening settings fills the encoder readout
    out.encoder = [...b('sEncoder').options].filter((o) => !o.hidden).map((o) => o.textContent).join(' | ') + ' => ' + b('sEncoder').selectedOptions[0].textContent;
    const t0 = document.querySelector('.tile'); const vw = t0.querySelector('.vwrap').getBoundingClientRect();
    const rc = t0.querySelector('.rec').getBoundingClientRect(), bd = t0.querySelector('.badge').getBoundingClientRect(), tcEl = t0.querySelector('.tc'), tcr = tcEl.getBoundingClientRect(), fs0 = t0.querySelector('.fsbtn').getBoundingClientRect();
    const tc1 = tcEl.textContent; await wait(250); const tc2 = tcEl.textContent;
    out.tile = { recTopLeft: rc.width > 0 && rc.left - vw.left < 20 && rc.top - vw.top < 20, liveBottomLeft: bd.left - vw.left < 20 && vw.bottom - bd.bottom < 20, tcRightOfLive: tcr.left >= bd.right && Math.abs((tcr.top + tcr.bottom) / 2 - (bd.top + bd.bottom) / 2) < 3, fsTopRight: vw.right - fs0.right < 20 && fs0.top - vw.top < 20, tcFormat: tc1.split(':').length === 4 && tc1.split(':').every((p) => p.length === 2 && !isNaN(p)), tcTicks: tc1 !== tc2, live: t0.querySelector('.badge').textContent };
    const hid = () => b('motionRow').classList.contains('hidden');
    out.motionHiddenByDefault = hid();
    b('sMotion').click(); await wait(100); out.motionShownWhenChecked = !hid();
    b('sMotion').click(); await wait(100); out.motionHiddenWhenUnchecked = hid();
    const follows = (x, y) => !!(b(x).compareDocumentPosition(b(y)) & Node.DOCUMENT_POSITION_FOLLOWING);
    out.order = { autostartThenMotion: follows('sAutoStart', 'sMotion'), motionThenEncoder: follows('sMotion', 'sEncoder'), levelThenEncoder: follows('motionRow', 'sEncoder'), outputLastBeforeApply: follows('sEncoder', 'sOutputDir') && follows('sMinFree', 'sOutputDir') && follows('sOutputDir', 'sApply') };
    out.tileInfo = [...document.querySelectorAll('.stat')].map((e) => e.textContent).join(' | ');
    b('btnSettings').click();
    return out;
  })()`;
  let result;
  try { result = await win.webContents.executeJavaScript(script, true); }   // true = counts as a user gesture
  catch (e) { result = { error: String(e) }; }
  try { fs.writeFileSync(path.join(SMOKE_DIR, 'screenshot.png'), (await win.webContents.capturePage()).toPNG()); } catch (_) { /* optional */ }
  result.menu = { appMenu: Menu.getApplicationMenu() === null ? 'none' : 'present', barVisible: win.isMenuBarVisible() };
  try { fs.writeFileSync(path.join(SMOKE_DIR, 'ui-result.json'), JSON.stringify(result, null, 2)); } catch (_) { /* ignore */ }
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 700, minHeight: 500,
    backgroundColor: '#12151a', title: 'ABS_MultiCam',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false                // keep recorders and segment timers at full speed when minimized
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (closing) return;
    closing = true;
    e.preventDefault();                          // let the renderer finalize open recordings first
    win.webContents.send('app:request-close');
    setTimeout(() => { if (win && !win.isDestroyed()) win.destroy(); }, 8000);
  });
  win.on('closed', () => { win = null; });
  if (SMOKE) win.webContents.on('console-message', (_e, _l, msg) => { if (typeof msg === 'string' && msg.startsWith('[app]')) console.log(msg); });
  win.loadURL('app://abs-multicam/index.html');
  win.webContents.once('did-finish-load', () => setTimeout(() => {
    const f = app.getGPUFeatureStatus();
    log(`video encode: ${f.video_encode}`);
  }, 2500));
  if (SMOKE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => win.webContents.send('smoke:finish'), SMOKE * 1000);
      if (process.env.MULTICAM_SMOKE_UI) setTimeout(runUiTest, 4000);
      if (process.env.MULTICAM_SMOKE_FEED) setTimeout(() => win.webContents.executeJavaScript(`(() => {
        const W = Motion.WIDTH, H = Motion.HEIGHT; let n = 0;
        const make = (moving) => () => { n++; const x0 = 10 + (n * 8) % 90; const f = new Uint8ClampedArray(W * H * 4);
          for (let i = 0; i < W * H; i++) { const x = i % W, y = (i / W) | 0; let v = 100 + x / 4;
            if (moving && x >= x0 && x < x0 + 40 && y >= 20 && y < 60) v = 230; f[i*4] = f[i*4+1] = f[i*4+2] = v; f[i*4+3] = 255; } return f; };
        window.__motionFeed = { cam1: make(true), cam2: make(false) };
      })()`));   // installed immediately, before any camera can be armed
      const target = process.env.MULTICAM_SMOKE_ENC;       // drive the real UI: pick an encoder and press Apply (app restarts)
      if (target && settings.encoder !== target) setTimeout(() => win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.getElementById('btnSettings').click(); await wait(800);
        const sel = document.getElementById('sEncoder'); sel.value = ${JSON.stringify(target)};
        document.getElementById('sApply').click();
      })()`), 4000);
    });
  }
}

app.whenReady().then(async () => {
  if (!gotLock) return;
  settings = loadSettings();

  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.normalize(path.join(RENDERER_DIR, p));
    if (!file.startsWith(RENDERER_DIR)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // Only camera access and fullscreen are ever granted, and only to our own pages.
  const allowed = (permission) => permission === 'media' || permission === 'fullscreen';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed(permission));

  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('camera'); } catch (_) { /* denied; renderer shows the error */ }
  }

  // No File/Edit/View/Window menu bar on Windows and Linux. (macOS keeps its system menu bar:
  // it is global to the desktop, and Quit/Copy/Paste live there.)
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  createWindow();
  if (DEV) startDevWatch();
  setInterval(() => runCleanup().catch(() => {}), 60 * 1000);
});

app.on('child-process-gone', (_e, d) => {                 // GPU / capture-service crashes show up here
  console.log(`[child-process-gone] ${d.type} ${d.name || ''} reason=${d.reason} exitCode=${d.exitCode}`);
  log(`${d.type} process ${d.reason} (exit ${d.exitCode})`);
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { closing = false; createWindow(); } });
