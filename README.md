# ABS_MultiCam

Electron app that shows live previews of **any number of USB webcams** at once and loop-records each one to disk. Runs on Windows, macOS and Linux from the same code.

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

## Build installers

Installers must be built on the matching OS (or in CI):

```bash
npm run dist:win     # Windows: NSIS installer + portable exe
npm run dist:mac     # macOS: dmg + zip (run on a Mac)
npm run dist:linux   # Linux: AppImage + deb
```

Output goes to `dist/`. No app icon is set yet, so the default Electron icon is used. macOS builds are unsigned until you add a signing identity.

## Self-tests

```bash
node scripts/test-motion.js        # movement detector on synthetic frames
node scripts/test-motion-app.js 1  # app end to end with prepared clips (level 0, 1 or 2)
node scripts/test-encoder.js 10    # encoder choices (add --real for attached cameras)
node scripts/verify-encoder.js     # Windows: measures which GPU's encoder is really busy (needs real cameras)
```

## Self-test (no cameras needed)

```bash
npm run smoke              # 4 fake cameras, 12 s
node scripts/smoke.js 9 14 # 9 fake cameras, 14 s
```

Uses Chromium's built-in fake webcams and short segments, then checks every camera wrote data. `node scripts/smoke.js 3 14 ui` also drives the interface (click-highlight, slot dropdown, drag and drop, fullscreen) and checks that the order is saved.

## Notes and limits

- **Recording format**: `.webm` (VP8 by default), made by the browser's MediaRecorder. Files play in VLC, browsers and ffmpeg. Because they are written as a live stream they have no duration or seek index; to fix that: `ffmpeg -i in.webm -c copy out.webm`.
- **CPU**: every camera is re-encoded in software. Many 720p cameras can load the CPU heavily; lower the bitrate, resolution or frame rate, or turn the preview off.
- **USB bandwidth**: a USB 2.0 controller has limited bandwidth shared by all its cameras. If a camera shows a black picture or fails to open, spread cameras across different USB ports/controllers or use a powered hub.
- **Audio** is not recorded.
- **macOS**: allow camera access when prompted (System Settings > Privacy & Security > Camera).
- **Linux**: your user needs access to `/dev/video*` (usually the `video` group).
- Settings live in the app's user-data folder (`settings.json`).
