# Build environment for producing portable Linux release bundles.
#
# Ubuntu 22.04 is the oldest Ubuntu LTS with `libwebkit2gtk-4.1-dev` available (a hard
# requirement for Tauri v2), and it ships glibc 2.35. Building here — instead of directly on
# a bleeding-edge rolling-release host — keeps every bundled shared library (and the app
# binary itself) linked against old-enough glibc symbols to run on essentially any currently
# supported desktop Linux distribution, including Fedora and Linux Mint. See
# `Build Instructions/Linux AppImage build.md` for the portability bug this fixes.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    software-properties-common \
    && add-apt-repository -y universe \
    && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    file \
    git \
    build-essential \
    libwebkit2gtk-4.1-dev \
    libssl-dev \
    libxdo-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libenchant-2-2 \
    hunspell-en-us \
    && rm -rf /var/lib/apt/lists/*

# Node.js (22.04's apt package is far too old for this project's Vite tooling).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Rust, via rustup (stable channel — matches this project's floating-stable local setup;
# `rust-version` in Cargo.toml is only the MSRV floor, not a pin).
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable

# Pre-seed tauri-bundler's plugin cache with a patched copy of linuxdeploy-plugin-gtk (see
# linuxdeploy-plugin-gtk.sh in this directory for what's patched and why) so the build below
# picks it up instead of downloading the stock upstream version. tauri-bundler only downloads a
# plugin into `~/.cache/tauri/<name>` if it isn't already there, so placing it here ahead of time
# is enough - no other flag or config is needed.
COPY --chmod=755 linuxdeploy-plugin-gtk.sh /root/.cache/tauri/linuxdeploy-plugin-gtk.sh

WORKDIR /workspace/app
