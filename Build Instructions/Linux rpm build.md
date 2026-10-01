# Linux .rpm Build

Produces an RPM package installable via `rpm -i` / `dnf install ./file.rpm` on
Fedora/RHEL-based distributions.

## Building for distribution (recommended): use Docker, not this machine directly

**Bundles you intend to hand to someone else (i.e. anything copied into `Releases/`)
should be built via `Build Instructions/docker/build.sh`, not by running the steps
below directly on this Omarchy/Arch dev machine.**

Fedora itself always ships a recent glibc, so this format is less exposed to the
portability bug documented in `Build Instructions/Linux AppImage build.md`. But the
`.rpm` still ships the compiled `Sectionist` binary linked against whatever glibc is on
the build machine, and this machine (Omarchy, a bleeding-edge rolling-release Arch
derivative) runs a genuinely unusual, very new glibc — building via
`Build Instructions/docker/build.sh` (an Ubuntu 22.04 container) keeps the binary's own
glibc requirement at a conservative, well-supported baseline rather than depending on
whatever this specific rolling-release machine happens to have installed today.

The steps below (running `npx tauri build` directly) are still useful for local
iteration/testing on this machine — just don't ship what they produce.

## 1. One-time prerequisites

Install Node.js (18+), Rust (via [rustup](https://rustup.rs)), and the system libraries
Tauri v2 needs to build a Linux app. On Fedora/RHEL-based distros:

```bash
sudo dnf install -y webkit2gtk4.1-devel openssl-devel curl wget file \
  libxdo-devel libappindicator-gtk3-devel librsvg2-devel gcc gcc-c++ make
```

(Full/authoritative list: <https://v2.tauri.app/start/prerequisites/> — check this
page for the current package names for your distro, since `rpm` is normally built on
a Fedora/RHEL-family machine rather than Debian-family ones like Linux Mint.)

An `.rpm` can also be built for local testing on an Arch-based machine (e.g. this
Omarchy dev machine) even though it's not the target distro, via the roughly
equivalent packages:

```bash
sudo pacman -S --needed webkit2gtk-4.1 openssl base-devel libappindicator librsvg
```

From the `app/` directory, install JS dependencies once:

```bash
cd "app"
npm install
```

## 2. Build

From the `app/` directory:

```bash
npx tauri build --bundles rpm
```

## 3. Where the output goes

```
app/src-tauri/target/release/bundle/rpm/Sectionist-<version>-1.x86_64.rpm
```

## 4. Copy it to the consolidated Releases folder

From the repo root:

```bash
mkdir -p "Releases"
cp app/src-tauri/target/release/bundle/rpm/Sectionist-*.x86_64.rpm "Releases/"
```

This overwrites any previously copied `.rpm` with the same filename (i.e. the same
version). If you bump the app version, the old file will remain in `Releases/` under
its old name unless you delete it manually.

`Releases/` is tracked in git (not gitignored) — after copying, `git add`/commit the
updated file(s) so the repo's copy stays current.

## 5. Verify

```bash
sudo rpm -i "Releases/Sectionist-"*".x86_64.rpm"
```

Then launch "Sectionist" from your application menu, or run `/usr/bin/app` directly
from a terminal.

To uninstall after testing:

```bash
sudo rpm -e sectionist
```
