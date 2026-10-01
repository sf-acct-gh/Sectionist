#!/usr/bin/env bash
# Builds portable Linux release bundles (.AppImage, .deb, .rpm) inside a Docker container
# based on Ubuntu 22.04, instead of directly on the host machine. See the Dockerfile in this
# directory and `Build Instructions/Linux AppImage build.md` for why this matters: bundles
# built directly on a bleeding-edge host (e.g. this project's Omarchy/Arch dev machine) embed
# shared libraries that require newer glibc symbols than most target systems (Fedora, Linux
# Mint, etc.) actually have, causing the app to fail to launch there.
#
# Usage: Build Instructions/docker/build.sh
# Output: app/src-tauri/target/release/bundle/{appimage,deb,rpm}/ (same as a native build)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_TAG="sectionist-linux-builder"

docker build -t "$IMAGE_TAG" "$SCRIPT_DIR"

docker run --rm \
  -v "$REPO_ROOT:/workspace" \
  -v "sectionist-cargo-registry:/usr/local/cargo/registry" \
  -v "sectionist-node-modules:/workspace/app/node_modules" \
  -w /workspace/app \
  "$IMAGE_TAG" \
  bash -c "npm install && npx tauri build --bundles deb,rpm,appimage"

echo
echo "Bundles written to: app/src-tauri/target/release/bundle/{appimage,deb,rpm}/"
