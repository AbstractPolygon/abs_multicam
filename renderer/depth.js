'use strict';
// Depth view: relative depth from a single camera with Depth Anything V2 Small (ONNX, run by onnxruntime-web on
// WebGPU, or on the CPU when there is no WebGPU). Output is relative: near vs far, not metres.
// The pure helpers work in Node too (tests); the engine needs a browser.
(function (root) {
  const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];   // ImageNet statistics the model was trained with
  const MULT = 14;                                                     // the network needs sizes that are a multiple of 14
  const SIZES = { fast: 252, normal: 336, fine: 448 };                 // long side of the network input, in pixels

  // Network input size for a camera aspect ratio: long side per quality level, both sides a multiple of 14.
  function inputSize(videoW, videoH, quality) {
    const long = SIZES[quality] || SIZES.normal;
    const r = videoW >= videoH ? videoH / videoW : videoW / videoH;
    const short = Math.max(MULT, Math.round(long * r / MULT) * MULT);
    return videoW >= videoH ? { w: long, h: short } : { w: short, h: long };
  }

  // RGBA bytes -> normalised planar float32 (1,3,h,w).
  function toTensor(rgba, w, h, out) {
    const n = w * h, t = out && out.length === n * 3 ? out : new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      t[i] = (rgba[i * 4] / 255 - MEAN[0]) / STD[0];
      t[n + i] = (rgba[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
      t[2 * n + i] = (rgba[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
    }
    return t;
  }

  // 256-entry colour table, near = warm, far = dark blue (a turbo-like ramp from a few anchor colours).
  const ANCHORS = [[0, [48, 18, 59]], [0.2, [70, 107, 227]], [0.4, [26, 208, 197]], [0.6, [164, 252, 60]], [0.8, [251, 150, 33]], [1, [122, 4, 3]]];
  const LUT = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let k = 0; while (k < ANCHORS.length - 2 && x > ANCHORS[k + 1][0]) k++;
    const [x0, c0] = ANCHORS[k], [x1, c1] = ANCHORS[k + 1], f = (x - x0) / (x1 - x0);
    for (let c = 0; c < 3; c++) LUT[i * 3 + c] = Math.round(c0[c] + (c1[c] - c0[c]) * f);
  }

  // Keeps the picture steady from frame to frame: the min/max used for scaling and the values themselves are smoothed.
  function createSmoother(alphaRange = 0.15, alphaValue = 0.6) {
    let lo = null, hi = null, prev = null;
    return {
      // d: Float32Array of raw model output. Returns Uint8ClampedArray of 0..255 (255 = nearest).
      apply(d, out) {
        let mn = Infinity, mx = -Infinity;
        for (let i = 0; i < d.length; i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        lo = lo == null ? mn : lo + (mn - lo) * alphaRange;
        hi = hi == null ? mx : hi + (mx - hi) * alphaRange;
        const span = Math.max(1e-6, hi - lo);
        if (!prev || prev.length !== d.length) prev = new Float32Array(d.length), prev.fill(NaN);
        const o = out && out.length === d.length ? out : new Uint8ClampedArray(d.length);
        for (let i = 0; i < d.length; i++) {
          const v = Math.min(1, Math.max(0, (d[i] - lo) / span));
          const s = Number.isNaN(prev[i]) ? v : prev[i] + (v - prev[i]) * alphaValue;
          prev[i] = s; o[i] = s * 255;
        }
        return o;
      },
      reset() { lo = hi = prev = null; }
    };
  }

  // 0..255 depth -> RGBA through the colour table. alpha 255 = opaque.
  function colorize(depth, rgba, alpha = 255) {
    for (let i = 0; i < depth.length; i++) {
      const j = depth[i] * 3;
      rgba[i * 4] = LUT[j]; rgba[i * 4 + 1] = LUT[j + 1]; rgba[i * 4 + 2] = LUT[j + 2]; rgba[i * 4 + 3] = alpha;
    }
    return rgba;
  }

  // ---- engine (browser only): one model session shared by all cameras, runs one frame at a time ----
  function createEngine({ log = () => {} } = {}) {
    let ort = null, session = null, loading = null, provider = '';
    let chain = Promise.resolve();
    const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('could not load ' + src)); document.head.appendChild(s); });

    async function load(modelUrl) {
      if (session) return;
      if (loading) return loading;
      loading = (async () => {
        if (!window.ort) await loadScript('vendor/ort/ort.webgpu.min.js');
        ort = window.ort;
        ort.env.wasm.wasmPaths = new URL('vendor/ort/', document.baseURI).href;
        ort.env.wasm.numThreads = 1;                    // threads need cross-origin isolation, which this app does not use
        ort.env.wasm.proxy = false;
        const buf = new Uint8Array(await (await fetch(modelUrl)).arrayBuffer());
        const tries = [];
        if (navigator.gpu) tries.push(['webgpu', ['webgpu', 'wasm']]);
        tries.push(['cpu', ['wasm']]);
        let lastErr;
        for (const [name, eps] of tries) {
          try { session = await ort.InferenceSession.create(buf, { executionProviders: eps, graphOptimizationLevel: 'all' }); provider = name; break; }
          catch (e) { lastErr = e; log('depth: ' + name + ' unavailable (' + (e.message || e) + ')'); }
        }
        if (!session) throw lastErr || new Error('no execution provider');
        log('depth model ready (' + provider + ')');
      })().finally(() => { loading = null; });
      return loading;
    }

    // rgba: size.w*size.h*4 bytes. Returns {data: Float32Array, w, h} of raw relative inverse depth. Calls are queued.
    function run(rgba, size, scratch) {
      const job = chain.then(async () => {
        const input = new ort.Tensor('float32', toTensor(rgba, size.w, size.h, scratch), [1, 3, size.h, size.w]);
        const res = await session.run({ [session.inputNames[0]]: input });
        const t = res[session.outputNames[0]];
        const dims = t.dims, h = dims[dims.length - 2], w = dims[dims.length - 1];
        return { data: await t.getData(), w, h };
      });
      chain = job.catch(() => {});
      return job;
    }
    return { load, run, get ready() { return !!session; }, get provider() { return provider; } };
  }

  const api = { SIZES, inputSize, toTensor, createSmoother, colorize, createEngine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Depth = api;
})(typeof window !== 'undefined' ? window : globalThis);
