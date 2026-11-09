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
  const forceMsi = process.env.MULTICAM_FORCE_MSI === '1';                  // tests: behave like an installed .msi
  const apiBase = process.env.MULTICAM_RELEASE_API || `https://api.github.com/repos/${REPO.owner}/${REPO.repo}`;   // tests: a local server
  const trustedPrefix = process.env.MULTICAM_RELEASE_API ? 'http://127.0.0.1:' : PAGE_PREFIX;
  const isTrusted = (url) => String(url).startsWith(trustedPrefix);        // the only places a release page or download may come from
  let updater = null, ready = null, timer = null, kind = null;

  // How this copy updates, worked out once on the first check. 'self' = electron-updater (Setup.exe, AppImage);
  // 'msi' = downloads the new .msi itself; 'notify' = only tells the user (macOS, .deb, portable exe).
  // On Windows the Setup.exe install has an uninstaller next to the program; a copy without one that is not the
  // portable exe came from the .msi.
  function installKind() {
    if (kind) return kind;
    if (feed) return (kind = 'self');
    if (process.platform === 'linux') return (kind = process.env.APPIMAGE ? 'self' : 'notify');
    if (process.platform !== 'win32') return (kind = 'notify');
    if (fs.existsSync(path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`))) return (kind = 'self');
    if (process.env.PORTABLE_EXECUTABLE_FILE) return (kind = 'notify');
    return (kind = app.isPackaged || forceMsi ? 'msi' : 'notify');
  }

  const setReady = (r) => { ready = r; send(r); };
  const offerPage = (rel, version) => setReady({ version, mode: 'open', url: rel.html_url });

  function setup() {
    if (updater) return updater;
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;                                      // also installs when the user quits normally
    updater.logger = null;
    if (feed) { updater.setFeedURL({ provider: 'generic', url: feed }); updater.forceDevUpdateConfig = true; }
    updater.on('update-available', (i) => log(`update ${i.version} found, downloading`));
    updater.on('update-downloaded', (i) => { log(`update ${i.version} ready`); setReady({ version: i.version, mode: 'install' }); });
    updater.on('error', (e) => log(`update check failed: ${String(e && e.message || e).split('\n')[0].slice(0, 120)}`));
    return updater;
  }

  async function latestRelease() {                                            // the newest release if it is newer than this app
    const res = await net.fetch(`${apiBase}/releases/latest`, { headers: { 'User-Agent': 'ABS_MultiCam' } });
    if (!res.ok) return null;
    const rel = await res.json();
    if (!(rel && rel.tag_name && newer(rel.tag_name, app.getVersion()) && isTrusted(rel.html_url))) return null;
    return { rel, version: String(rel.tag_name).replace(/^v/, '') };
  }

  async function checkNotifyOnly() {                                          // macOS, .deb, portable: look up the latest release
    const latest = await latestRelease();
    if (latest) offerPage(latest.rel, latest.version);
  }

  const sha256File = (file) => new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });

  // .msi install: download the matching .msi (verified against the SHA-256 GitHub lists for the asset), keep it in the
  // temp folder, and offer "Update". A failed download or hash mismatch falls back to the "open download page" notice.
  async function checkMsi() {
    const latest = await latestRelease();
    if (!latest) return;
    const { rel, version } = latest;
    const asset = (rel.assets || []).find((a) => /-win-x64\.msi$/.test(a.name) && isTrusted(a.browser_download_url));
    const m = asset && /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
    if (!asset || !m) return offerPage(rel, version);
    const want = m[1].toLowerCase(), file = path.join(os.tmpdir(), asset.name), part = `${file}.part`;
    try {
      let have = null;
      try { have = await sha256File(file); } catch (_) { /* not downloaded yet */ }     // already fetched on an earlier launch
      if (have !== want) {
        log(`update ${version} found, downloading`);
        const res = await net.fetch(asset.browser_download_url, { headers: { 'User-Agent': 'ABS_MultiCam' } });
        if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
        if (await sha256File(part) !== want) { fs.unlinkSync(part); throw new Error('checksum does not match'); }
        fs.renameSync(part, file);                                             // a file at the final name is always complete
      }
      log(`update ${version} ready`);
      setReady({ version, mode: 'install', msi: file });
    } catch (e) {
      try { fs.unlinkSync(part); } catch (_) { /* none */ }
      log(`update download failed: ${String(e && e.message || e).slice(0, 100)}`);
      offerPage(rel, version);
    }
  }

  // Upgrade in place (same product), then start the app again. It waits for this process to exit first, so the
  // installer never replaces files of a running app (closing may take a few seconds while recordings are finished).
  function installMsi(file) {
    const cmd = `powershell -NoProfile -Command "Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue" & msiexec /i "${file}" /passive /norestart && start "" "${process.execPath}"`;
    if (process.env.MULTICAM_MSI_DRYRUN) { fs.writeFileSync(process.env.MULTICAM_MSI_DRYRUN, cmd); return; }      // tests: record, don't run
    spawn('cmd.exe', ['/d', '/s', '/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
    app.quit();
  }

  async function check() {
    if (!enabled() || ready) return;
    try {
      const k = installKind();
      if (k === 'self') await setup().checkForUpdates();
      else if (k === 'msi') await checkMsi();
      else await checkNotifyOnly();
    } catch (e) { log(`update check failed: ${String(e && e.message || e).split('\n')[0].slice(0, 120)}`); }
  }

  return {
    start(firstDelayMs) {
      if (!app.isPackaged && !feed && !forceMsi) return;                      // plain "npm start" never checks
      setTimeout(check, firstDelayMs);
      timer = setInterval(check, CHECK_EVERY_MS);
    },
    stop() { clearInterval(timer); },
    current: () => ready,
    install() {
      if (!ready) return;
      if (ready.mode === 'install') { if (ready.msi) installMsi(ready.msi); else if (updater) updater.quitAndInstall(false, true); }
      else if (ready.url && isTrusted(ready.url)) shell.openExternal(ready.url);
    }
  };
}

module.exports = { create, newer };
