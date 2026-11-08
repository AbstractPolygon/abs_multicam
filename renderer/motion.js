'use strict';
// Movement detection built on pixelmatch (vendor/pixelmatch.js): compares a small downscaled frame with the
// frame from ~0.5 s earlier and reports the share of pixels that changed. Works in the browser and in Node (tests).
(function (root) {
  // slider position -> how much movement is needed. Subtle = reacts to small changes, High = only large movement.
  const LEVELS = [
    { name: 'Subtle', threshold: 0.08, ratio: 0.002 },
    { name: 'Normal', threshold: 0.12, ratio: 0.01 },
    { name: 'High',   threshold: 0.15, ratio: 0.04 }
  ];
  const WIDTH = 160, HEIGHT = 90, LAG = 2;              // detection resolution; compare with the frame LAG samples ago

  // Mean brightness (green channel) of the counted pixels of an RGBA frame.
  function meanLuma(f, mask) {
    let s = 0, n = 0;
    for (let i = 0, p = 0; i < f.length; i += 4, p++) { if (mask && !mask.data[p]) continue; s += f[i + 1]; n++; }
    return n ? s / n : 0;
  }

  // Zones are rectangles in 0..1 picture coordinates {x, y, w, h}. mode "inside": only movement inside the zones
  // counts. mode "outside": movement inside the zones is ignored. No zones = the whole picture counts.
  function buildMask(zones, mode) {
    if (!zones || !zones.length) return null;
    const data = new Uint8Array(WIDTH * HEIGHT);
    for (const z of zones) {
      const x0 = Math.max(0, Math.floor(z.x * WIDTH)), x1 = Math.min(WIDTH, Math.ceil((z.x + z.w) * WIDTH));
      const y0 = Math.max(0, Math.floor(z.y * HEIGHT)), y1 = Math.min(HEIGHT, Math.ceil((z.y + z.h) * HEIGHT));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * WIDTH + x] = 1;
    }
    let count = 0;
    if (mode === 'outside') for (let i = 0; i < data.length; i++) { data[i] = data[i] ? 0 : 1; count += data[i]; }
    else for (let i = 0; i < data.length; i++) count += data[i];
    return { data, count };
  }

  function createDetector(pixelmatch) {
    const history = [];
    const total = WIDTH * HEIGHT;
    const masked = (f, mask) => {                                 // copy with the ignored pixels blanked
      const o = new Uint8ClampedArray(f.length);
      for (let i = 0, p = 0; i < f.length; i += 4, p++) { if (mask.data[p]) { o[i] = f[i]; o[i + 1] = f[i + 1]; o[i + 2] = f[i + 2]; } o[i + 3] = 255; }
      return o;
    };
    return {
      // rgba: Uint8ClampedArray of WIDTH*HEIGHT*4. mask: from buildMask() or null. Returns the fraction of the
      // watched pixels that changed (0..1); the watched area counts as at least 5% of the picture so a tiny zone
      // is not hypersensitive.
      feed(rgba, level, mask) {
        const cur = new Uint8ClampedArray(rgba);
        history.push(cur);
        if (history.length > LAG + 1) history.shift();
        if (history.length <= LAG) return 0;
        const L = LEVELS[level] || LEVELS[1];
        if (mask && mask.count === 0) return 0;
        const a = mask ? masked(history[0], mask) : history[0];
        let b = mask ? masked(cur, mask) : cur;
        // Light flicker and auto-exposure change the whole frame at once. That is not movement, so shift the
        // newer frame to the older frame's average brightness before comparing.
        const shift = meanLuma(history[0], mask) - meanLuma(cur, mask);
        if (Math.abs(shift) > 0.5) {
          const c = new Uint8ClampedArray(b.length);
          for (let i = 0, p = 0; i < b.length; i += 4, p++) {
            if (mask && !mask.data[p]) { c[i + 3] = 255; continue; }
            c[i] = b[i] + shift; c[i + 1] = b[i + 1] + shift; c[i + 2] = b[i + 2] + shift; c[i + 3] = 255;
          }
          b = c;
        }
        const diff = pixelmatch(a, b, null, WIDTH, HEIGHT, { threshold: L.threshold, includeAA: true });
        const watched = mask ? Math.max(mask.count, total * 0.05) : total;
        return diff / watched;
      },
      reset() { history.length = 0; }
    };
  }

  // Decides when to start/stop recording: starts after `startSamples` moving samples in a row, stops after
  // `holdMs` without movement. update() returns 'start', 'stop' or null.
  function createTrigger({ startSamples = 2, holdMs = 8000 } = {}) {
    let streak = 0, active = false, lastMove = 0;
    return {
      get active() { return active; },
      update(moving, now, holdOverride) {
        const hold = holdOverride === undefined ? holdMs : holdOverride;
        if (moving) { streak++; lastMove = now; } else streak = 0;
        if (!active && streak >= startSamples) { active = true; return 'start'; }
        if (active && !moving && now - lastMove >= hold) { active = false; streak = 0; return 'stop'; }
        return null;
      },
      reset() { streak = 0; active = false; }
    };
  }

  const api = { LEVELS, WIDTH, HEIGHT, LAG, buildMask, createDetector, createTrigger };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Motion = api;
})(typeof window !== 'undefined' ? window : globalThis);
