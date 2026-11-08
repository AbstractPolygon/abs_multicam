'use strict';
// Update checks. Windows installs and Linux AppImages download the new version in the background (electron-updater,
// reading the GitHub release) and offer "Update vX" in the window; nothing restarts by itself. macOS builds are not
// signed, which macOS requires for self-updating, and .deb installs cannot replace themselves, so there the app only
// tells the user a new version exists and opens the release page. Windows .msi installs download the new .msi from
// the release, check its SHA-256 against the hash GitHub publishes for the file, and run it as an in-place upgrade.
const { app, shell, net } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');

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
  // Windows: the Setup.exe (NSIS) install has an uninstaller next to the program and updates through electron-updater.
  // A copy without one is either the portable exe (notify only) or an .msi install, which upgrades through its own .msi.
  const win = process.platform === 'win32';
  const nsisInstall = win && fs.existsSync(path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`));
  const portable = win && !!process.env.PORTABLE_EXECUTABLE_FILE;
  const msiInstall = win && !nsisInstall && !portable && (app.isPackaged || process.env.MULTICAM_FORCE_MSI === '1');
  const selfUpdate = !!feed || nsisInstall || (process.platform === 'linux' && !!process.env.APPIMAGE);
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

  const trusted = process.env.MULTICAM_RELEASE_API ? 'http://127.0.0.1' : PAGE_PREFIX;   // tests talk to a local server
  const apiBase = process.env.MULTICAM_RELEASE_API ||`https://api.github.com/repos/${REPO.owner}/${REPO.repo}`;   // tests: a local server
  async function latestRelease() {
    const res = await net.fetch(`${apiBase}/releases/latest`, { headers: { 'User-Agent': 'ABS_MultiCam' } });
    if (!res.ok) return null;
    const rel = await res.json();
    return rel && rel.tag_name && newer(rel.tag_name, app.getVersion()) && String(rel.html_url).startsWith(trusted) ? rel : null;
  }

  async function checkNotifyOnly() {                                          // macOS, .deb, portable: look up the latest release
    const rel = await latestRelease();
    if (!rel) return;
    ready = { version: String(rel.tag_name).replace(/^v/, ''), mode: 'open', url: rel.html_url };
    send(ready);
  }

  // .msi install: download the matching .msi (verified against the SHA-256 GitHub lists for the asset), keep it in the
  // temp folder, and offer "Update". A failed download or hash mismatch falls back to the "open download page" notice.
  async function checkMsi() {
    const rel = await latestRelease();
    if (!rel) return;
    const version = String(rel.tag_name).replace(/^v/, '');
    const asset = (rel.assets || []).find((a) => /-win-x64\.msi$/.test(a.name) && String(a.browser_download_url).startsWith(trusted));
    const want = asset && /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
    if (!asset || !want) { ready = { version, mode: 'open', url: rel.html_url }; send(ready); return; }
    const file = path.join(os.tmpdir(), asset.name);
    try {
      log(`update ${version} found, downloading`);
      const res = await net.fetch(asset.browser_download_url, { headers: { 'User-Agent': 'ABS_MultiCam' } });
      if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
      const hash = crypto.createHash('sha256');
      const src = Readable.fromWeb(res.body);
      src.on('data', (c) => hash.update(c));
      await pipeline(src, fs.createWriteStream(file));
      if (hash.digest('hex') !== want[1].toLowerCase()) { try { fs.unlinkSync(file); } catch (_) { /* gone */ } throw new Error('checksum does not match'); }
      ready = { version, mode: 'install', msi: file };
      log(`update ${version} ready`);
      send(ready);
    } catch (e) {
      log(`update download failed: ${String(e && e.message || e).slice(0, 100)}`);
      ready = { version, mode: 'open', url: rel.html_url };
      send(ready);
    }
  }

  function installMsi(file) {                          // upgrade in place (same product), then start the app again
    const q = (p) => `"${p}"`;
    const cmd = `ping -n 8 127.0.0.1 >nul && msiexec /i ${q(file)} /passive /norestart && start "" ${q(process.execPath)}`;
    if (process.env.MULTICAM_MSI_DRYRUN) { fs.writeFileSync(process.env.MULTICAM_MSI_DRYRUN, cmd); return; }      // tests: record, don't run
    spawn('cmd.exe',['/d', '/s', '/c', `${cmd}`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
    app.quit();
  }

  async function check() {
    if (!enabled() || ready) return;
    try {
      if (selfUpdate) await setup().checkForUpdates();
      else if (msiInstall) await checkMsi();
      else await checkNotifyOnly();
    } catch (e) { log(`update check failed: ${String(e && e.message || e).split('\n')[0].slice(0, 120)}`); }
  }

  return {
    start(firstDelayMs) {
      if (!app.isPackaged && !feed && process.env.MULTICAM_FORCE_MSI !== '1') return;                                   // plain "npm start" never checks
      setTimeout(check, firstDelayMs);
      timer = setInterval(check, CHECK_EVERY_MS);
    },
    stop() { clearInterval(timer); },
    current: () => ready,
    install() {
      if (ready && ready.mode === 'install' && ready.msi) installMsi(ready.msi);
      else if (ready && ready.mode === 'install' && updater) updater.quitAndInstall(false, true);
      else if (ready && ready.url && ready.url.startsWith(PAGE_PREFIX)) shell.openExternal(ready.url);
    }
  };
}

module.exports = { create, newer };
