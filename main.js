'use strict';
// ABS_MultiCam - main process: window, settings, recording file I/O, loop cleanup.
const { app, BrowserWindow, Menu, Tray, nativeImage, screen, ipcMain, dialog, session, shell, systemPreferences, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const fsp = fs.promises;
const { spawn } = require('child_process');

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
app.on('second-instance', () => showWindow());

if (FAKE > 0) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream', `device-count=${FAKE}`);
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  if (process.env.MULTICAM_FAKE_FILE) app.commandLine.appendSwitch('use-file-for-fake-video-capture', process.env.MULTICAM_FAKE_FILE);   // tests: play a .y4m clip
}
// Raspberry Pi: no GPU video encoder is available to Chromium there, and forcing desktop-GPU options can destabilise
// its graphics driver, so those are left alone. First run also starts with lighter settings (see PI_DEFAULTS).
const IS_PI = process.env.MULTICAM_FAKE_PI === '1' || (process.platform === 'linux' && (process.arch === 'arm64' || process.arch === 'arm') &&
  (() => { try { return /Raspberry Pi/i.test(fs.readFileSync('/proc/device-tree/model', 'utf8')); } catch (_) { return false; } })());
const PI_DEFAULTS = { width: 640, height: 480, fps: 15, bitrateKbps: 1000, tileMin: 320, encoder: 'v4l2' };

// GPU video encoding for the recorders (used automatically when the driver supports it; otherwise software)
if (!IS_PI) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'VaapiVideoEncoder,VaapiVideoDecoder');
}
app.commandLine.appendSwitch('disable-renderer-backgrounding');       // recording must not slow down when the window is hidden
app.commandLine.appendSwitch('disable-background-timer-throttling');
if (SMOKE && SMOKE_DIR) app.setPath('userData', path.join(SMOKE_DIR, 'userdata'));

// Encoder choice must be known before Chromium starts: high = fastest GPU, cpu = software. (Forcing the integrated GPU
// does not move video encoding off the main GPU's encoder, so there is no such option.)
let encoderPref = IS_PI ? 'v4l2' : 'auto';
try { encoderPref = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')).encoder || 'auto'; } catch (_) {}
if (encoderPref === 'cpu' || encoderPref === 'v4l2') app.commandLine.appendSwitch('disable-accelerated-video-encode');   // v4l2 = recording goes through ffmpeg, Chromium itself encodes nothing
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
  trayMinimize: false,
  burnIn: false,
  saveMp4: false,
  autoUpdate: true,
  windowBounds: null,
  motionLevel: 1,
  motionHoldSeconds: 8,
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
  try { s = { ...s, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; } catch (_) { if (IS_PI) s = { ...s, ...PI_DEFAULTS }; /* first run */ }
  if (!['vp8', 'vp9', 'h264'].includes(s.codec)) s.codec = 'h264';      // default, and what the old "auto" meant
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
  num('motionHoldSeconds', 1, 600); num('fps', 1, 120); num('bitrateKbps', 100, 1e5); num('tileMin', 200, 1200);
  if (typeof p.outputDir === 'string' && p.outputDir) out.outputDir = p.outputDir;
  if (typeof p.nameFilter === 'string') out.nameFilter = p.nameFilter.slice(0, 100);
  if (['vp8', 'vp9', 'h264'].includes(p.codec)) out.codec = p.codec;
  if (['high', 'cpu', 'v4l2'].includes(p.encoder)) out.encoder = p.encoder;
  if (typeof p.motion === 'boolean') out.motion = p.motion;
  if (p.motionLevel !== undefined) out.motionLevel = Math.min(2, Math.max(0, Math.round(Number(p.motionLevel)) || 0));
  for (const k of ['autoStart', 'preview', 'trayMinimize', 'burnIn', 'saveMp4', 'autoUpdate']) if (typeof p[k] === 'boolean') out[k] = p[k];
  if (p.windowBounds && typeof p.windowBounds === 'object') {
    const b = p.windowBounds, n = (v) => Number.isFinite(Number(v)) ? Math.round(Number(v)) : null;
    const wb = { x: n(b.x), y: n(b.y), width: n(b.width), height: n(b.height), maximized: b.maximized === true };
    if (wb.x !== null && wb.y !== null && wb.width >= 400 && wb.height >= 300) out.windowBounds = wb;
  }
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
      // optional per-camera overrides (absent = use the global setting)
      const br = Number(c.bitrateKbps); if (c.bitrateKbps != null && Number.isFinite(br) && br >= 100 && br <= 1e5) entry.bitrateKbps = Math.round(br);
      const ml = Number(c.motionLevel); if (c.motionLevel != null && [0, 1, 2].includes(ml)) entry.motionLevel = ml;
      const hs = Number(c.holdSeconds); if (c.holdSeconds != null && Number.isFinite(hs) && hs >= 1 && hs <= 600) entry.holdSeconds = Math.round(hs);
      if (Array.isArray(c.zones)) {                        // motion zones: rectangles in 0..1 picture coordinates
        const zs = [];
        for (const z of c.zones.slice(0, 20)) {
          const x = Number(z && z.x), y = Number(z && z.y), w = Number(z && z.w), h = Number(z && z.h);
          if ([x, y, w, h].every(Number.isFinite) && x >= 0 && y >= 0 && w >= 0.02 && h >= 0.02 && x + w <= 1.0001 && y + h <= 1.0001) zs.push({ x, y, w, h });
        }
        if (zs.length) entry.zones = zs;
      }
      if (c.zoneMode === 'inside' || c.zoneMode === 'outside') entry.zoneMode = c.zoneMode;
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

// ---------- hardware encoder (Raspberry Pi 4/3 and similar): frames are piped to ffmpeg's h264_v4l2m2m ----------
// Chromium cannot use the Pi's H.264 encoder, ffmpeg can. The renderer sends raw frames, ffmpeg writes a fragmented
// .mp4 (readable even after a crash). If the encoder is missing or fails, the renderer falls back to software.
const HW_ENC = process.env.MULTICAM_HW_ENCODER || 'h264_v4l2m2m';       // tests can substitute another ffmpeg encoder
let hwInfoPromise = null;
function execFfmpeg(args, timeoutMs) {
  return new Promise((resolve) => {
    const bin = ffmpegPath();
    if (!bin) return resolve({ ok: false });
    let done = false;
    const p = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    const t = setTimeout(() => { if (!done) { try { p.kill(); } catch (_) { /* gone */ } } }, timeoutMs);
    const end = (ok) => { if (!done) { done = true; clearTimeout(t); resolve({ ok }); } };
    p.on('error', () => end(false));
    p.on('close', (code) => end(code === 0));
  });
}
function hwInfo() {
  if (!hwInfoPromise) {
    hwInfoPromise = (async () => {
      const onArm = process.platform === 'linux' && (process.arch === 'arm64' || process.arch === 'arm');
      if (!onArm && !process.env.MULTICAM_HW_ENCODER) return { available: false, name: HW_ENC };
      if (process.env.MULTICAM_HW_ASSUME === '1') return { available: true, name: HW_ENC };
      // a real test encode: the encoder exists in ffmpeg AND the hardware answers (a Pi 5, for example, has none)
      const r = await execFfmpeg(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=5', '-t', '0.6', '-pix_fmt', 'yuv420p', '-c:v', HW_ENC, '-f', 'null', '-'], 12000);
      return { available: r.ok, name: HW_ENC };
    })();
  }
  return hwInfoPromise;
}
ipcMain.handle('hw:info', () => hwInfo());

ipcMain.handle('rec:openHw', async (_e, folderIn, p) => {
  const info = await hwInfo();
  if (!info.available) return { error: 'hardware encoder not available' };
  const bin = ffmpegPath();
  const PIX = ['yuv420p', 'nv12', 'rgba', 'bgra', 'rgb0', 'bgr0'];
  const w = Math.round(Number(p && p.width)), h = Math.round(Number(p && p.height));
  const fps = Math.min(120, Math.max(1, Math.round(Number(p && p.fps) || 30)));
  const kbps = Math.min(1e5, Math.max(100, Math.round(Number(p && p.bitrateKbps) || 2500)));
  const frameBytes = Math.round(Number(p && p.frameBytes));
  if (!bin || !PIX.includes(p && p.pixFmt) || !(w >= 16 && h >= 16 && w <= 7680 && h <= 4320) || !(frameBytes > 0)) return { error: 'bad parameters' };
  const folder = String(folderIn).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'cam';
  const dir = path.join(settings.outputDir, folder);
  await fsp.mkdir(dir, { recursive: true });
  let file = path.join(dir, `${folder}_${stamp()}.mp4`);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${folder}_${stamp()}_${i}.mp4`);
  const start = Number(p.startEpochMs) || Date.now();
  const args = ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', p.pixFmt, '-video_size', `${w}x${h}`, '-use_wallclock_as_timestamps', '1', '-i', 'pipe:0',
    '-an', '-vf', `fps=${fps}`, '-c:v', HW_ENC, '-b:v', `${kbps}k`, '-g', String(fps * 2), '-pix_fmt', 'yuv420p'];
  if (HW_ENC === 'libx264') args.push('-preset', 'ultrafast');
  args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-timecode', timecodeAt(start, fps), '-metadata', 'creation_time=' + new Date(start).toISOString(), file);
  const proc = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  const id = nextRecId++;
  const rec = { file, hw: true, proc, bytes: 0, frames: 0, drops: 0, frameBytes, err: '', exited: false, closing: false };
  proc.stderr.on('data', (d) => { rec.err = (rec.err + d).slice(-600); });
  proc.stdin.on('error', () => { /* ffmpeg ended early: reported through 'close' */ });
  const failed = (msg) => { if (!rec.closing && win && !win.isDestroyed()) win.webContents.send('rec:hw-failed', { id, err: msg }); };
  proc.on('error', (e) => { rec.exited = true; failed(String(e.message || e)); });
  proc.on('close', (code) => { rec.exited = true; if (code !== 0) failed(rec.err.trim().split('\n').pop() || `ffmpeg exited with ${code}`); });
  openRecs.set(id, rec);
  return { id, file, encoder: HW_ENC };
});

ipcMain.on('rec:frame', (_e, id, data) => {
  const r = openRecs.get(id);
  if (!r || !r.hw || r.exited || r.closing) return;
  if (r.proc.stdin.writableLength > r.frameBytes * 4) { r.drops++; return; }      // encoder is behind: drop the frame, keep the clock
  r.proc.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  r.frames++;
});
ipcMain.handle('rec:size', (_e, id) => {
  const r = openRecs.get(id);
  if (!r) return 0;
  try { return fs.statSync(r.file).size; } catch (_) { return 0; }
});

// ---------- timecode sidecar (<segment>.json) ----------
// Every camera is stamped from the same PC clock, so time-of-day timecode lines the cameras up.
const sidecarPath = (file) => file.replace(/\.(webm|mp4)$/, '.json');
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
    codec: ['h264', 'vp8', 'vp9'].includes(m.codec) ? m.codec : null,
    container: m.container === 'mp4' ? 'mp4' : 'webm',
    encoder: typeof m.encoder === 'string' ? m.encoder.slice(0, 40) : null,
    accuracy: 'Start = the moment the recorder was started. The first frame arrives a little later (camera and encoder delay), so this is not frame-accurate.'
  };
  writeSidecar(r);                                   // written now so it exists even if the app crashes mid-segment
});

async function finishRec(id, endMs) {
  const r = openRecs.get(id);
  if (!r) return 0;
  if (r.hw) {                                              // ffmpeg writes the file itself: end its input and wait for it to finish
    r.closing = true;
    await new Promise((res) => {
      if (r.exited) return res();
      const t = setTimeout(() => { try { r.proc.kill(); } catch (_) { /* gone */ } res(); }, 15000);
      r.proc.once('close', () => { clearTimeout(t); res(); });
      try { r.proc.stdin.end(); } catch (_) { /* already closed */ }
    });
    openRecs.delete(id);
    try { r.bytes = fs.statSync(r.file).size; } catch (_) { r.bytes = 0; }
  } else {
    await new Promise((res) => r.stream.end(res));
    openRecs.delete(id);
  }
  if (r.bytes === 0) { await removeRec(r.file); return 0; }
  if (r.sidecar) {
    const end = Number(endMs) || Date.now();
    r.sidecar.endUtc = new Date(end).toISOString();
    r.sidecar.durationMs = end - r.sidecar.startEpochMs;
    r.sidecar.bytes = r.bytes;
    writeSidecar(r);
  }
  if (settings.saveMp4) queueMp4(r.file);
  return r.bytes;
}
ipcMain.handle('rec:close', (_e, id, endMs) => finishRec(id, endMs));

// Finish every open recording file (used before the page is reloaded or the app restarts in dev mode).
async function closeAllRecs() {
  for (const id of [...openRecs.keys()]) await finishRec(id);
}

// ---------- MP4 conversion (optional) ----------
// Finished .webm files are rewritten as .mp4 with ffmpeg: real duration and seeking, plus the start timecode
// as a timecode track. H.264 is copied without re-encoding (fast, lossless); VP8/VP9 is re-encoded to H.264.
function ffmpegPath() {
  if (process.env.MULTICAM_FFMPEG) return process.env.MULTICAM_FFMPEG;
  let p = null;
  try { p = require('ffmpeg-static').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep); } catch (_) { return null; }
  if (process.platform !== 'win32') { try { fs.chmodSync(p, 0o755); } catch (_) { /* read-only install: the packager already set the executable bit */ } }
  return p;
}
const converting = new Set();           // files that are queued or being converted (never deleted by cleanup)
const convQueue = [];
let convBusy = false, convProc = null;
const convIdle = [];

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const bin = ffmpegPath();
    if (!bin) return resolve({ ok: false, err: 'ffmpeg not available' });
    let err = '';
    const p = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    convProc = p;
    try { require('os').setPriority(p.pid, 10); } catch (_) { /* optional: run below normal priority */ }
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ ok: false, err: String(e) }));
    p.on('close', (code) => { convProc = null; resolve({ ok: code === 0, err: err.trim().split('\n').pop() }); });
  });
}

async function convertToMp4(file) {
  const out = file.replace(/\.webm$/, '.mp4'), part = file.replace(/\.webm$/, '.part.mp4');
  let side = null;
  try { side = JSON.parse(fs.readFileSync(sidecarPath(file), 'utf8')); } catch (_) { /* old file without a sidecar */ }
  const meta = [];
  if (side && side.timecodeStart) meta.push('-timecode', side.timecodeStart);
  if (side && side.startUtc) meta.push('-metadata', 'creation_time=' + side.startUtc);
  const base = ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-an'];
  const copy = [...base, '-c:v', 'copy', '-movflags', '+faststart', ...meta, part];
  const fps = side && side.timecodeFps ? String(side.timecodeFps) : '30';
  const encode = [...base, '-r', fps, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', ...meta, part];
  let res = (side && (side.codec === 'vp8' || side.codec === 'vp9')) ? await runFfmpeg(encode) : await runFfmpeg(copy);
  if (!res.ok) { try { await fsp.unlink(part); } catch (_) { /* none */ } res = await runFfmpeg(encode); }      // copy failed: re-encode
  if (!res.ok) { try { await fsp.unlink(part); } catch (_) { /* none */ } log(`mp4: could not convert ${path.basename(file)} (${res.err})`); return; }
  try {
    await fsp.rename(part, out);
    const bytes = (await fsp.stat(out)).size;
    await fsp.unlink(file);
    if (side) { side.file = path.basename(out); side.container = 'mp4'; side.bytes = bytes; fs.writeFileSync(sidecarPath(out), JSON.stringify(side, null, 2)); }
  } catch (e) { log(`mp4: could not finish ${path.basename(file)} (${e.message})`); }
}

function queueMp4(file) {
  if (!file.endsWith('.webm') || converting.has(file)) return;
  converting.add(file); convQueue.push(file);
  pumpConversions();
}
async function pumpConversions() {
  if (convBusy) return;
  convBusy = true;
  while (convQueue.length) {
    const f = convQueue.shift();
    try { await convertToMp4(f); } catch (e) { log(`mp4: ${e.message}`); }
    converting.delete(f);
  }
  convBusy = false;
  for (const r of convIdle.splice(0)) r();
}
const conversionsDone = () => ((convBusy || convQueue.length) ? new Promise((r) => convIdle.push(r)) : Promise.resolve());

// Files left as .webm (app closed or crashed before they were converted) are picked up again after start-up.
async function convertLeftovers() {
  if (!settings.saveMp4) return;
  const open = new Set([...openRecs.values()].map((r) => r.file));
  let dirs = [];
  try { dirs = (await fsp.readdir(settings.outputDir, { withFileTypes: true })).filter((d) => d.isDirectory()); } catch (_) { return; }
  for (const d of dirs) {
    const dir = path.join(settings.outputDir, d.name);
    let names = []; try { names = await fsp.readdir(dir); } catch (_) { continue; }
    for (const n of names) {
      const f = path.join(dir, n);
      if (n.endsWith('.part.mp4')) { try { await fsp.unlink(f); } catch (_) { /* gone */ } continue; }
      if (!n.endsWith('.webm') || open.has(f) || names.includes(n.replace(/\.webm$/, '.mp4'))) continue;
      try { if (Date.now() - (await fsp.stat(f)).mtimeMs < 30000) continue; } catch (_) { continue; }
      queueMp4(f);
    }
  }
}
let quitting = false;
app.on('before-quit', async (e) => {                      // give a running conversion a moment to finish
  if (quitting || !(convBusy || convQueue.length)) return;
  quitting = true; e.preventDefault();
  await Promise.race([conversionsDone(), new Promise((r) => setTimeout(r, 20000))]);
  if (convProc) { try { convProc.kill(); } catch (_) { /* done */ } }
  app.quit();
});

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
      if (!(n.endsWith('.webm') || n.endsWith('.mp4'))) continue;
      const f = path.join(dir, n);
      try { const st = await fsp.stat(f); files.push({ f, size: st.size, mtime: st.mtimeMs, open: open.has(f) || n.endsWith('.part.mp4') || converting.has(f) }); } catch (_) { /* gone */ }
    }
    files.sort((a, b) => a.mtime - b.mtime);
    groups.push({ dir, files });
  }
  return groups;
}

async function freeBytes() {
  if (process.env.MULTICAM_FAKE_FREE_GB) return Number(process.env.MULTICAM_FAKE_FREE_GB) * GB;   // tests
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
ipcMain.handle('app:env',() => ({ fake: FAKE, smoke: SMOKE, platform: process.platform, version: app.getVersion(),
  maxFileBytes: process.env.MULTICAM_MAX_FILE_MB ? Number(process.env.MULTICAM_MAX_FILE_MB) * 1024 * 1024 : 4 * 1024 ** 3 }));   // each video file is capped at 4 GB
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
ipcMain.handle('snapshot:save', async (_e, folderIn, bytes) => {
  const folder = String(folderIn).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'cam';
  const dir = path.join(settings.outputDir, 'snapshots');
  await fsp.mkdir(dir, { recursive: true });
  let file = path.join(dir, `${folder}_${stamp()}.png`);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${folder}_${stamp()}_${i}.png`);
  await fsp.writeFile(file, Buffer.from(bytes));
  return file;
});
ipcMain.handle('shell:openFolder', async () => {
  await fsp.mkdir(settings.outputDir, { recursive: true });
  return shell.openPath(settings.outputDir);
});
ipcMain.on('app:close-ok', () => { if (win && !win.isDestroyed()) win.destroy(); });

ipcMain.handle('smoke:done', async (_e, report) => {
  await conversionsDone();                              // tests: let MP4 conversion finish before listing files
  const files = [];
  for (const g of await listFinished()) for (const x of g.files) files.push({ file: path.relative(settings.outputDir, x.f), size: x.size });
  let gpu = {};
  try {
    const i = await app.getGPUInfo('complete');
    gpu = { active: (i.gpuDevice || []).filter((d) => d.active).map((d) => d.deviceString), encode: app.getGPUFeatureStatus().video_encode, pref: encoderPref };
  } catch (_) { /* ignore */ }
  let logs = [];
  try { logs = await win.webContents.executeJavaScript('window.__logbuf || []'); } catch (_) { /* ignore */ }
  let zoneError = null;
  try { zoneError = await win.webContents.executeJavaScript('window.__zoneError || null'); } catch (_) { /* ignore */ }
  if (zoneError) { try { fs.writeFileSync(path.join(SMOKE_DIR, 'zone-error.txt'), zoneError); } catch (_) { /* ignore */ } }
  let zoneProbe = null;
  try { zoneProbe = await win.webContents.executeJavaScript('window.__zoneProbe || null'); } catch (_) { /* ignore */ }
  let zoneHit = null;
  try { zoneHit = await win.webContents.executeJavaScript('window.__zoneHit || null'); } catch (_) { /* ignore */ }
  let zoneCount = null;
  try { zoneCount = await win.webContents.executeJavaScript('window.__zoneCount || null'); } catch (_) { /* ignore */ }
  let disk = null;
  try { disk = await win.webContents.executeJavaScript('({ text: document.getElementById("disk").textContent, cls: document.getElementById("disk").className })'); } catch (_) { /* ignore */ }
  const result = { report, files, gpu, logs, disk, isPi: IS_PI, settingsSnapshot: { width: settings.width, height: settings.height, fps: settings.fps, bitrateKbps: settings.bitrateKbps, tileMin: settings.tileMin, encoder: settings.encoder }, zoneCount, zoneHit, zoneProbe, update: updates ? updates.current() : null, bounds: win && !win.isDestroyed() ? win.getNormalBounds() : null, workAreas: screen.getAllDisplays().map((d) => d.workArea) };
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
    // the info line is locked to the bottom of every card, also while one card's settings are open
    const gap = () => [...document.querySelectorAll('.tile')].map((tl) => Math.round(tl.getBoundingClientRect().bottom - tl.querySelector('.stat').getBoundingClientRect().bottom));
    const gapBefore = gap();
    const lastSet = [...document.querySelectorAll('.tile .camset')].pop();
    lastSet.click(); await wait(300);
    const gapOpen = gap(), tallerBy = [...document.querySelectorAll('.tile')].pop().getBoundingClientRect().height;
    lastSet.click(); await wait(300);
    out.cardInfo = { before: gapBefore, open: gapOpen, sameEverywhere: new Set(gapOpen).size === 1, unchanged: JSON.stringify(gapBefore) === JSON.stringify(gapOpen), tallerBy };
    out.maxFileBytes = env.maxFileBytes;
    out.bitrate = { type: b('sBitrate').type, text: b('sBitrateVal').textContent, value: b('sBitrate').value };
    out.header = { version: b('version').textContent, countText: b('count').textContent, countBeforeSlider: !!(b('count').compareDocumentPosition(b('tileSize')) & Node.DOCUMENT_POSITION_FOLLOWING), countNextToSlider: b('tileSize').getBoundingClientRect().left - b('count').getBoundingClientRect().right < 24 && b('tileSize').getBoundingClientRect().left >= b('count').getBoundingClientRect().right, sameBaseline: getComputedStyle(document.querySelector('.title')).alignItems === 'baseline' && document.querySelector('.title').contains(b('version')), versionNextToName: b('version').getBoundingClientRect().left - document.querySelector('h1').getBoundingClientRect().right < 24 };
    out.tileInfo = [...document.querySelectorAll('.stat')].map((e) => e.textContent).join(' | ');
    b('btnSettings').click();
    return out;
  })()`;
  let result;
  try { result = await win.webContents.executeJavaScript(script, true); }   // true = counts as a user gesture
  catch (e) { result = { error: String(e) }; }
  try { fs.writeFileSync(path.join(SMOKE_DIR, 'screenshot.png'), (await win.webContents.capturePage()).toPNG()); } catch (_) { /* optional */ }
  // minimize to tray: hides the window, the tray icon brings it back
  try {
    settings = { ...settings, trayMinimize: true };
    win.minimize(); await new Promise((r) => setTimeout(r, 600));
    const hidden = !win.isVisible();
    const hadTray = !!tray && !tray.isDestroyed();
    if (tray) tray.emit('click'); await new Promise((r) => setTimeout(r, 600));
    result.tray = { hidden, hadTray, restored: win.isVisible() && !win.isMinimized() };
    settings = { ...settings, trayMinimize: false };
  } catch (e) { result.tray = { error: String(e) }; }
  result.menu = { appMenu: Menu.getApplicationMenu() === null ? 'none' : 'present', barVisible: win.isMenuBarVisible() };
  try { fs.writeFileSync(path.join(SMOKE_DIR, 'ui-result.json'), JSON.stringify(result, null, 2)); } catch (_) { /* ignore */ }
}

// ---------- window ----------
// ---------- window position, tray ----------
const ICON_PATH = path.join(__dirname, 'build', 'icon.png');
let tray = null, recordingNow = false;

function savedBounds() {                                      // last window position, only if it is still on a connected screen
  const b = settings && settings.windowBounds;
  if (!b) return {};
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + 100 < a.x + a.width && b.x + b.width - 100 > a.x && b.y + 50 < a.y + a.height && b.y + 50 > a.y - 50;
  });
  return visible ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: b.width, height: b.height };
}
let saveBoundsTimer = null;
function rememberBounds() {
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen() || !win.isVisible()) return;
    const nb = win.getNormalBounds();
    settings = { ...settings, windowBounds: { x: nb.x, y: nb.y, width: nb.width, height: nb.height, maximized: win.isMaximized() } };
    saveSettings();
  }, 500);
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}
function updateTray() {
  if (!tray) return;
  tray.setToolTip(recordingNow ? 'ABS_MultiCam (recording)' : 'ABS_MultiCam');
}
function ensureTray() {
  if (tray) return tray;
  let img = nativeImage.createFromPath(ICON_PATH);
  if (!img.isEmpty()) img = img.resize({ width: 32, height: 32 });
  tray = new Tray(img);
  tray.on('click', showWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show ABS_MultiCam', click: showWindow },
    { label: 'Quit', click: () => { if (win && !win.isDestroyed()) win.close(); else app.quit(); } }
  ]));
  updateTray();
  return tray;
}
ipcMain.on('rec:state', (_e, on) => { recordingNow = !!on; updateTray(); });

function createWindow() {
  const sb = savedBounds();
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 700, minHeight: 500, ...sb,
    icon: ICON_PATH,
    backgroundColor: '#12151a', title: 'ABS_MultiCam',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false                // keep recorders and segment timers at full speed when minimized
    }
  });
  if (settings.windowBounds && settings.windowBounds.maximized) win.maximize();
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, rememberBounds);
  win.on('minimize', (e) => {                              // optional: minimize to the system tray, recording continues
    if (!settings.trayMinimize) return;
    e.preventDefault();
    ensureTray();
    win.hide();
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
      if (process.env.MULTICAM_SMOKE_SETBOUNDS) setTimeout(() => { const [x, y, w, h] = process.env.MULTICAM_SMOKE_SETBOUNDS.split(',').map(Number); win.setBounds({ x, y, width: w, height: h }); }, 1500);
      if (process.env.MULTICAM_SMOKE_FEED) win.webContents.executeJavaScript(`(() => {
        const W = Motion.WIDTH, H = Motion.HEIGHT; let n = 0; const t0 = Date.now();
        const mode = ${JSON.stringify(process.env.MULTICAM_SMOKE_FEED)};
        // mode 1: camera 1 sees a big moving square, camera 2 nothing. small: both see a small square that
        // moves for the first 5 s only ('small-burst') or all the time ('small').
        const make = (size, active) => () => { n++; const x0 = 10 + (n * 8) % 90; const f = new Uint8ClampedArray(W * H * 4); const on = active();
          for (let i = 0; i < W * H; i++) { const x = i % W, y = (i / W) | 0; let v = 100 + x / 4;
            if (on && x >= x0 && x < x0 + size && y >= 20 && y < 20 + size) v = 230; f[i*4] = f[i*4+1] = f[i*4+2] = v; f[i*4+3] = 255; } return f; };
        if (mode === '1') window.__motionFeed = { cam1: make(40, () => true), cam2: make(40, () => false) };
        else { const act = mode === 'small' ? () => true : () => Date.now() - t0 < 5000; window.__motionFeed = { cam1: make(10, act), cam2: make(10, act) }; }
      })()`);   // installed immediately, before any camera can be armed
      if (process.env.MULTICAM_SMOKE_PERCAM) setTimeout(() => win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const plan = ${process.env.MULTICAM_SMOKE_PERCAM};
        for (let i = 0; i < 60 && [...cams.values()].length < Object.keys(plan).length; i++) await wait(100);
        for (const [folder, sets] of Object.entries(plan)) {
          const cam = [...cams.values()].find((c) => c.cfg.folder === folder);
          cam.el.querySelector('.camset').click();                      // open the per-camera settings, like a user would
          for (const [cls, val] of Object.entries(sets)) { const sel = cam.el.querySelector('.' + cls); sel.value = val; sel.dispatchEvent(new Event('change')); }
        }
      })()`), 500);
      if (process.env.MULTICAM_SMOKE_KEYS) setTimeout(async () => {      // drives the keyboard shortcuts and snapshot buttons
        const out = await win.webContents.executeJavaScript(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const key = (k, target = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
          const rec = () => document.getElementById('btnRecord').title, prev = () => document.getElementById('btnPreview').title;
          const out = {};
          out.recInitial = rec(); out.prevInitial = prev();
          key('r'); await wait(500); out.recAfterR = rec();
          key('r'); await wait(500); out.recAfterR2 = rec();
          key('p'); await wait(300); out.prevAfterP = prev(); key('p'); await wait(300);
          const name = document.querySelector('.tile input.name'); name.focus(); key('r', name); await wait(300); out.recWhileTyping = rec();   // must not toggle
          name.blur();
          const tiles = [...document.querySelectorAll('.tile')];
          tiles[1].click(); await wait(100); key('s'); await wait(1500);                 // selected camera only
          document.querySelector('main').click(); await wait(100); key('s'); await wait(2500);   // nothing selected: all cameras
          tiles[0].querySelector('.snapbtn').click(); await wait(1500);                   // the tile's own button
          const st = document.getElementById('settings'); st.classList.remove('hidden'); key('Escape'); await wait(100); out.settingsClosedByEsc = st.classList.contains('hidden');
          out.snapTitle = tiles[0].querySelector('.snapbtn').title;
          return out;
        })()`, true).catch((e) => ({ error: String(e) }));
        try { fs.writeFileSync(path.join(SMOKE_DIR, 'keys-result.json'), JSON.stringify(out, null, 2)); } catch (_) { /* ignore */ }
      }, 5000);
      if (process.env.MULTICAM_SMOKE_ZONES) setTimeout(() => win.webContents.executeJavaScript(`(async () => { try {       // draws zones with real pointer events
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const plan = ${process.env.MULTICAM_SMOKE_ZONES};
        for (let i = 0; i < 60 && [...cams.values()].length < Object.keys(plan).length; i++) await wait(100);
        const ptr = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, clientX: x, clientY: y }));
        const setup = async (folder, p) => {
          const cam = [...cams.values()].find((c) => c.cfg.folder === folder);
          cam.el.querySelector('.camset').click();
          if (p.mode) { const s = cam.el.querySelector('.o-zonemode'); s.value = p.mode; s.dispatchEvent(new Event('change')); }
          cam.el.querySelector('.zone-edit').click();
          const zb = cam.el.querySelector('.zonebox'), R = () => zb.getBoundingClientRect();
          const X = (x) => R().left + x * R().width, Y = (y) => R().top + y * R().height;
          const ops = p.ops || [...(p.draw || []).map((d) => ['draw', ...d]), ...(p.click || []).map((c) => ['click', ...c]), ...(p.clear ? [['clear']] : [])];
          const probes = [];
          window.__zoneProbe = window.__zoneProbe || {}; window.__zoneProbe[folder] = probes;          // stored up front, so partial results survive an error
          const drag = async (from, to, target) => { ptr(target || zb, 'pointerdown', from[0], from[1]); ptr(zb, 'pointermove', to[0], to[1]); ptr(zb, 'pointerup', to[0], to[1]); };
          for (const [kind, ...a] of ops) {
            if (kind === 'draw') { const [x, y, w, h] = a; await drag([X(x), Y(y)], [X(x + w), Y(y + h)]); }
            else if (kind === 'click') await drag([X(a[0]), Y(a[1])], [X(a[0]), Y(a[1])]);
            else if (kind === 'move') { const z = cam.cfg.zones[cam.zoneSel], cx = z.x + z.w / 2, cy = z.y + z.h / 2; await drag([X(cx), Y(cy)], [X(cx + a[0]), Y(cy + a[1])]); }
            else if (kind === 'resize') { const hd = zb.querySelector('.zh-' + a[0]), hr = hd.getBoundingClientRect(), px = hr.left + hr.width / 2, py = hr.top + hr.height / 2; await drag([px, py], [px + a[1] * R().width, py + a[2] * R().height], hd); }
            else if (kind === 'key') document.body.dispatchEvent(new KeyboardEvent('keydown', { key: a[0], bubbles: true }));
            else if (kind === 'delbtn') { const bt = zb.querySelector('.zdel'), br = bt.getBoundingClientRect(); ptr(bt, 'pointerdown', br.left + 5, br.top + 5); }
            else if (kind === 'clear') cam.el.querySelector('.zone-clear').click();
            else if (kind === 'probe') probes.push({ zones: (cam.cfg.zones || []).map((z) => ({ ...z })), sel: cam.zoneSel, selEls: zb.querySelectorAll('.zone.sel').length, handles: zb.querySelectorAll('.zh').length, del: !!zb.querySelector('.zdel') });
            await wait(60);
          }
          window.__zoneCount = window.__zoneCount || {}; window.__zoneCount[folder] = cam.el.querySelectorAll('.zonebox .zone').length;
          return cam;
        };
        const done = {};
        for (const [folder, p] of Object.entries(plan)) done[folder] = await setup(folder, p);       // every camera is set up first
        if (Object.values(plan).some((p) => p.watch)) {                                              // then all are watched together
          const seen = {};
          for (let i = 0; i < 24; i++) {
            await wait(250);
            for (const [folder, p] of Object.entries(plan)) if (p.watch) {
              const cam = done[folder]; seen[folder] = seen[folder] || { hit: false, badge: false };
              if (cam.el.querySelector('.zonebox').classList.contains('hit')) seen[folder].hit = true;
              if (!cam.el.querySelector('.hitbadge').classList.contains('hidden')) seen[folder].badge = true;
            }
          }
          window.__zoneHit = seen;
        }
        for (const [folder, p] of Object.entries(plan)) if (!p.stay) done[folder].el.querySelector('.zone-edit').click();   // Done
      } catch (e) { window.__zoneError = String(e && e.stack || e); } })()`).catch(() => {}), 500);
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

let updates = null;
ipcMain.handle('update:state', () => (updates ? updates.current() : null));
ipcMain.on('update:install', () => { if (updates) updates.install(); });

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
  setTimeout(() => convertLeftovers().catch(() => {}), 10000);
  updates = require('./updates').create({
    log, enabled: () => settings.autoUpdate,
    send: (u) => { if (win && !win.isDestroyed()) win.webContents.send('update:ready', u); }
  });
  if (!SMOKE || process.env.MULTICAM_UPDATE_URL) updates.start(SMOKE ? 3000 : 20000);
});

app.on('child-process-gone', (_e, d) => {                 // GPU / capture-service crashes show up here
  console.log(`[child-process-gone] ${d.type} ${d.name || ''} reason=${d.reason} exitCode=${d.exitCode}`);
  log(`${d.type} process ${d.reason} (exit ${d.exitCode})`);
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { closing = false; createWindow(); } });
