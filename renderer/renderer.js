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
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
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

// The zone overlay sits exactly over the picture (the video is letterboxed inside its frame).
function layoutZones(cam) {
  if (!cam.zbox) return;
  const wrap = cam.el.querySelector('.vwrap'), W = wrap.clientWidth, H = wrap.clientHeight;
  const vw = cam.video.videoWidth || 16, vh = cam.video.videoHeight || 9, s = Math.min(W / vw, H / vh);
  Object.assign(cam.zbox.style, { left: (W - vw * s) / 2 + 'px', top: (H - vh * s) / 2 + 'px', width: vw * s + 'px', height: vh * s + 'px' });
}
function drawZones(cam) {
  if (!cam.zbox) return;
  cam.zbox.innerHTML = '';
  (cam.cfg.zones || []).forEach((z, i) => {
    const d = document.createElement('div');
    const selected = cam.zoneEdit && i === cam.zoneSel;
    d.className = 'zone ' + (cam.cfg.zoneMode === 'outside' ? 'ignore' : 'watch') + (selected ? ' sel' : '');
    Object.assign(d.style, { left: z.x * 100 + '%', top: z.y * 100 + '%', width: z.w * 100 + '%', height: z.h * 100 + '%' });
    if (selected) {
      for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) { const hd = document.createElement('span'); hd.className = 'zh zh-' + h; hd.dataset.h = h; d.appendChild(hd); }
      const x = document.createElement('button'); x.className = 'zdel'; x.title = 'Delete this zone (Delete key)'; x.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>'; d.appendChild(x);
    }
    cam.zbox.appendChild(d);
  });
}
function deleteSelectedZone(cam) {
  const zs = cam.cfg.zones || [];
  if (cam.zoneSel < 0 || cam.zoneSel >= zs.length) return;
  zs.splice(cam.zoneSel, 1); cam.zoneSel = -1;
  if (zs.length) cam.cfg.zones = zs; else delete cam.cfg.zones;
  saveCameras(); drawZones(cam);
}

// While zones are being edited the camera runs a live movement test: it uses the same detector, sensitivity and zones
// as recording, but only lights up the zones and a "Movement" tag. It never starts a recording (armMotion pauses
// for a camera that is in zone-edit mode).
function startZoneTest(cam) {
  stopZoneTest(cam);
  if (!cam.stream) return;
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.srcObject = cam.stream;
  v.play().catch(() => {});
  const det = Motion.createDetector(window.pixelmatch);
  const t = { v, timer: null, hitUntil: 0, mask: null, maskKey: '' };
  t.timer = setInterval(() => {
    const feed = window.__motionFeed && window.__motionFeed[cam.cfg.folder];
    if (v.readyState < 2 && !feed) return;
    if (!feed) detCtx.drawImage(v, 0, 0, Motion.WIDTH, Motion.HEIGHT);
    const level = cam.cfg.motionLevel != null ? cam.cfg.motionLevel : settings.motionLevel;
    const key = JSON.stringify([cam.cfg.zones, cam.cfg.zoneMode]);
    if (t.maskKey !== key) { t.maskKey = key; t.mask = Motion.buildMask(cam.cfg.zones, cam.cfg.zoneMode); }
    const ratio = det.feed(feed ? feed() : detCtx.getImageData(0, 0, Motion.WIDTH, Motion.HEIGHT).data, level, t.mask);
    if (ratio >= Motion.LEVELS[level].ratio) t.hitUntil = Date.now() + 700;      // keep the light on between samples
    const on = Date.now() < t.hitUntil;
    cam.zbox.classList.toggle('hit', on);
    cam.hitTag.classList.toggle('hidden', !on);
  }, 250);
  cam.zoneTest = t;
}
function stopZoneTest(cam) {
  if (!cam.zoneTest) return;
  clearInterval(cam.zoneTest.timer);
  cam.zoneTest.v.srcObject = null;
  cam.zoneTest = null;
  if (cam.zbox) cam.zbox.classList.remove('hit');
  if (cam.hitTag) cam.hitTag.classList.add('hidden');
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
// Keyboard shortcuts (ignored while typing in a field): R record/stop, P preview, S snapshot (selected camera, else all),
// F full screen for the selected camera, O open the recordings folder. Esc leaves full screen or closes Settings.
document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, select, textarea')) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const zcam = [...cams.values()].find((c) => c.zoneEdit && c.zoneSel >= 0);
  if (zcam && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); deleteSelectedZone(zcam); return; }
  if (zcam && e.key === 'Escape') { zcam.zoneSel = -1; drawZones(zcam); return; }
  const cam = selectedCam();
  switch (e.key.toLowerCase()) {
    case 'r': $('#btnRecord').click(); break;
    case 'p': $('#btnPreview').click(); break;
    case 'o': $('#btnFolder').click(); break;
    case 's': if (cam) snapshot(cam); else cams.forEach((c) => snapshot(c)); break;
    case 'f': if (cam) toggleFullscreen(cam); break;
    case 'escape': $('#settings').classList.add('hidden'); break;
    default: break;
  }
});

// Save the current picture of a camera as a PNG in <output folder>/snapshots, at the camera's full resolution.
async function snapshot(cam) {
  if (!cam.track || cam.track.readyState !== 'live') return;
  try {
    let bmp;
    if (window.ImageCapture) bmp = await new ImageCapture(cam.track).grabFrame();
    else bmp = await createImageBitmap(cam.video);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    const file = await mc.saveSnapshot(cam.cfg.folder, new Uint8Array(await blob.arrayBuffer()));
    cam.el.classList.add('flash'); setTimeout(() => cam.el.classList.remove('flash'), 250);
    log(`${cam.cfg.name}: snapshot saved (${file.split(/[\\/]/).pop()})`);
  } catch (e) { log(`${cam.cfg.name}: snapshot failed (${e.message})`); }
}

// ---------- tiles ----------
function buildTile(cam) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.innerHTML = `
    <div class="vwrap"><video muted playsinline autoplay></video><div class="noprev hidden">Preview off</div><div class="zonebox"></div><span class="hitbadge hidden">Movement</span>
      <span class="rec hidden">&#9679; REC</span>
      <div class="vstate"><span class="badge"></span><span class="tc">--:--:--:--</span></div>
      <button class="vbtn snapbtn"></button>
      <button class="vbtn fsbtn"></button></div>
    <div class="bar"><span class="grip" title="Drag the card to reorder it">&#8942;&#8942;</span>
      <select class="slot" title="Slot: the position of this camera in the grid"></select>
      <input class="name" maxlength="60" spellcheck="false">
      <button class="icon camset"></button>
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
      <select class="o-bitrate" title="Bitrate for this camera (applies from its next file)"><option value="default">Default Mbps</option><option value="500">0.5 Mbps</option><option value="1000">1 Mbps</option><option value="2500">2.5 Mbps</option><option value="5000">5 Mbps</option><option value="8000">8 Mbps</option><option value="12000">12 Mbps</option><option value="20000">20 Mbps</option></select>
      </div>
      <label title="Include this camera. Unticking also releases its USB bandwidth."><input type="checkbox" class="en"> record</label></div>
    <div class="camopts hidden">
      <label>Movement
        <select class="o-motion"><option value="default">Default</option><option value="0">Subtle</option><option value="1">Normal</option><option value="2">High</option></select></label>
      <label>Stop after
        <select class="o-hold"><option value="default">Default</option><option value="3">3 s</option><option value="8">8 s</option><option value="15">15 s</option><option value="30">30 s</option><option value="60">1 min</option><option value="300">5 min</option></select></label>
      <label>Zones
        <select class="o-zonemode"><option value="inside">Inside zones</option><option value="outside">Outside zones</option></select></label>
      <div class="zonebtns"><button class="zone-edit" title="Drag on the picture to add a zone. Click a zone to select it: drag to move, drag the handles to resize, Delete key or the red x to remove.">Edit zones</button><button class="zone-clear" title="Remove all zones">Clear</button></div>
    </div>
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
  // per-camera overrides of the global movement / bitrate settings
  const camset = el.querySelector('.camset'), opts = el.querySelector('.camopts');
  setIcon(camset, 'sliders', 'Camera settings');
  camset.addEventListener('click', (e) => {
    e.stopPropagation(); opts.classList.toggle('hidden'); camset.classList.toggle('active', !opts.classList.contains('hidden'));
    if (opts.classList.contains('hidden')) cam.zoneEdit = false;
    cam.syncZoneView();
  });
  // motion zones: drag to add, click to select, drag to move, handles to resize, Delete to remove
  const zbox = el.querySelector('.zonebox'), zEdit = opts.querySelector('.zone-edit'), zMode = opts.querySelector('.o-zonemode');
  cam.zbox = zbox; cam.zoneEdit = false; cam.zoneSel = -1; cam.hitTag = el.querySelector('.hitbadge');
  zMode.value = cam.cfg.zoneMode === 'outside' ? 'outside' : 'inside';
  cam.syncZoneView = () => {
    zbox.classList.toggle('editing', cam.zoneEdit);
    zbox.classList.toggle('shown', cam.zoneEdit || !opts.classList.contains('hidden'));
    if (!cam.zoneEdit) cam.zoneSel = -1;
    zEdit.textContent = cam.zoneEdit ? 'Done' : 'Edit zones';
    layoutZones(cam); drawZones(cam);
    if (cam.zoneEdit) startZoneTest(cam); else stopZoneTest(cam);
  };
  zMode.addEventListener('change', () => { cam.cfg.zoneMode = zMode.value; saveCameras(); drawZones(cam); });
  zEdit.addEventListener('click', () => { cam.zoneEdit = !cam.zoneEdit; cam.syncZoneView(); });
  opts.querySelector('.zone-clear').addEventListener('click', () => { cam.zoneSel = -1; delete cam.cfg.zones; saveCameras(); drawZones(cam); });
  const wrap = el.querySelector('.vwrap');
  new ResizeObserver(() => layoutZones(cam)).observe(wrap);
  cam.video.addEventListener('loadedmetadata', () => layoutZones(cam));
  cam.video.addEventListener('resize', () => layoutZones(cam));
  zbox.addEventListener('pointerdown', (e) => {
    if (!cam.zoneEdit) return;
    e.preventDefault(); e.stopPropagation();
    if (document.activeElement && document.activeElement.blur && /^(SELECT|INPUT|BUTTON)$/.test(document.activeElement.tagName)) document.activeElement.blur();   // so the Delete key reaches the zones
    if (e.target.closest && e.target.closest('.zdel')) { deleteSelectedZone(cam); return; }
    try { zbox.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events in tests */ }
    const rect = zbox.getBoundingClientRect();
    const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
    const pt = (ev) => ({ x: clamp((ev.clientX - rect.left) / rect.width), y: clamp((ev.clientY - rect.top) / rect.height) });
    const q = (v) => Math.round(v * 10000) / 10000;
    const MIN = 0.02;
    const zs = cam.cfg.zones || [];
    const start = pt(e);
    const inside = (z) => start.x >= z.x && start.x <= z.x + z.w && start.y >= z.y && start.y <= z.y + z.h;
    const handle = e.target.closest && e.target.closest('.zh');
    let mode = 'draw', idx = -1, orig = null, hn = '';
    if (handle && cam.zoneSel >= 0 && zs[cam.zoneSel]) { mode = 'resize'; idx = cam.zoneSel; hn = handle.dataset.h; orig = { ...zs[idx] }; }
    else {
      if (cam.zoneSel >= 0 && zs[cam.zoneSel] && inside(zs[cam.zoneSel])) idx = cam.zoneSel;       // the selected zone wins when zones overlap
      else for (let i = zs.length - 1; i >= 0; i--) if (inside(zs[i])) { idx = i; break; }
      if (idx >= 0) { mode = 'move'; orig = { ...zs[idx] }; cam.zoneSel = idx; drawZones(cam); }
    }
    let b = start, changed = false;
    const rub = mode === 'draw' ? Object.assign(document.createElement('div'), { className: 'zone rubber' }) : null;
    if (rub) zbox.appendChild(rub);
    const move = (ev) => {
      b = pt(ev);
      if (mode === 'draw') {
        Object.assign(rub.style, { left: Math.min(start.x, b.x) * 100 + '%', top: Math.min(start.y, b.y) * 100 + '%', width: Math.abs(start.x - b.x) * 100 + '%', height: Math.abs(start.y - b.y) * 100 + '%' });
      } else if (mode === 'move') {
        zs[idx] = { x: q(clamp(orig.x + b.x - start.x, 0, 1 - orig.w)), y: q(clamp(orig.y + b.y - start.y, 0, 1 - orig.h)), w: orig.w, h: orig.h };
        changed = true; drawZones(cam);
      } else {
        let l = orig.x, rt = orig.x + orig.w, t = orig.y, bt = orig.y + orig.h;
        if (hn.includes('w')) l = Math.min(b.x, rt - MIN);
        if (hn.includes('e')) rt = Math.max(b.x, l + MIN);
        if (hn.includes('n')) t = Math.min(b.y, bt - MIN);
        if (hn.includes('s')) bt = Math.max(b.y, t + MIN);
        zs[idx] = { x: q(l), y: q(t), w: q(rt - l), h: q(bt - t) };
        changed = true; drawZones(cam);
      }
    };
    const up = () => {
      zbox.removeEventListener('pointermove', move); zbox.removeEventListener('pointerup', up);
      if (rub) rub.remove();
      if (mode === 'draw') {
        const x = Math.min(start.x, b.x), y = Math.min(start.y, b.y), w = Math.abs(start.x - b.x), h = Math.abs(start.y - b.y);
        if (w < MIN && h < MIN) cam.zoneSel = -1;                                    // a click on empty space deselects
        else if (w >= MIN && h >= MIN && zs.length < 20) { zs.push({ x: q(x), y: q(y), w: q(w), h: q(h) }); cam.zoneSel = zs.length - 1; changed = true; }
      }
      if (zs.length) cam.cfg.zones = zs; else delete cam.cfg.zones;
      if (changed) saveCameras();
      drawZones(cam);
    };
    zbox.addEventListener('pointermove', move); zbox.addEventListener('pointerup', up);
  });
  drawZones(cam);
  for (const [cls, key] of [['.o-motion', 'motionLevel'], ['.o-hold', 'holdSeconds'], ['.o-bitrate', 'bitrateKbps']]) {
    const sel = el.querySelector(cls);
    const have = cam.cfg[key];
    if (have != null && ![...sel.options].some((o) => o.value === String(have))) sel.add(new Option(key === 'bitrateKbps' ? `${have} kbps` : `${have}${key === 'holdSeconds' ? ' s' : ''}`, String(have)));
    sel.value = have != null ? String(have) : 'default';
    sel.addEventListener('change', () => {
      if (sel.value === 'default') delete cam.cfg[key]; else cam.cfg[key] = Number(sel.value);
      saveCameras();
    });
  }
  cam.slotSel = el.querySelector('.slot');
  cam.slotSel.addEventListener('change', () => moveToSlot(cam, cam.slotSel.value));
  // Drag the card by any part that isn't a control (text boxes and dropdowns must stay usable).
  el.addEventListener('mousedown', (e) => { el.draggable = !e.target.closest('input, select, button, label, .zonebox.editing'); });
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
  const snapBtn = el.querySelector('.snapbtn');
  setIcon(snapBtn, 'camera', 'Snapshot (S)');
  snapBtn.addEventListener('click', (e) => { e.stopPropagation(); snapshot(cam); });
  setIcon(el.querySelector('.fsbtn'), 'expand', 'Full screen (F, or double-click the picture). Esc to leave.');
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

// Measured frame rate and dropped frames of the live preview, sampled once a second.
setInterval(() => {
  for (const cam of cams.values()) {
    // measured bitrate: bytes written over the last ~6 seconds
    if (cam.recording) {
      const pts = (cam.brPts = cam.brPts || []);
      pts.push({ t: performance.now(), b: cam.bytesTotal }); while (pts.length > 6) pts.shift();
      const dt = pts.length > 1 ? (pts[pts.length - 1].t - pts[0].t) / 1000 : 0;
      cam.brText = dt >= 1.5 ? `${((pts[pts.length - 1].b - pts[0].b) * 8 / dt / 1e6).toFixed(1)} Mbps` : '';
    } else { cam.brPts = null; cam.brText = ''; }
    const v = cam.video;
    if (!v.srcObject || document.hidden || !v.getVideoPlaybackQuality) { cam.fpsText = ''; cam.q = null; continue; }
    const q = v.getVideoPlaybackQuality(), now = performance.now();
    if (cam.q && now - cam.q.t > 500) {
      const fps = (q.totalVideoFrames - cam.q.total) * 1000 / (now - cam.q.t);
      cam.fpsText = `${fps.toFixed(1)} fps  ·  ${q.droppedVideoFrames} dropped`;
    }
    if (!cam.q || now - cam.q.t > 500) cam.q = { total: q.totalVideoFrames, t: now };
  }
}, 1000);

function updateStats() {
  for (const cam of cams.values()) {
    const parts = [];
    if (cam.info) parts.push(cam.info);
    if (cam.fpsText) parts.push(cam.fpsText);
    if (cam.brText) parts.push(cam.brText);
    if (cam.recording || cam.bytesTotal) parts.push(fmtBytes(cam.bytesTotal));
    if (cam.motion && !cam.recording) parts.push('no movement');
    cam.stat.textContent = parts.join('  ·  ') || ' ';
    if (/error|lost/.test(cam.status || '')) { cam.stat.innerHTML = `<span class="err">${cam.status}</span>`; }
    cam.recTag.classList.toggle('hidden', !cam.recording);
  }
  $('#count').textContent = `${cams.size} camera${cams.size === 1 ? '' : 's'}`;
  $('#empty').classList.toggle('hidden', cams.size > 0);
}

// Low disk space: amber below twice the "keep drive free" amount, red below that amount (the oldest recordings
// are being deleted to make room, or nothing is left to delete).
let diskState = '';
async function updateDisk() {
  const d = await mc.diskInfo();
  const total = d.perCamera.reduce((s, x) => s + x.bytes, 0);
  const keep = settings.minFreeGB * 1024 ** 3;
  const state = d.free === null || keep <= 0 ? '' : d.free < keep ? 'crit' : d.free < keep * 2 ? 'warn' : '';
  const el = $('#disk');
  el.className = `muted ${state}`.trim();
  el.textContent = `${state ? 'Low disk space: ' : 'Free space: '}${fmtBytes(d.free)}   ·   Recordings: ${fmtBytes(total)} in ${d.perCamera.length} folder(s)   ·   ${d.outputDir}`;
  if (state !== diskState) {
    diskState = state;
    if (state) log(`low disk space: ${fmtBytes(d.free)} free`);
  }
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
  stopZoneTest(cam);
  stopBurn(cam);
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
    if (cam.zoneEdit) startZoneTest(cam);
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
    if (v.readyState < 2 || !recordingAll || cam.zoneEdit) return;      // a camera whose zones are being edited never starts a recording
    detCtx.drawImage(v, 0, 0, Motion.WIDTH, Motion.HEIGHT);
    const level = cam.cfg.motionLevel != null ? cam.cfg.motionLevel : settings.motionLevel;
    const feed = window.__motionFeed && window.__motionFeed[cam.cfg.folder];       // self-test only: synthetic frames per camera
    const key = JSON.stringify([cam.cfg.zones, cam.cfg.zoneMode]);
    if (cam.maskKey !== key) { cam.maskKey = key; cam.mask = Motion.buildMask(cam.cfg.zones, cam.cfg.zoneMode); }
    const ratio = det.feed(feed ? feed() : detCtx.getImageData(0, 0, Motion.WIDTH, Motion.HEIGHT).data, level, cam.mask);
    cam.motion.ratio = ratio; cam.maxRatio = Math.max(cam.maxRatio || 0, ratio);
    const ev = trig.update(ratio >= Motion.LEVELS[level].ratio, Date.now(), (cam.cfg.holdSeconds || settings.motionHoldSeconds) * 1000);
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

// ---------- burned-in label (optional) ----------
// Draws every frame onto a canvas together with the camera name and the PC clock, and records the canvas
// instead of the raw camera stream. Costs extra CPU, so it only runs when the option is on.
function startBurn(cam) {
  stopBurn(cam);
  if (!cam.stream) return;
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.srcObject = cam.stream;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const burn = { v, canvas, stream: canvas.captureStream(), stopped: false };
  const pad = (n) => String(n).padStart(2, '0');
  const draw = () => {
    if (burn.stopped) return;
    if (v.videoWidth && (canvas.width !== v.videoWidth || canvas.height !== v.videoHeight)) { canvas.width = v.videoWidth; canvas.height = v.videoHeight; }
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const d = new Date();
    const text = `${cam.cfg.name}   ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const size = Math.max(14, Math.round(canvas.height / 26));
    ctx.font = `600 ${size}px system-ui, "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width, bx = Math.round(size * 0.5), bh = Math.round(size * 1.6), by = canvas.height - bh - bx;
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(bx, by, w + size, bh);
    ctx.fillStyle = '#fff'; ctx.fillText(text, bx + size / 2, by + bh / 2);
    v.requestVideoFrameCallback(draw);
  };
  v.play().then(() => v.requestVideoFrameCallback(draw)).catch(() => {});
  cam.burn = burn;
}
function stopBurn(cam) {
  if (!cam.burn) return;
  cam.burn.stopped = true;
  cam.burn.stream.getTracks().forEach((t) => t.stop());
  cam.burn.v.srcObject = null;
  cam.burn = null;
}
// resolves once the first labelled frame exists, so the recorder never starts on an empty canvas
async function burnReady(cam) {
  for (let i = 0; i < 50 && cam.burn && !cam.burn.canvas.width; i++) await new Promise((r) => setTimeout(r, 100));
}

// ---------- recording (rolling segments) ----------
function pickMime() {
  const pref = settings.codec;
  const order = [pref, ...['h264', 'vp8', 'vp9'].filter((c) => c !== pref)];   // preferred codec first, others as fallback
  for (const c of order) { const m = `video/webm;codecs=${c}`; if (MediaRecorder.isTypeSupported(m)) return m; }
  return MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : '';
}

// Hardware encoder: raw frames of the camera (or of the burn-in canvas) are sent to ffmpeg in the main process, which
// encodes with the Pi's H.264 hardware and writes the .mp4. Returns null if it cannot start, and the caller then
// records with the browser's software encoder instead.
const hwWanted = (cam) => settings.encoder === 'v4l2' && hw.available && !cam.hwFailed && typeof MediaStreamTrackProcessor !== 'undefined';
const HW_FORMATS = { I420: 'yuv420p', NV12: 'nv12', RGBA: 'rgba', BGRA: 'bgra', RGBX: 'rgb0', BGRX: 'bgr0' };

async function beginSegmentHw(cam) {
  const src = cam.burn ? cam.burn.stream.getVideoTracks()[0] : cam.track;
  if (!src) return null;
  const track = src.clone();                                 // own copy of the track: stopping it never touches the preview
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  const release = () => { try { reader.cancel(); } catch (_) { /* done */ } track.stop(); };
  let first;
  try { first = await Promise.race([reader.read(), new Promise((_, no) => setTimeout(() => no(new Error('no frames')), 4000))]); }
  catch (e) { release(); log(`${cam.cfg.name}: hardware encoder not started (${e.message})`); return null; }
  if (!first || first.done || !first.value) { release(); return null; }
  const frame = first.value;
  // Frames whose pixels can be read directly are sent as they are. GPU-backed frames (no readable format) are drawn
  // on a canvas first and sent as RGBA, which costs more but works with any camera and driver.
  const nativeFmt = frame.format ? HW_FORMATS[frame.format] : null;
  const useCanvas = !nativeFmt;
  const vr = (!useCanvas && frame.visibleRect) || { width: frame.displayWidth, height: frame.displayHeight };
  const w = vr.width, h = vr.height;
  const pixFmt = useCanvas ? 'rgba' : nativeFmt;
  const bytes = useCanvas ? w * h * 4 : frame.allocationSize();
  if (w % 2 || h % 2) { log(`${cam.cfg.name}: hardware encoder cannot take this picture size (${w}x${h})`); frame.close(); release(); return null; }
  const cv = useCanvas ? new OffscreenCanvas(w, h) : null;
  const cx = cv ? cv.getContext('2d', { willReadFrequently: true }) : null;
  const st = cam.track ? cam.track.getSettings() : {};
  const fps = Math.max(1, Math.round(st.frameRate || cam.cfg.fps || settings.fps));
  const startMs = Date.now();
  const opened = await mc.recOpenHw(cam.cfg.folder, { width: w, height: h, pixFmt, fps, bitrateKbps: cam.cfg.bitrateKbps || settings.bitrateKbps, frameBytes: bytes, startEpochMs: startMs });
  if (!opened || opened.error || !cam.recording || !cam.stream) {
    frame.close(); release();
    if (opened && opened.id) await mc.recClose(opened.id, Date.now());
    if (opened && opened.error) log(`${cam.cfg.name}: hardware encoder not started (${opened.error})`);
    return null;
  }
  const recId = opened.id;
  mc.recMeta(recId, { startEpochMs: startMs, camera: cam.cfg.name, folder: cam.cfg.folder, slot: ordered().indexOf(cam) + 1, width: w, height: h, frameRate: st.frameRate, fps, codec: 'h264', container: 'mp4', encoder: opened.encoder });
  const seg = { recId, chain: Promise.resolve(), closed: null, bytes: 0, hw: true, splitting: false };
  let stopping = false;
  seg.rec = { state: 'recording', stop() { if (stopping) return; stopping = true; seg.rec.state = 'inactive'; release(); } };
  const push = async (f) => {
    try {
      if (useCanvas) {
        if (f.displayWidth !== w || f.displayHeight !== h) return;
        cx.drawImage(f, 0, 0, w, h);
        const d = cx.getImageData(0, 0, w, h).data;
        mc.recFrame(recId, new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
      } else {
        if (f.visibleRect && (f.visibleRect.width !== w || f.visibleRect.height !== h)) return;
        const buf = new Uint8Array(bytes);
        await f.copyTo(buf);
        mc.recFrame(recId, buf);
      }
    } catch (_) { /* frame lost, the next one follows */ }
    finally { f.close(); }
  };
  const loop = (async () => {
    await push(frame);
    while (!stopping) {
      let res; try { res = await reader.read(); } catch (_) { break; }
      if (!res || res.done) break;
      await push(res.value);
    }
  })();
  // file size comes from the main process; it drives the loop's 4 GB split just like the browser recorder does
  const limit = env.maxFileBytes, splitAt = limit - Math.min(64 * 1024 * 1024, limit * 0.25);
  let rate = 0;                                                  // bytes per second, smoothed
  const timer = setInterval(async () => {
    const sz = await mc.recSize(recId);
    rate = 0.5 * rate + 0.5 * Math.max(0, sz - seg.bytes);
    cam.bytesTotal += Math.max(0, sz - seg.bytes); seg.bytes = sz;
    // the .mp4 only grows when ffmpeg finishes a fragment (every keyframe), so look a few seconds ahead
    if (sz + rate * 4 >= splitAt && !seg.splitting && cam.seg === seg && cam.recording) { seg.splitting = true; log(`${cam.cfg.name}: file reached the size cap, splitting`); rotate(cam); }
  }, 1000);
  seg.closed = loop.then(async () => { clearInterval(timer); release(); await mc.recClose(recId, Date.now()); }).catch(() => clearInterval(timer));
  cam.seg = seg;
  return seg;
}

// ffmpeg reported a problem (no such encoder, no hardware, ...): carry on with software encoding for that camera
mc.onHwFailed(async ({ id, err }) => {
  const cam = [...cams.values()].find((c) => c.seg && c.seg.recId === id);
  if (!cam) return;
  cam.hwFailed = true;
  log(`${cam.cfg.name}: hardware encoder failed (${err}); using software encoding`);
  const old = cam.seg;
  old.rec.stop();
  try { await old.closed; } catch (_) { /* ignore */ }
  if (cam.recording && cam.stream) await beginSegment(cam);
});

async function beginSegment(cam) {
  if (hwWanted(cam) && cam.recording && cam.stream) { const s = await beginSegmentHw(cam); if (s) return s; }
  const { id: recId } = await mc.recOpen(cam.cfg.folder);
  if (!cam.recording || !cam.stream) { await mc.recClose(recId, Date.now()); return null; }   // recording was stopped while the file was being opened
  const mime = pickMime();
  const rec = new MediaRecorder(cam.burn ? cam.burn.stream : cam.stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: (cam.cfg.bitrateKbps || settings.bitrateKbps) * 1000 });
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
    width: st.width, height: st.height, frameRate: st.frameRate, codec: (/codecs=(\w+)/.exec(mime) || [])[1],
    fps: Math.round(st.frameRate || cam.cfg.fps || settings.fps)       // frame rate used for the HH:MM:SS:FF timecode
  });
  cam.seg = seg;
  return seg;
}

async function startRec(cam) {
  if (!cam.stream || cam.recording) return;
  cam.recording = true;
  if (settings.burnIn) { startBurn(cam); await burnReady(cam); }
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
  const hadBurn = !!cam.burn;
  clearTimeout(cam.rot); cam.rot = null;
  const seg = cam.seg; cam.seg = null;
  if (seg) {
    if (seg.rec.state !== 'inactive') seg.rec.stop();
    await seg.closed;
  }
  if (hadBurn) stopBurn(cam);
}

async function startRecordingAll() {
  recordingAll = true;
  sessionStorage.setItem('rec', '1');                 // survives a page refresh (dev reload) so recording carries on
  mc.recState(true);
  setIcon($('#btnRecord'), 'stop', 'Stop recording (R)');
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
  mc.recState(false);
  setIcon($('#btnRecord'), 'record', 'Start recording (R)');
  $('#btnRecord').classList.remove('recording');
  await Promise.all([...cams.values()].map(async (cam) => { disarm(cam); await stopRec(cam); }));
  log('recording stopped');
}

// ---------- settings UI ----------
// "v4l2" (Raspberry Pi hardware encoder) only counts where the hardware really exists; otherwise it means software.
let hw = { available: false, name: '' };
const encoderOf = (v) => (v === 'cpu' ? 'cpu' : v === 'v4l2' ? (hw.available ? 'v4l2' : 'cpu') : 'high');     // anything else (old "auto"/"low") = best GPU
const engineOf = (v) => (v === 'high' ? 'high' : 'sw');       // Chromium's own GPU/CPU choice; v4l2 and cpu share it

async function showEncoder() {
  const sel = $('#sEncoder');
  let g = { gpus: [] };
  try { g = await mc.gpuInfo(); } catch (_) {}
  const opt = (v) => [...sel.options].find((o) => o.value === v);
  const best = g.gpus[0];
  opt('high').textContent = best ? best.name : 'GPU';
  opt('high').hidden = !best;
  opt('cpu').textContent = 'CPU';
  opt('v4l2').textContent = 'Raspberry Pi hardware (H.264)';
  opt('v4l2').hidden = !hw.available;
  sel.value = encoderOf(settings.encoder);
}

function fillSettings() {
  showEncoder();
  $('#sOutputDir').value = settings.outputDir;
  $('#sRes').value = `${settings.width}x${settings.height}`;
  $('#sFps').value = String(settings.fps);
  $('#sCodec').value = settings.codec;
  $('#sBitrate').value = settings.bitrateKbps;
  showBitrate();
  $('#sSegment').value = settings.segmentMinutes;
  $('#sMaxGB').value = settings.maxGBPerCamera;
  $('#sMaxAge').value = settings.maxAgeHours;
  $('#sMinFree').value = settings.minFreeGB;
  $('#sAutoStart').checked = settings.autoStart;
  $('#sTray').checked = settings.trayMinimize;
  $('#sUpdate').checked = settings.autoUpdate;
  $('#sBurn').checked = settings.burnIn;
  $('#sMp4').checked = settings.saveMp4;
  $('#sMotion').checked = settings.motion;
  $('#sMotionLevel').value = settings.motionLevel;
  $('#sHold').value = settings.motionHoldSeconds;
  $('#motionRow').classList.toggle('hidden', !settings.motion);
}

const showBitrate = () => { const k = Number($('#sBitrate').value); $('#sBitrateVal').textContent = k >= 1000 ? `${(k / 1000).toFixed(k % 1000 ? 2 : 0).replace(/0$/, '')} Mbps` : `${k} kbps`; };

async function applySettings() {
  const [w, h] = $('#sRes').value.split('x').map(Number);
  const before = { w: settings.width, h: settings.height, fps: settings.fps, enc: encoderOf(settings.encoder), motion: settings.motion, burn: settings.burnIn };
  settings = await mc.setSettings({
    outputDir: $('#sOutputDir').value, encoder: $('#sEncoder').value,
    width: w, height: h, fps: Number($('#sFps').value), codec: $('#sCodec').value,
    bitrateKbps: Number($('#sBitrate').value), segmentMinutes: Number($('#sSegment').value),
    maxGBPerCamera: Number($('#sMaxGB').value), maxAgeHours: Number($('#sMaxAge').value),
    minFreeGB: Number($('#sMinFree').value),
    autoStart: $('#sAutoStart').checked,
    trayMinimize: $('#sTray').checked, autoUpdate: $('#sUpdate').checked,
    burnIn: $('#sBurn').checked, saveMp4: $('#sMp4').checked,
    motion: $('#sMotion').checked, motionLevel: Number($('#sMotionLevel').value), motionHoldSeconds: Number($('#sHold').value) || 8
  });
  if (engineOf(before.enc) !== engineOf(encoderOf(settings.encoder))) { await mc.relaunch(); return; }   // Chromium's GPU/CPU choice is made when the app starts
  document.documentElement.style.setProperty('--tile', `${settings.tileMin}px`);
  if (recordingAll && (before.motion !== settings.motion || before.burn !== settings.burnIn || before.enc !== encoderOf(settings.encoder))) {
    for (const cam of cams.values()) cam.hwFailed = false;                   // a new encoder choice gets a fresh try      // switch between continuous and on-movement recording
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
    settings.preview ? 'Preview is on (P)' : 'Preview is off (P)');
  setIcon($('#btnRecord'), 'record', 'Start recording (R)');
  setIcon($('#btnFolder'), 'folder', 'Open recordings folder (O)');
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
  $('#sBitrate').addEventListener('input', showBitrate);
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
  try { hw = await mc.hwInfo(); } catch (_) { /* stays unavailable */ }
  $('#version').textContent = `v${env.version}`;
  settings = await mc.getSettings();
  bindUI();
  mc.onLog(log);
  const showUpdate = (u) => {
    if (!u) return;
    const b = $('#btnUpdate');
    b.textContent = `Update v${u.version}`;
    b.title = u.mode === 'install' ? 'Restart and install the new version' : 'Open the download page';
    b.classList.remove('hidden');
    b.onclick = () => {
      if (u.mode === 'install' && recordingAll && !confirm('Recording is running. Restart and install the update now? Recording will stop.')) return;
      mc.installUpdate();
    };
  };
  mc.onUpdate(showUpdate);
  mc.updateState().then(showUpdate);

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
