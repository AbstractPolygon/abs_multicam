'use strict';
// Copies the few onnxruntime-web files the depth view needs into renderer/vendor/ort (run by "npm install").
const fs = require('fs'), path = require('path');
const from = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist');
const to = path.join(__dirname, '..', 'renderer', 'vendor', 'ort');
if (!fs.existsSync(from)) { console.log('onnxruntime-web is not installed; skipping'); process.exit(0); }
fs.mkdirSync(to, { recursive: true });
for (const f of ['ort.webgpu.min.js', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) fs.copyFileSync(path.join(from, f), path.join(to, f));
