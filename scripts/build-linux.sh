#!/usr/bin/env bash
# Builds the Linux packages (.deb and .AppImage) into dist/.
#   bash scripts/build-linux.sh x64      for PCs
#   bash scripts/build-linux.sh arm64    for Raspberry Pi (64-bit Raspberry Pi OS)
# Run it on any Linux machine (x64 or arm64) or in WSL, with Node 20+ installed.
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH="${1:-x64}"
case "$ARCH" in x64|arm64) ;; *) echo "usage: build-linux.sh x64|arm64" >&2; exit 2;; esac

npm ci

# The bundled ffmpeg must match the chip the package is for, whatever machine this runs on.
( cd node_modules/ffmpeg-static && rm -f ffmpeg ffmpeg.exe ffmpeg.exe.* && npm_config_platform=linux npm_config_arch="$ARCH" node install.js )

npx electron-builder --linux AppImage deb "--$ARCH" --publish never

echo
ls -lh dist/*.deb dist/*.AppImage
