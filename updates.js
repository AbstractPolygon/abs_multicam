'use strict';
// Update checks. Windows installs and Linux AppImages download the new version in the background (electron-updater,
// reading the GitHub release) and offer "Update vX" in the window; nothing restarts by itself. macOS builds are not
// signed, which macOS requires for self-updating, and .deb installs cannot replace themselves, so there the app only
// tells the user a new version exists and opens the release page.
const { app, shell, net } = require('electron');

const REPO = { owner: 'AbstractPolygon', repo: 'abs_multicam' };
const PAGE_PREFIX = `https://github.com/${REPO.owner}/${REPO.repo}/`;
const CHECK_EVERY_MS = 6 * 3600e3;

function newer(a, b) {                               // is version a newer than b?   "v1.2.3" or "1.2.3"
  const p = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}

function create({ log, send, enabled }) {
  const feed = process.env.MULTICAM_UPDATE_URL || '';                       // tests: a local folder served over http
  const selfUpdate = !!feed || process.platform === 'win32' || (process.platform === 'linux' && !!process.env.APPIMAGE);
  let updater = null, ready = null, timer = null;

  function setup() {
    if (updater) return updater;
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;                                      // also installs when the user quits normally
    updater.logger = null;
    if (feed) { updater.setFeedURL({ provider: 'generic', url: feed }); updater.forceDevUpdateConfig = true; }
    updater.on('update-available', (i) => log(`update ${i.version} found, downloading`));
    updater.on('update-downloaded', (i) => { ready = { version: i.version, mode: 'install' }; log(`update ${i.version} ready`); send(ready); });
    updater.on('error', (e) => log(`update check failed: ${String(e && e.message || e).split('\n')[0].slice(0, 120)}`));
    return updater;
  }

  async function checkNotifyOnly() {                                          // macOS, .deb: look up the latest release
    const res = await net.fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases/latest`, { headers: { 'User-Agent': 'ABS_MultiCam' } });
    if (!res.ok) return;
    const rel = await res.json();
    if (rel && rel.tag_name && newer(rel.tag_name, app.getVersion()) && String(rel.html_url).startsWith(PAGE_PREFIX)) {
      ready = { version: String(rel.tag_name).replace(/^v/, ''), mode: 'open', url: rel.html_url };
      send(ready);
    }
  }

  async function check() {
    if (!enabled() || ready) return;
    try {
      if (selfUpdate) await setup().checkForUpdates();
      else await checkNotifyOnly();
    } catch (e) { log(`update check failed: ${String(e && e.message || e).split('\n')[0].slice(0, 120)}`); }
  }

  return {
    start(firstDelayMs) {
      if (!app.isPackaged && !feed) return;                                   // plain "npm start" never checks
      setTimeout(check, firstDelayMs);
      timer = setInterval(check, CHECK_EVERY_MS);
    },
    stop() { clearInterval(timer); },
    current: () => ready,
    install() {
      if (ready && ready.mode === 'install' && updater) updater.quitAndInstall(false, true);
      else if (ready && ready.url && ready.url.startsWith(PAGE_PREFIX)) shell.openExternal(ready.url);
    }
  };
}

module.exports = { create, newer };
