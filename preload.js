'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mc', {
  env: () => ipcRenderer.invoke('app:env'),
  updateState: () => ipcRenderer.invoke('update:state'),
  onUpdate: (cb) => ipcRenderer.on('update:ready', (_e, u) => cb(u)),
  installUpdate: () => ipcRenderer.send('update:install'),
  saveSnapshot: (folder, bytes) => ipcRenderer.invoke('snapshot:save', folder, bytes),
  hwInfo: () => ipcRenderer.invoke('hw:info'),
  recOpenHw: (folder, params) => ipcRenderer.invoke('rec:openHw', folder, params),
  recFrame: (id, bytes) => ipcRenderer.send('rec:frame', id, bytes),
  recSize: (id) => ipcRenderer.invoke('rec:size', id),
  onHwFailed: (cb) => ipcRenderer.on('rec:hw-failed', (_e, v) => cb(v)),
  recState: (on) => ipcRenderer.send('rec:state', on),
  gpuInfo: () => ipcRenderer.invoke('gpu:info'),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  chooseDir: () => ipcRenderer.invoke('dialog:chooseDir'),
  openFolder: () => ipcRenderer.invoke('shell:openFolder'),
  diskInfo: () => ipcRenderer.invoke('disk:info'),
  recOpen: (folder) => ipcRenderer.invoke('rec:open', folder),
  recWrite: (id, bytes) => ipcRenderer.send('rec:write', id, bytes),
  recMeta: (id, meta) => ipcRenderer.invoke('rec:meta', id, meta),
  recClose: (id, endMs) => ipcRenderer.invoke('rec:close', id, endMs),
  onLog: (cb) => ipcRenderer.on('log', (_e, msg) => cb(msg)),
  onRequestClose: (cb) => ipcRenderer.on('app:request-close', () => cb()),
  closeOk: () => ipcRenderer.send('app:close-ok'),
  onSmokeFinish: (cb) => ipcRenderer.on('smoke:finish', () => cb()),
  smokeDone: (report) => ipcRenderer.invoke('smoke:done', report)
});
