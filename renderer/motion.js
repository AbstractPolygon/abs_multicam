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

  // Mean brightness of an RGBA frame (green channel is a good luma stand-in).
  function meanLuma(f) { let s = 0; for (let i = 1; i < f.length; i += 4) s += f[i]; return s / (f.length / 4); }

  function createDetector(pixelmatch) {
    const history = [];
    return {
      // rgba: Uint8ClampedArray of WIDTH*HEIGHT*4. Returns the fraction of pixels that changed (0..1).
      feed(rgba, level) {
        const cur = new Uint8ClampedArray(rgba);
        history.push(cur);
        if (history.length > LAG + 1) history.shift();
        if (history.length <= LAG) return 0;
        const L = LEVELS[level] || LEVELS[1];
        // Light flicker and auto-exposure change the whole frame at once. That is not movement, so shift the
        // newer frame to the older frame's average brightness before comparing.
        const shift = meanLuma(history[0]) - meanLuma(cur);
        let cmp = cur;
        if (Math.abs(shift) > 0.5) {
          cmp = new Uint8ClampedArray(cur.length);
          for (let i = 0; i < cur.length; i += 4) { cmp[i] = cur[i] + shift; cmp[i + 1] = cur[i + 1] + shift; cmp[i + 2] = cur[i + 2] + shift; cmp[i + 3] = 255; }
        }
        const diff = pixelmatch(history[0], cmp, null, WIDTH, HEIGHT, { threshold: L.threshold, includeAA: true });
        return diff / (WIDTH * HEIGHT);
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
      update(moving, now) {
        if (moving) { streak++; lastMove = now; } else streak = 0;
        if (!active && streak >= startSamples) { active = true; return 'start'; }
        if (active && !moving && now - lastMove >= holdMs) { active = false; streak = 0; return 'stop'; }
        return null;
      },
      reset() { streak = 0; active = false; }
    };
  }

  const api = { LEVELS, WIDTH, HEIGHT, LAG, createDetector, createTrigger };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Motion = api;
})(typeof window !== 'undefined' ? window : globalThis);
