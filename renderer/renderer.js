'use strict';
// ABS_MultiCam renderer: discovers every camera, shows live previews, records each one in segments.

const $ = (s) => document.querySelector(s);
const grid = $('#grid');
const logEl = $('#log');

let settings = null;
let env = null;
let recordingAll = false;
const cams = new Map();   // deviceId -> cam

// ---------- toolbar icons (inline SVG, drawn in the button's text colour) ----------
const ICONS = {
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
  record: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  stop: '<circle cx="12" cy="12" r="9"/><rect x="8.5" y="8.5" width="7" height="7" rx="1" fill="currentColor" stroke="none"/>'
};
function setIcon(btn, name, tip) {
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  btn.title = tip;
  btn.setAttribute('aria-label', tip);
}

// ---------- small helpers ----------
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const fmtBytes = (n) => {
  if (n == null) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};
function log(msg) {
  const buf = (window.__logbuf = window.__logbuf || []);       // read by the self-test; capped so it never grows
  buf.push(`${Date.now() % 100000} ${msg}`); if (buf.length > 300) buf.shift();
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.textContent = `${line}\n${logEl.textContent}`.split('\n').slice(0, 200).join('\n');
}
const saveTile = debounce((v) => mc.setSettings({ tileMin: v }).then((s) => { settings.tileMin = s.tileMin; }), 400);
const saveCameras = debounce(() => mc.setSettings({ cameras: settings.cameras }), 400);

// ---------- per-camera config (stable name + folder, tied to the device ID) ----------
function ensureConfig(id) {
  let c = settings.cameras[id];
  if (!c) {
    const used = new Set(Object.values(settings.cameras).map((x) => x.folder));
    let n = 1; while (used.has(`cam${n}`)) n++;
    c = settings.cameras[id] = { name: `Camera ${n}`, folder: `cam${n}`, enabled: true };
    saveCameras();
  }
  if (!c.slot) { c.slot = firstFreeSlot(); saveCameras(); }   // new camera, or settings saved before slots existed
  return c;
}

// ---------- slots (user-chosen position of each camera in the grid) ----------
// A slot belongs to a camera even while it is unplugged, so a new camera never takes its place.
function firstFreeSlot() {
  const used = new Set(Object.values(settings.cameras).map((c) => c.slot).filter(Boolean));
  let n = 1; while (used.has(n)) n++;
  return n;
}
// cfg.slot is only a sort key. The slot number shown to the user is the camera's rank among connected cameras.
function ordered() {
  return [...cams.values()].sort((a, b) => a.cfg.slot - b.cfg.slot);
}
// Dropdown: put `cam` in slot `rank`; the camera that was there takes cam's old slot.
function moveToSlot(cam, rank) {
  const other = ordered()[Number(rank) - 1];
  if (!other || other === cam) { renderSlots(); return; }
  [cam.cfg.slot, other.cfg.slot] = [other.cfg.slot, cam.cfg.slot];
  saveCameras();
  renderSlots();
  log(`${cam.cfg.name} -> slot ${rank} (${other.cfg.name} swapped)`);
}
// Drag & drop: `cam` takes `target`'s position and the cameras in between shift over by one.
function reorder(cam, target) {
  const list = ordered();
  const keys = list.map((c) => c.cfg.slot);               // ascending; we only re-deal these same keys
  const from = list.indexOf(cam), to = list.indexOf(target);
  if (from < 0 || to < 0 || from === to) return;
  list.splice(from, 1);
  list.splice(to, 0, cam);
  list.forEach((c, i) => { c.cfg.slot = keys[i]; });
  saveCameras();
  renderSlots();
  log(`${cam.cfg.name} moved to slot ${to + 1}`);
}
function renderSlots() {
  const list = ordered();
  list.forEach((cam, i) => {
    cam.el.style.order = String(i + 1);
    if (cam.slotSel.options.length !== list.length)       // only rebuild the options when the camera count changed
      cam.slotSel.innerHTML = list.map((_, k) => `<option value="${k + 1}">Slot ${k + 1}</option>`).join('');
    if (cam.slotSel.value !== String(i + 1)) cam.slotSel.value = String(i + 1);
  });
}

// ---------- selection and fullscreen ----------
function selectCam(cam) {
  for (const c of cams.values()) c.el.classList.toggle('selected', c === cam);
}
function selectedCam() {
  return [...cams.values()].find((c) => c.el.classList.contains('selected'));
}
function toggleFullscreen(cam) {
  const wrap = cam.video.parentElement;
  if (document.fullscreenElement === wrap) { document.exitFullscreen(); return; }
  if (!cam.stream) { log(`${cam.cfg.name}: no picture to show full screen`); return; }
  cam.video.srcObject = cam.stream;                       // show it even if previews are switched off
  cam.noprev.classList.add('hidden');
  wrap.requestFullscreen().catch((e) => log(`fullscreen failed: ${e.message}`));
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) cams.forEach(attachPreview);   // restore the preview on/off setting
});
document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, select, textarea')) return;
  const cam = selectedCam();
  if ((e.key === 'f' || e.key === 'F') && cam) toggleFullscreen(cam);   // Esc leaves fullscreen by itself
});

// ---------- tiles ----------
function buildTile(cam) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.innerHTML = `
    <div class="vwrap"><video muted playsinline autoplay></video><div class="noprev hidden">Preview off</div>
      <span class="rec hidden">&#9679; REC</span>
      <div class="vstate"><span class="badge"></span><span class="tc">--:--:--:--</span></div>
      <button class="fsbtn" title="Full screen (or double-click the picture). Esc to leave.">&#9974;</button></div>
    <div class="bar"><span class="grip" title="Drag the card to reorder it">&#8942;&#8942;</span>
      <select class="slot" title="Slot: the position of this camera in the grid"></select>
      <input class="name" maxlength="60" spellcheck="false">
      <div class="pair">
      <select class="res" title="Resolution for this camera">
        <option value="default">Default</option>
        <option value="320x240">320 x 240</option>
        <option value="640x480">640 x 480</option>
        <option value="800x600">800 x 600</option>
        <option value="1280x720">1280 x 720</option>
        <option value="1920x1080">1920 x 1080</option>
      </select>
      <select class="fps" title="Frame rate for this camera">
        <option value="default">Default fps</option>
        <option value="5">5 fps</option>
        <option value="10">10 fps</option>
        <option value="15">15 fps</option>
        <option value="24">24 fps</option>
        <option value="30">30 fps</option>
        <option value="60">60 fps</option>
      </select>
      </div>
      <label title="Include this camera. Unticking also releases its USB bandwidth."><input type="checkbox" class="en"> record</label></div>
    <div class="stat"></div>`;
  cam.el = el;
  cam.video = el.querySelector('video');
  cam.noprev = el.querySelector('.noprev');
  cam.badge = el.querySelector('.badge');
  cam.recTag = el.querySelector('.rec');
  cam.tc = el.querySelector('.tc');
  cam.stat = el.querySelector('.stat');
  const name = el.querySelector('.name');
  name.value = cam.cfg.name;
  name.title = cam.label;
  name.addEventListener('input', () => { cam.cfg.name = name.value || cam.cfg.folder; saveCameras(); });
  const en = el.querySelector('.en');
  en.checked = cam.cfg.enabled;
  en.addEventListener('change', async () => {
    cam.cfg.enabled = en.checked; saveCameras();
    el.classList.toggle('off', !en.checked);
    if (!en.checked) { await stopRec(cam); closeStream(cam); setStatus(cam, 'disabled'); }
    else { if (await openStream(cam) && recordingAll) engage(cam); }
  });
  const res = el.querySelector('.res');
  res.value = cam.cfg.width && cam.cfg.height ? `${cam.cfg.width}x${cam.cfg.height}` : 'default';
  if (res.value === '') res.value = 'default';       // saved size isn't one of the presets
  res.addEventListener('change', async () => {
    if (res.value === 'default') { delete cam.cfg.width; delete cam.cfg.height; }
    else { [cam.cfg.width, cam.cfg.height] = res.value.split('x').map(Number); }
    saveCameras();
    if (!cam.cfg.enabled) return;
    await stopRec(cam);                              // new resolution = new stream = new segment
    const ok = await openStream(cam);
    if (ok && recordingAll) engage(cam);
    log(`${cam.cfg.name}: resolution set to ${res.value === 'default' ? 'default (' + settings.width + 'x' + settings.height + ')' : res.value}`);
  });
  const fpsSel = el.querySelector('.fps');
  fpsSel.value = cam.cfg.fps ? String(cam.cfg.fps) : 'default';
  if (fpsSel.value === '') fpsSel.value = 'default';  // saved value isn't one of the presets
  fpsSel.addEventListener('change', async () => {
    if (fpsSel.value === 'default') delete cam.cfg.fps; else cam.cfg.fps = Number(fpsSel.value);
    saveCameras();
    if (!cam.cfg.enabled) return;
    await stopRec(cam);
    const ok = await openStream(cam);
    if (ok && recordingAll) engage(cam);
    log(`${cam.cfg.name}: frame rate set to ${fpsSel.value === 'default' ? 'default (' + settings.fps + ')' : fpsSel.value + ' fps'}`);
  });
  cam.slotSel = el.querySelector('.slot');
  cam.slotSel.addEventListener('change', () => moveToSlot(cam, cam.slotSel.value));
  // Drag the card by any part that isn't a control (text boxes and dropdowns must stay usable).
  el.addEventListener('mousedown', (e) => { el.draggable = !e.target.closest('input, select, button, label'); });
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', cam.id);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.droptarget').forEach((t) => t.classList.remove('droptarget'));
  });
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('droptarget'); });
  el.addEventListener('dragleave', () => el.classList.remove('droptarget'));
  el.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('droptarget');
    const dragged = cams.get(e.dataTransfer.getData('text/plain'));
    if (dragged && dragged !== cam) reorder(dragged, cam);
  });
  el.addEventListener('click', () => selectCam(cam));
  el.querySelector('.fsbtn').addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(cam); });
  cam.video.addEventListener('dblclick', () => toggleFullscreen(cam));
  el.classList.toggle('off', !cam.cfg.enabled);
  grid.appendChild(el);
}

// Time-of-day timecode (HH:MM:SS:FF) from the PC clock, the same clock the recorded sidecar files use.
function timecodeNow(fps) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}:${p(Math.min(fps - 1, Math.floor(d.getMilliseconds() / 1000 * fps)))}`;
}
setInterval(() => {
  if (document.hidden) return;
  for (const cam of cams.values()) {
    const fps = Math.max(1, Math.round((cam.track && cam.track.getSettings().frameRate) || cam.cfg.fps || settings.fps));
    cam.tc.textContent = timecodeNow(fps);
  }
}, 40);

function setStatus(cam, text) { cam.status = text; cam.badge.textContent = text; cam.badge.classList.toggle('ok', text === 'live'); }

function updateStats() {
  for (const cam of cams.values()) {
    const parts = [];
    if (cam.info) parts.push(cam.info);
    if (cam.recording || cam.bytesTotal) parts.push(`${fmtBytes(cam.bytesTotal)} written`);
    if (cam.motion && !cam.recording) parts.push('no movement');
    cam.stat.textContent = parts.join('  ·  ') || ' ';
    if (/error|lost/.test(cam.status || '')) { cam.stat.innerHTML = `<span class="err">${cam.status}</span>`; }
    cam.recTag.classList.toggle('hidden', !cam.recording);
  }
  $('#count').textContent = `${cams.size} camera${cams.size === 1 ? '' : 's'}`;
  $('#empty').classList.toggle('hidden', cams.size > 0);
}

async function updateDisk() {
  const d = await mc.diskInfo();
  const total = d.perCamera.reduce((s, x) => s + x.bytes, 0);
  $('#disk').textContent = `Free space: ${fmtBytes(d.free)}   ·   Recordings: ${fmtBytes(total)} in ${d.perCamera.length} folder(s)   ·   ${d.outputDir}`;
}

// ---------- device discovery ----------
let refreshing = false, refreshAgain = false, permitted = false, lastSig = null;
const missCount = new Map();
async function refreshDevices() {
  if (refreshing) { refreshAgain = true; return; }     // never overlap; re-run once afterwards
  refreshing = true;
  try {
    do {
      refreshAgain = false;
      let devs = [];
      try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (e) { log(`enumerateDevices failed: ${e.message}`); break; }
      let vids = devs.filter((d) => d.kind === 'videoinput');
      if (vids.length && !permitted && vids.some((d) => !d.label || !d.deviceId)) {
        // Started with no camera attached, so the permission unlock failed: device IDs/labels are blank. Retry now.
        try { (await navigator.mediaDevices.getUserMedia({ video: true })).getTracks().forEach((t) => t.stop()); permitted = true; }
        catch (e) { log(`camera access problem: ${e.name} ${e.message || ''}`); }
        vids = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      } else if (vids.length) permitted = true;
      const present = vids.filter((d) => d.deviceId);
      const ids = new Set(present.map((d) => d.deviceId));
      const sig = [...ids].sort().join('|');
      // A camera is only removed after it is missing from two checks in a row, so a momentary empty
      // enumeration can never drop a camera that is recording.
      let pending = false;
      for (const [id, cam] of [...cams]) {
        if (ids.has(id)) { missCount.delete(id); continue; }
        const n = (missCount.get(id) || 0) + 1;
        if (n >= 2) { missCount.delete(id); await removeCam(cam); lastSig = null; }
        else { missCount.set(id, n); pending = true; }
      }
      if (pending) setTimeout(refreshDevices, 1200);      // confirm quickly
      if (sig === lastSig && !pending) continue;          // nothing plugged or unplugged: skip all work
      lastSig = sig;

      for (const d of present) if (!cams.has(d.deviceId)) await addCam(d);
      renderSlots();
      updateStats();
    } while (refreshAgain);
  } finally { refreshing = false; }
}

async function addCam(d) {
  const cam = { id: d.deviceId, label: d.label || 'Camera', cfg: ensureConfig(d.deviceId), stream: null, track: null,
    seg: null, recording: false, bytesTotal: 0, info: '', status: '', fails: 0, retry: null, rot: null };
  cams.set(cam.id, cam);
  buildTile(cam);
  log(`camera found: ${cam.cfg.name} (${cam.label})`);
  if (cam.cfg.enabled) {
    if (cams.size > 1) await new Promise((r) => setTimeout(r, 700));   // let the previous camera's USB bandwidth reservation settle
    if (await openStream(cam) && recordingAll) engage(cam);
  }
  else setStatus(cam, 'disabled');
}

async function removeCam(cam) {
  log(`camera removed: ${cam.cfg.name}`);
  clearTimeout(cam.retry); cam.retry = null;
  await stopRec(cam);
  closeStream(cam);
  cam.el.remove();
  cams.delete(cam.id);
}

// ---------- streams ----------
function attachPreview(cam) {
  const on = settings.preview && !document.hidden && cam.stream;     // no decoding while the window is minimized/hidden
  cam.video.srcObject = on ? cam.stream : null;      // detaching skips decoding/rendering; recording is unaffected
  cam.noprev.classList.toggle('hidden', !!on || !cam.stream);
}

function closeStream(cam) {
  disarm(cam);
  if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
  cam.stream = null; cam.track = null; cam.info = '';
  cam.video.srcObject = null;
}

async function openStream(cam) {
  closeStream(cam);
  try {
    const wantW = cam.cfg.width || settings.width;       // per-camera override, else global
    const wantH = cam.cfg.height || settings.height;
    const wantFps = cam.cfg.fps || settings.fps;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { deviceId: { exact: cam.id }, width: { ideal: wantW }, height: { ideal: wantH }, frameRate: { ideal: wantFps } }
    });
    cam.stream = stream; cam.fails = 0;
    cam.track = stream.getVideoTracks()[0];
    cam.track.addEventListener('ended', () => onEnded(cam));
    // 'mute' = the camera opened but delivers no frames (typically no USB bandwidth left on a shared hub/controller)
    // 'mute' = opened but no frames arriving (USB stream failed to start). Close and reopen it automatically.
    const trk = cam.track;
    trk.addEventListener('mute', () => {
      setStatus(cam, 'error: no video');
      clearTimeout(cam.muteTimer);
      cam.muteTimer = setTimeout(async () => {
        if (cam.track !== trk || !trk.muted || !cams.has(cam.id)) return;
        cam.muteFails = (cam.muteFails || 0) + 1;
        log(`${cam.cfg.name}: no frames, reopening (attempt ${cam.muteFails})`);
        await stopRec(cam); closeStream(cam);
        cam.fails = Math.max(cam.fails, cam.muteFails);
        scheduleRetry(cam);
      }, 4000);
    });
    trk.addEventListener('unmute', () => { clearTimeout(cam.muteTimer); cam.muteFails = 0; if (cam.stream) setStatus(cam, 'live'); });
    const s = cam.track.getSettings();
    cam.info = `${s.width || '?'}x${s.height || '?'}${s.frameRate ? '@' + Math.round(s.frameRate) : ''}`;
    attachPreview(cam);
    setStatus(cam, 'live');
    return true;
  } catch (e) {
    cam.fails++;
    setStatus(cam, `error: ${e.name}`);
    log(`${cam.cfg.name}: cannot open (${e.name}${e.message ? ': ' + e.message : ''})`);
    scheduleRetry(cam);
    return false;
  }
}

async function onEnded(cam) {
  if (!cams.has(cam.id) || !cam.stream) return;
  log(`${cam.cfg.name}: stream ended (unplugged or lost)`);
  await stopRec(cam);
  closeStream(cam);
  setStatus(cam, 'lost - retrying');
  cam.fails = Math.max(cam.fails, 1);
  scheduleRetry(cam);
}

function scheduleRetry(cam) {
  if (cam.retry || !cams.has(cam.id) || !cam.cfg.enabled) return;
  const delay = Math.min(60000, 5000 * 2 ** Math.min(cam.fails, 4));
  cam.retry = setTimeout(async () => {
    cam.retry = null;
    if (!cams.has(cam.id) || !cam.cfg.enabled || cam.stream) return;
    if (await openStream(cam) && recordingAll) engage(cam);
  }, delay);
}

// ---------- record on movement ----------
// With "Record on movement" on, pressing record only arms each camera; recording starts when movement is
// detected and stops after a few quiet seconds. Otherwise cameras record continuously.
const detCanvas = document.createElement('canvas');
detCanvas.width = Motion.WIDTH; detCanvas.height = Motion.HEIGHT;
const detCtx = detCanvas.getContext('2d', { willReadFrequently: true });

function engage(cam) {
  if (!settings.motion) return startRec(cam);
  armMotion(cam);
}

function armMotion(cam) {
  disarm(cam);
  if (!cam.stream) return;
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.srcObject = cam.stream;
  v.play().catch(() => {});
  const det = Motion.createDetector(window.pixelmatch);
  const trig = Motion.createTrigger({ startSamples: 2, holdMs: 8000 });
  cam.motion = { v, timer: null, ratio: 0, maxRatio: 0 };
  cam.motion.timer = setInterval(async () => {
    if (v.readyState < 2 || !recordingAll) return;
    detCtx.drawImage(v, 0, 0, Motion.WIDTH, Motion.HEIGHT);
    const level = settings.motionLevel;
    const feed = window.__motionFeed && window.__motionFeed[cam.cfg.folder];       // self-test only: synthetic frames per camera
    const ratio = det.feed(feed ? feed() : detCtx.getImageData(0, 0, Motion.WIDTH, Motion.HEIGHT).data, level);
    cam.motion.ratio = ratio; cam.maxRatio = Math.max(cam.maxRatio || 0, ratio);
    const ev = trig.update(ratio >= Motion.LEVELS[level].ratio, Date.now());
    if (ev === 'start') { cam.triggers = (cam.triggers || 0) + 1; log(cam.cfg.name + ': movement, recording'); await startRec(cam); }
    else if (ev === 'stop') { log(cam.cfg.name + ': no movement, stopped'); await stopRec(cam); }
  }, 250);
}

function disarm(cam) {
  if (!cam.motion) return;
  clearInterval(cam.motion.timer);
  cam.motion.v.srcObject = null;
  cam.motion = null;
}

// ---------- recording (rolling segments) ----------
function pickMime() {
  const pref = settings.codec;
  const order = [pref, ...['h264', 'vp8', 'vp9'].filter((c) => c !== pref)];   // preferred codec first, others as fallback
  for (const c of order) { const m = `video/webm;codecs=${c}`; if (MediaRecorder.isTypeSupported(m)) return m; }
  return MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : '';
}

async function beginSegment(cam) {
  const { id: recId } = await mc.recOpen(cam.cfg.folder);
  if (!cam.recording || !cam.stream) { await mc.recClose(recId, Date.now()); return null; }   // recording was stopped while the file was being opened
  const mime = pickMime();
  const rec = new MediaRecorder(cam.stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: settings.bitrateKbps * 1000 });
  const seg = { rec, recId, chain: Promise.resolve(), closed: null, bytes: 0 };
  // Start the next file a little before the cap, so even the final chunk of this one stays under it.
  const limit = env.maxFileBytes, splitAt = limit - Math.min(64 * 1024 * 1024, limit * 0.25);
  rec.ondataavailable = (ev) => {
    if (!ev.data || !ev.data.size) return;
    seg.chain = seg.chain.then(async () => {
      const buf = new Uint8Array(await ev.data.arrayBuffer());
      cam.bytesTotal += buf.length;
      seg.bytes += buf.length;
      mc.recWrite(recId, buf);
      if (seg.bytes >= splitAt && !seg.splitting && cam.seg === seg && cam.recording) {      // file reached the cap: continue in a new file, no gap
        seg.splitting = true;
        log(`${cam.cfg.name}: file reached ${(limit / 1024 ** 3).toFixed(limit >= 1024 ** 3 ? 0 : 3)} GB, splitting`);
        rotate(cam);
      }
    });
  };
  seg.closed = new Promise((resolve) => {
    rec.onstop = () => {
      const endMs = Date.now();
      seg.chain.then(() => mc.recClose(recId, endMs)).then(() => resolve(), () => resolve());
    };
  });
  rec.onerror = (e) => log(`${cam.cfg.name}: recorder error ${e.error ? e.error.name : ''}`);
  const startMs = Date.now();                            // timecode reference: the moment this segment starts
  rec.start(1000);
  const st = cam.track ? cam.track.getSettings() : {};
  mc.recMeta(recId, {
    startEpochMs: startMs, camera: cam.cfg.name, folder: cam.cfg.folder, slot: ordered().indexOf(cam) + 1,
    width: st.width, height: st.height, frameRate: st.frameRate,
    fps: Math.round(st.frameRate || cam.cfg.fps || settings.fps)       // frame rate used for the HH:MM:SS:FF timecode
  });
  cam.seg = seg;
  return seg;
}

async function startRec(cam) {
  if (!cam.stream || cam.recording) return;
  cam.recording = true;
  try { await beginSegment(cam); }
  catch (e) { cam.recording = false; log(`${cam.cfg.name}: cannot start recording (${e.message})`); return; }
  if (cam.recording) scheduleRotate(cam);
}

function scheduleRotate(cam) {
  clearTimeout(cam.rot);
  cam.rot = setTimeout(() => rotate(cam), Math.max(1000, settings.segmentMinutes * 60 * 1000));
}

async function rotate(cam) {
  if (!cam.recording || !cam.stream) return;
  const old = cam.seg;
  try { await beginSegment(cam); }              // new file starts before the old one stops: no gap
  catch (e) { log(`${cam.cfg.name}: segment rotate failed (${e.message})`); }
  if (old && old.rec.state !== 'inactive') old.rec.stop();
  if (cam.recording) scheduleRotate(cam);
}

async function stopRec(cam) {
  cam.recording = false;
  clearTimeout(cam.rot); cam.rot = null;
  const seg = cam.seg; cam.seg = null;
  if (seg) {
    if (seg.rec.state !== 'inactive') seg.rec.stop();
    await seg.closed;
  }
}

async function startRecordingAll() {
  recordingAll = true;
  sessionStorage.setItem('rec', '1');                 // survives a page refresh (dev reload) so recording carries on
  setIcon($('#btnRecord'), 'stop', 'Stop recording');
  $('#btnRecord').classList.add('recording');
  await Promise.all([...cams.values()].map(async (cam) => {
    if (!cam.cfg.enabled) return;
    if (!cam.stream) await openStream(cam);
    await engage(cam);
  }));
  log('recording started');
}

async function stopRecordingAll() {
  recordingAll = false;
  sessionStorage.setItem('rec', '0');
  setIcon($('#btnRecord'), 'record', 'Start recording');
  $('#btnRecord').classList.remove('recording');
  await Promise.all([...cams.values()].map(async (cam) => { disarm(cam); await stopRec(cam); }));
  log('recording stopped');
}

// ---------- settings UI ----------
const encoderOf = (v) => (v === 'cpu' ? 'cpu' : 'high');     // anything else (old "auto"/"low") = best GPU

async function showEncoder() {
  const sel = $('#sEncoder');
  let g = { gpus: [] };
  try { g = await mc.gpuInfo(); } catch (_) {}
  const opt = (v) => [...sel.options].find((o) => o.value === v);
  const best = g.gpus[0];
  opt('high').textContent = best ? best.name : 'GPU';
  opt('high').hidden = !best;
  opt('cpu').textContent = 'CPU';
  sel.value = encoderOf(settings.encoder);
}

function fillSettings() {
  showEncoder();
  $('#sOutputDir').value = settings.outputDir;
  $('#sRes').value = `${settings.width}x${settings.height}`;
  $('#sFps').value = String(settings.fps);
  $('#sCodec').value = settings.codec;
  $('#sBitrate').value = settings.bitrateKbps;
  $('#sSegment').value = settings.segmentMinutes;
  $('#sMaxGB').value = settings.maxGBPerCamera;
  $('#sMaxAge').value = settings.maxAgeHours;
  $('#sMinFree').value = settings.minFreeGB;
  $('#sAutoStart').checked = settings.autoStart;
  $('#sMotion').checked = settings.motion;
  $('#sMotionLevel').value = settings.motionLevel;
  $('#motionRow').classList.toggle('hidden', !settings.motion);
}

async function applySettings() {
  const [w, h] = $('#sRes').value.split('x').map(Number);
  const before = { w: settings.width, h: settings.height, fps: settings.fps, enc: encoderOf(settings.encoder), motion: settings.motion };
  settings = await mc.setSettings({
    outputDir: $('#sOutputDir').value, encoder: $('#sEncoder').value,
    width: w, height: h, fps: Number($('#sFps').value), codec: $('#sCodec').value,
    bitrateKbps: Number($('#sBitrate').value), segmentMinutes: Number($('#sSegment').value),
    maxGBPerCamera: Number($('#sMaxGB').value), maxAgeHours: Number($('#sMaxAge').value),
    minFreeGB: Number($('#sMinFree').value),
    autoStart: $('#sAutoStart').checked,
    motion: $('#sMotion').checked, motionLevel: Number($('#sMotionLevel').value)
  });
  if (before.enc !== encoderOf(settings.encoder)) { await mc.relaunch(); return; }   // the encoder is chosen when the app starts
  document.documentElement.style.setProperty('--tile', `${settings.tileMin}px`);
  if (recordingAll && before.motion !== settings.motion) {      // switch between continuous and on-movement recording
    for (const cam of cams.values()) { disarm(cam); await stopRec(cam); if (cam.stream) await engage(cam); }
  }
  const restart = before.w !== settings.width || before.h !== settings.height || before.fps !== settings.fps;
  const wasRecording = recordingAll;
  if (restart) {
    if (wasRecording) await stopRecordingAll();
    for (const cam of cams.values()) if (cam.cfg.enabled) await openStream(cam);
    await refreshDevices();
    if (wasRecording) await startRecordingAll();
  } else {
    for (const cam of cams.values()) if (cam.recording) scheduleRotate(cam);
  }
  updateDisk();
  showEncoder();
  log('settings applied');
}

function bindUI() {
  document.documentElement.style.setProperty('--tile', `${settings.tileMin}px`);
  $('#btnRecord').addEventListener('click', () => (recordingAll ? stopRecordingAll() : startRecordingAll()));
  const prevBtn = $('#btnPreview');
  const showPrev = () => setIcon(prevBtn, settings.preview ? 'eye' : 'eyeOff',
    settings.preview ? 'Preview is on (click to turn off)' : 'Preview is off (click to turn on)');
  setIcon($('#btnRecord'), 'record', 'Start recording');
  setIcon($('#btnFolder'), 'folder', 'Open recordings folder');
  setIcon($('#btnSettings'), 'gear', 'Settings');
  showPrev();
  prevBtn.addEventListener('click', async () => {
    settings = await mc.setSettings({ preview: !settings.preview });
    showPrev();
    cams.forEach(attachPreview);
  });
  $('#btnFolder').addEventListener('click', () => mc.openFolder());
  document.querySelector('main').addEventListener('click', (e) => { if (!e.target.closest('.tile')) selectCam(null); });
  // dropping a card on empty space moves it to the end
  document.querySelector('main').addEventListener('dragover', (e) => e.preventDefault());
  document.querySelector('main').addEventListener('drop', (e) => {
    e.preventDefault();
    const dragged = cams.get(e.dataTransfer.getData('text/plain'));
    const list = ordered();
    if (dragged && list.length && list[list.length - 1] !== dragged) reorder(dragged, list[list.length - 1]);
  });
  $('#btnSettings').addEventListener('click', () => { fillSettings(); $('#settings').classList.toggle('hidden'); });
  $('#sClose').addEventListener('click', () => $('#settings').classList.add('hidden'));
  // drag the top edge of the footer to resize the log
  const logEl = $('#log'), grab = $('#logResize');
  const setLogH = (h) => { logEl.style.height = `${Math.max(40, Math.min(h, window.innerHeight * 0.7))}px`; };
  const savedH = Number(localStorage.getItem('logH')); if (savedH) setLogH(savedH);
  grab.addEventListener('pointerdown', (e) => {
    e.preventDefault(); grab.setPointerCapture(e.pointerId); grab.classList.add('drag');
    const y0 = e.clientY, h0 = logEl.offsetHeight;
    const move = (ev) => setLogH(h0 + (y0 - ev.clientY));
    const up = () => { grab.classList.remove('drag'); grab.removeEventListener('pointermove', move); grab.removeEventListener('pointerup', up); localStorage.setItem('logH', logEl.offsetHeight); };
    grab.addEventListener('pointermove', move); grab.addEventListener('pointerup', up);
  });
  // click anywhere outside the open settings panel closes it (the gear button keeps its own toggle)
  document.addEventListener('pointerdown', (e) => {
    const panel = $('#settings');
    if (panel.classList.contains('hidden')) return;
    if (panel.contains(e.target) || $('#btnSettings').contains(e.target)) return;
    panel.classList.add('hidden');
  });
  $('#sApply').addEventListener('click', applySettings);
  $('#sMotion').addEventListener('change', (e) => $('#motionRow').classList.toggle('hidden', !e.target.checked));
  $('#sBrowse').addEventListener('click', async () => { const d = await mc.chooseDir(); if (d) $('#sOutputDir').value = d; });
  const tile = $('#tileSize');
  tile.value = settings.tileMin;
  tile.addEventListener('input', () => {
    document.documentElement.style.setProperty('--tile', `${tile.value}px`);
    saveTile(Number(tile.value));
  });
}

// ---------- start-up ----------
async function init() {
  env = await mc.env();
  settings = await mc.getSettings();
  bindUI();
  mc.onLog(log);

  try {   // one throw-away request: triggers the OS permission prompt and unlocks device names
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    s.getTracks().forEach((t) => t.stop());
  } catch (e) {
    log(`camera access problem: ${e.name} ${e.message || ''} (check OS camera permission)`);
  }

  await refreshDevices();
  navigator.mediaDevices.addEventListener('devicechange', debounce(refreshDevices, 800));
  document.addEventListener('visibilitychange', () => { for (const cam of cams.values()) attachPreview(cam); });
  setInterval(refreshDevices, 3000);                 // safety net: devicechange isn't reliable on every OS/driver
  setInterval(updateStats, 1000);
  setInterval(updateDisk, 15000);
  updateDisk();

  mc.onRequestClose(async () => { await stopRecordingAll(); mc.closeOk(); });
  mc.onSmokeFinish(async () => {
    await stopRecordingAll();
    mc.smokeDone([...cams.values()].map((c) => ({ name: c.cfg.name, folder: c.cfg.folder, slot: ordered().indexOf(c) + 1, order: c.el.style.order, info: c.info, bytes: c.bytesTotal, status: c.status, maxRatio: c.maxRatio || 0, triggers: c.triggers || 0 })));
  });

  if (env.smoke || settings.autoStart || sessionStorage.getItem('rec') === '1') startRecordingAll();
}

init().catch((e) => { log(`startup error: ${e.message}`); console.error(e); });
