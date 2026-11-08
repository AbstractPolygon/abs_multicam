#!/usr/bin/env bash
# Builds the Raspberry Pi packages (64-bit ARM Linux): a .deb and an .AppImage, into dist/.
# Run it on any Linux machine (x64 or arm64) or in WSL, with Node 20+ installed:   bash scripts/build-pi.sh
# (On GitHub the same files are built by the "Linux-arm64" job of the Release workflow.)
exec bash "$(dirname "$0")/build-linux.sh" arm64
