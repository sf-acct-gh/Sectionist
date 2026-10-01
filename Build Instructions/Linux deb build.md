# Linux .deb Build

Produces a Debian package (`.deb`) installable via `dpkg -i` / `apt install ./file.deb`
on Debian- and Ubuntu-based distributions, including **Linux Mint**.

## Building for distribution (recommended): use Docker, not this machine directly

**Bundles you intend to hand to someone else (i.e. anything copied into `Releases/`)
should be built via `Build Instructions/docker/build.sh`, not by running the steps
below directly on this Omarchy/Arch dev machine.**

Unlike the AppImage, a `.deb` doesn't bundle WebKitGTK/GLib — it declares them as
package dependencies resolved by the target system's own `apt`. But it does still ship
the compiled `Sectionist` binary itself, linked against whatever glibc is on the build
machine. This machine (Omarchy, a bleeding-edge rolling-release Arch derivative) runs a
much newer glibc than Debian/Ubuntu-based systems typically have, so a `.deb` built
directly here could still fail to *run* (even if it installs fine) on an older base.
`Build Instructions/docker/build.sh` builds inside an Ubuntu 22.04 container instead,
so the binary only requires glibc symbols available on that widely-supported baseline.
See `Build Instructions/Linux AppImage build.md` for the full story (that's where this
was actually discovered, via a real Fedora/Mint failure report on 2026-09-13).

The steps below (running `npx tauri build` directly) are still useful for local
iteration/testing on this machine — just don't ship what they produce.

## 1. One-time prerequisites

Install Node.js (18+), Rust (via [rustup](https://rustup.rs)), and the system libraries
Tauri v2 needs to build a Linux app:

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

(Full/authoritative list: <https://v2.tauri.app/start/prerequisites/>.)

A `.deb` can also be built for local testing on an Arch-based machine (e.g. this
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
npx tauri build --bundles deb
```

## 3. Where the output goes

```
app/src-tauri/target/release/bundle/deb/Sectionist_<version>_amd64.deb
```

## 4. Copy it to the consolidated Releases folder

From the repo root:

```bash
mkdir -p "Releases"
cp app/src-tauri/target/release/bundle/deb/Sectionist_*_amd64.deb "Releases/"
```

This overwrites any previously copied `.deb` with the same filename (i.e. the same
version). If you bump the app version, the old file will remain in `Releases/` under
its old name unless you delete it manually.

`Releases/` is tracked in git (not gitignored) — after copying, `git add`/commit the
updated file(s) so the repo's copy stays current.

## 5. Verify

```bash
sudo apt install "./Releases/Sectionist_"*"_amd64.deb"
```

Then launch "Sectionist" from your application menu, or run `/usr/bin/app` directly
from a terminal.

To uninstall after testing:

```bash
sudo apt remove sectionist
```
