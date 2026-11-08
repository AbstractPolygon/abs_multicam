# ABS_MultiCam

Electron app that shows live previews of **any number of USB webcams** at once and loop-records each one to disk. Runs on Windows, macOS and Linux.

## Run

```bash
npm install
npm start
```

Press **Start recording**. Each camera records to `<output folder>/camN/` as short `.webm` segments. The default output folder is `Videos/ABS_MultiCam`; change it in **Settings**.

For development, `npm run dev` instead refreshes the open window whenever you edit a file in `renderer/` (recording carries on), and restarts the single app instance when you edit `main.js` or `preload.js`. Launching the app a second time just focuses the existing window.

## Features

- Detects every camera automatically (no fixed count). Plug a camera in or out and its tile appears or goes away; the app keeps running.
- **Loop recording**: rolling segments (default 5 min). Oldest files are deleted when a camera passes its size cap (default 10 GB) or age limit, or when the drive is nearly full. Files being written are never deleted.
- Per-camera name, **resolution**, **frame rate** and a **record** checkbox. Resolution and frame rate default to the global Settings values. Unticking a camera also releases its USB bandwidth. Each tile shows the resolution and frame rate the camera actually delivers.
- **Slots and ordering**: drag any card (anywhere except its controls) onto another to put it in that position, or onto empty space to move it to the end. Or pick a **Slot** number from the dropdown on a card; the camera that was there swaps places with it. The order is remembered per camera.
- **Click a card to highlight it.** Click empty space to clear.
- **Full screen** button on each camera (or double-click its picture, or press `F` with a card selected). Esc leaves full screen.
- Cameras that drop out are retried automatically (5 s, 10 s ... up to 60 s) and recording resumes.
- **Record on movement** (Settings): cameras only record while they see movement. Each camera decides for itself, so only the camera that sees movement records. Recording starts after movement is seen in two checks in a row (about half a second, so the first moments are not recorded) and stops after 8 quiet seconds. The slider picks how much movement counts: Subtle, Normal or High. Whole-picture brightness changes (light flicker, auto-exposure) are ignored. Detection uses [pixelmatch](https://github.com/mapbox/pixelmatch) (ISC, vendored in `renderer/vendor/`).
- **Video encoder** (Settings): GPU or CPU. GPU uses the fastest GPU's hardware H.264 encoder (the default) and needs H.264 as the codec; with VP8/VP9 or the CPU choice, encoding runs on the CPU. Changing it restarts the app.
- **Motion zones**: in a tile's settings (sliders button) press **Edit zones**, drag on the picture to add a zone and click a zone to remove it. "Movement inside zones" watches only those areas; "Movement outside zones" ignores them (a TV, a tree). Zones are saved per camera.
- **Snapshots**: the camera button on a tile (or **S**) saves a full-resolution PNG to `<output folder>/snapshots`.
- **Keyboard shortcuts**: **R** record/stop, **P** preview, **S** snapshot (selected camera, otherwise all), **F** full screen for the selected camera, **O** open the recordings folder, **Esc** closes Settings. Ignored while typing in a field.
- **Low disk space**: the footer turns amber below twice the "Keep drive free" amount and red below it.
- **Per-camera settings**: the sliders button on a tile sets that camera's movement sensitivity, stop-after time and bitrate (the bitrate applies from its next file).
- **Burn camera name and time into the video** (Settings): the recorded picture shows the camera name and the PC clock. Costs extra CPU.
- **Minimize to system tray** (Settings): minimizing hides the window; recording continues. Click the tray icon to bring it back.
- Remembers its window size and position. Each tile shows measured frames per second and dropped frames while the preview is on.
- **Updates**: Windows installs and Linux AppImages download updates in the background and show an "Update vX" button; nothing restarts until you click it. On macOS and for `.deb` installs the button opens the release page instead.
- **Preview off** switch: stops decoding/drawing previews to save CPU while recording continues.
- Closing the window finalizes all open recordings first.
- Icon toolbar (record / stop, preview on/off, open folder, settings) with tooltips. No File/Edit/View menu bar on Windows and Linux.
- **Timecode** for syncing cameras in a video editor (see below).

## Timecode and syncing in an editor

Every segment `camN_YYYYMMDD_HHMMSS.webm` gets a sidecar `camN_YYYYMMDD_HHMMSS.json` with its exact start time (local and UTC, to the millisecond) and a **time-of-day timecode** (`HH:MM:SS:FF`, non-drop, at the camera's frame rate). All cameras are stamped from the same PC clock, so their timecodes line up.

A browser recorder can't write a timecode track, so to get one embedded in the video run the export step (needs ffmpeg on your PATH, or pass `--ffmpeg <path>`):

```bash
node scripts/export-timecode.js "D:\Videos\ABS_MultiCam"
```

It writes `timecode_export/camN/*.mov` (H.264, constant frame rate, timecode track included) plus `sync.csv`. In DaVinci Resolve or Premiere, import the `.mov` files and use *synchronize by timecode* (multicam). Exporting re-encodes the video, which is why it's a separate step.

Accuracy: the start time is when the recorder was started. The first frame arrives a little later (camera and encoder delay), so sync is close but **not frame-accurate**; for tight sync, also clap or flash a light at the start of a take. If your editing project uses 29.97 fps, the 30 fps timecode here can drift slightly against it.

## Identical cameras

Cameras of the same model have the same name, so each one is identified by the device ID the browser engine assigns. Names you give them are stored against that ID. If you move a camera to a different USB port it may be treated as a new camera (new `camN` folder and default name).

## Releases

Pushing a version tag builds installers for Windows, macOS and Linux on GitHub and publishes them as a release:

```bash
git tag v0.1.0   # must match "version" in package.json
git push origin v0.1.0
```

Files: Windows setup and portable `.exe`, macOS `.dmg`/`.zip` (Intel and Apple silicon), Linux `.AppImage` and `.deb`. You can also run the **Release** workflow by hand from the Actions tab; it keeps the files as downloads without publishing. Builds are not signed: Windows may show SmartScreen, and on macOS you need to right-click > Open, or run `xattr -cr /Applications/ABS_MultiCam.app` once.

Signing is optional: add the secrets listed at the top of `.github/workflows/release.yml` (Windows `.pfx`; macOS Developer ID `.p12` plus Apple ID details for notarization) and the next release is signed.

## Raspberry Pi

Releases include a 64-bit ARM Linux build (`ABS_MultiCam-<version>-linux-arm64.deb` and `.AppImage`) for the Raspberry Pi 3, 4, 5 and Zero 2 W running **64-bit Raspberry Pi OS** (`uname -m` must print `aarch64`).

```bash
sudo apt install ./ABS_MultiCam-0.1.0-linux-arm64.deb      # then start "ABS_MultiCam" from the menu, or run: abs-multicam
```

Or without installing: `chmod +x ABS_MultiCam-0.1.0-linux-arm64.AppImage && ./ABS_MultiCam-0.1.0-linux-arm64.AppImage`.

On a Pi the first run starts with lighter settings: 640x480 at 15 fps, 1 Mbps, smaller tiles and software encoding (your own saved settings are never changed). Raise them in Settings if your Pi keeps up.

Video encoding on a Pi:
- **Pi 4, Pi 3, Zero 2 W** have a hardware H.264 encoder. Chromium cannot use it, so the app sends the camera frames to ffmpeg's `h264_v4l2m2m` encoder instead. This is the default on these boards on first run, shows up in Settings as "Raspberry Pi hardware (H.264)", and writes fragmented `.mp4` files (still readable after a crash, with the timecode embedded). If ffmpeg or the hardware encoder fails, that camera quietly switches to software encoding and the log says so.
- **Pi 5** has no hardware H.264 encoder, so that option does not appear and encoding runs on its CPU, which is fast enough for a few cameras at 640x480.
- Hardware encoding works only through ffmpeg: it needs each camera's frames passed to the main process, which costs some CPU too, so on a Pi 4 expect roughly one to three cameras at 640x480 to 720p.

Tips:
- Use fewer cameras and low frame rates, 640x480 or 1280x720 at 15 fps, and a lower bitrate (Settings, or per camera).
- Pi USB ports share limited power and bandwidth. Use a powered USB hub for more than one camera.
- Your user needs access to the cameras: `sudo usermod -aG video $USER`, then log out and in.
- If the window stays black or the app closes at start-up, run it from a terminal with `abs-multicam --disable-gpu` and tell me what it prints.
- To build the Pi packages yourself on a Linux machine or in WSL: `bash scripts/build-pi.sh`.

## Build installers

Installers must be built on the matching OS (or in CI):

```bash
npm run dist:win     # Windows: NSIS installer + portable exe
npm run dist:mac     # macOS: dmg + zip (run on a Mac)
npm run dist:linux   # Linux: AppImage + deb
```

Output goes to `dist/`. No app icon is set yet, so the default Electron icon is used. macOS builds are unsigned until you add a signing identity.

## License

ABS_MultiCam is source-available under the [PolyForm Shield License 1.0.0](LICENSE): you can use, modify and share it, but not to build a product that competes with it. It is not an open-source license.

Third-party code: [pixelmatch](https://github.com/mapbox/pixelmatch) (ISC, in `renderer/vendor/`), Electron (MIT) and electron-updater (MIT). Release builds also bundle an [ffmpeg](https://ffmpeg.org) binary from the `ffmpeg-static` package, which is licensed GPL-3.0-or-later and stays under that licence; its source is available from ffmpeg.org.

## Self-tests

```bash
node scripts/test-motion.js        # movement detector on synthetic frames
node scripts/test-motion-app.js 1  # app end to end with prepared clips (level 0, 1 or 2)
node scripts/test-encoder.js 10    # encoder choices (add --real for attached cameras)
node scripts/test-zones-app.js     # motion zones drawn with pointer events, end to end
node scripts/test-shortcuts.js     # keyboard shortcuts and snapshots
node scripts/test-disk.js          # low-disk-space warning
node scripts/test-pi.js            # Raspberry Pi first-run defaults (simulated)
node scripts/test-hw.js            # hardware-encoder recording path (software stand-in), fallbacks
node scripts/verify-encoder.js     # Windows: measures which GPU's encoder is really busy (needs real cameras)
```

## Self-test (no cameras needed)

```bash
npm run smoke              # 4 fake cameras, 12 s
node scripts/smoke.js 9 14 # 9 fake cameras, 14 s
```

Uses Chromium's built-in fake webcams and short segments, then checks every camera wrote data. `node scripts/smoke.js 3 14 ui` also drives the interface (click-highlight, slot dropdown, drag and drop, fullscreen) and checks that the order is saved.

## Notes and limits

- **Recording format**: `.webm` (H.264 by default), made by the browser's MediaRecorder. Because it is written as a live stream a `.webm` has no duration or seek index. Turn on **Save recordings as MP4** in Settings to fix that: each finished file is rewritten as `.mp4` with a duration, seeking and a timecode track (H.264 is copied, not re-encoded; VP8/VP9 are converted to H.264). Files left over from an earlier session are converted after the next start. Each file is capped at 4 GB; recording continues in a new file.
- **CPU**: every camera is re-encoded in software. Many 720p cameras can load the CPU heavily; lower the bitrate, resolution or frame rate, or turn the preview off.
- **USB bandwidth**: a USB 2.0 controller has limited bandwidth shared by all its cameras. If a camera shows a black picture or fails to open, spread cameras across different USB ports/controllers or use a powered hub.
- **Audio** is not recorded.
- **macOS**: allow camera access when prompted (System Settings > Privacy & Security > Camera).
- **Linux**: your user needs access to `/dev/video*` (usually the `video` group).
- Settings live in the app's user-data folder (`settings.json`).
