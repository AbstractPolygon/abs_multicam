'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mc', {
  env: () => ipcRenderer.invoke('app:env'),
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
