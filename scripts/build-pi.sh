#!/usr/bin/env bash
# Builds the Raspberry Pi packages (64-bit ARM Linux): a .deb and an .AppImage, into dist/.
# Run it on any Linux machine (x64 or arm64) or in WSL, with Node 20+ installed:   bash scripts/build-pi.sh
# (On GitHub the same files are built by the "Linux-arm64" job of the Release workflow.)
set -euo pipefail
cd "$(dirname "$0")/.."

npm ci

# The bundled ffmpeg must be the 64-bit ARM Linux build, whatever machine this runs on.
( cd node_modules/ffmpeg-static && rm -f ffmpeg ffmpeg.exe ffmpeg.exe.* && npm_config_platform=linux npm_config_arch=arm64 node install.js )

npx electron-builder --linux AppImage deb --arm64 --publish never

echo
ls -lh dist/*.deb dist/*.AppImage
