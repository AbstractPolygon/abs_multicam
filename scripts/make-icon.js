'use strict';
// Draws the app icon (a 2x2 grid of camera lenses) and writes build/icon.png (1024x1024).
// electron-builder converts it to .ico and .icns when packaging.   Run: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const lens = (cx, cy) => `
  <circle cx="${cx}" cy="${cy}" r="150" fill="#0d1016"/>
  <circle cx="${cx}" cy="${cy}" r="150" fill="none" stroke="#3b82f6" stroke-width="26"/>
  <circle cx="${cx}" cy="${cy}" r="92" fill="#1e2a44"/>
  <circle cx="${cx}" cy="${cy}" r="52" fill="#0d1016"/>
  <circle cx="${cx - 34}" cy="${cy - 38}" r="20" fill="#ffffff" opacity="0.85"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="32" y="32" width="960" height="960" rx="220" fill="#1b1f27"/>
  <rect x="32" y="32" width="960" height="960" rx="220" fill="none" stroke="#2a303b" stroke-width="12"/>
  ${lens(332, 332)}${lens(692, 332)}${lens(332, 692)}${lens(692, 692)}
  <circle cx="906" cy="118" r="40" fill="#ef4444"/>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, useContentSize: true, frame: false, transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fin = img.getSize().width === 1024 ? img : img.resize({ width: 1024, height: 1024, quality: 'best' });   // capture is DPI-scaled on some displays
  fs.writeFileSync(out, fin.toPNG());
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), svg);
  console.log('wrote', out, fin.getSize());
  app.quit();
});
