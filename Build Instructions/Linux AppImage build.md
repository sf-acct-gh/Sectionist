# Linux AppImage Build

Produces a single self-contained `.AppImage` file that should run on most Linux
distributions without installing anything.

Primary target for this: **Linux Mint**. These steps also work on this Arch/Omarchy
dev machine, but see the "Omarchy/Arch-specific workarounds" section at the bottom —
those workarounds are local to this machine and are not expected to be needed on Mint.

## Building for distribution (recommended): use Docker, not this machine directly

**Bundles you intend to hand to someone else (i.e. anything copied into `Releases/`)
should be built via `Build Instructions/docker/build.sh`, not by running the steps
below directly on this Omarchy/Arch dev machine.**

Building an AppImage bakes a copy of this machine's own installed WebKitGTK/GLib/image-
codec shared libraries into the AppImage payload (that's what `linuxdeploy-plugin-gtk`
does). This machine runs Omarchy, a bleeding-edge rolling-release Arch derivative — as
of 2026-09-13 it has `glibc 2.44` and `webkit2gtk-4.1 2.52.6-1`, both far newer than
Fedora or Linux Mint ship. An AppImage built directly here therefore requires glibc
symbols (`GLIBC_2.42`–`2.44`) that don't exist yet on those systems, so it fails to
launch there at all — confirmed 2026-09-13 via real terminal output from both a Fedora
(Wayland) and a Linux Mint (X11) machine, even though the same AppImage worked fine on
two separate Omarchy machines.

The fix is to build inside a Docker container based on Ubuntu 22.04 instead — an old,
still-supported baseline (glibc 2.35) that becomes the ceiling for every bundled
library and the app binary itself, so the result runs on essentially any current
desktop Linux distribution:

```bash
Build Instructions/docker/build.sh
```

This builds (and caches) a `sectionist-linux-builder` Docker image from
`Build Instructions/docker/Dockerfile`, then runs the same `npx tauri build --bundles
deb,rpm,appimage` inside it, bind-mounting the repo so bundles land in the usual
`app/src-tauri/target/release/bundle/{appimage,deb,rpm}/` paths — see step 3 below for
copying them into `Releases/`. Workarounds 1 and 2 further down this file are not needed
inside that container (Ubuntu 22.04's own toolchain and `gdk-pixbuf` layout don't hit
those bugs).

Workaround 3 (the `GDK_BACKEND=x11` `AppRun` hook) **is** needed, though — and unlike 1
and 2, it's baked into the Docker image itself rather than being a manual local step:
the `Dockerfile` copies a pre-patched `Build Instructions/docker/linuxdeploy-plugin-gtk.sh`
into `/root/.cache/tauri/` before the build runs, so `tauri build` picks it up instead of
downloading the stock upstream plugin. See "Why every distro needs workaround 3" below —
this isn't Omarchy-specific; it broke real Fedora and Omarchy user machines when it
shipped unpatched.

The steps below (running `npx tauri build` directly) are still useful for local
iteration/testing on this machine — just don't ship what they produce.

## 1. One-time prerequisites

Install Node.js (18+), Rust (via [rustup](https://rustup.rs)), and the system libraries
Tauri v2 needs to build a Linux app. On Debian/Ubuntu-based distros (including Linux Mint):

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

(Full/authoritative list: <https://v2.tauri.app/start/prerequisites/> — check this if a
package name has changed since these instructions were written.)

On an Arch-based machine (e.g. this Omarchy dev machine), the roughly equivalent
packages are:

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
npx tauri build --bundles appimage
```

This runs the TypeScript/Vite frontend build, compiles the Rust backend in release
mode, and packages the result as an AppImage.

## 3. Where the output goes

```
app/src-tauri/target/release/bundle/appimage/Sectionist_<version>_amd64.AppImage
```

## 4. Copy it to the consolidated Releases folder

From the repo root:

```bash
mkdir -p "Releases"
cp app/src-tauri/target/release/bundle/appimage/Sectionist_*_amd64.AppImage "Releases/"
```

This overwrites any previously copied AppImage with the same filename (i.e. the same
version). If you bump the app version, the old file will remain in `Releases/` under
its old name unless you delete it manually.

`Releases/` is tracked in git (not gitignored) — after copying, `git add`/commit the
updated file(s) so the repo's copy stays current. Note the AppImage itself is close to
GitHub's 100 MB per-file push limit (~99.7 MB as of this build, up from ~95 MB a few
builds ago) — there is very little headroom left. If it crosses 100 MB, the push will be
rejected outright and the AppImage will need to stop being committed directly (e.g. via
Git LFS, or linking to a GitHub Release upload instead of an in-repo file).

## 5. Verify

```bash
chmod +x "Releases/Sectionist_"*"_amd64.AppImage"
"Releases/Sectionist_"*"_amd64.AppImage"
```

A window titled "Sectionist" should appear.

---

## Troubleshooting: AppImage does nothing when double-clicked (Linux Mint and other Ubuntu-based distros)

**Note (corrected 2026-09-13):** an earlier version of this section led with "install
libfuse2" as the almost-always cause. That advice is written for the older
AppImageKit-based runtime. Checked with `file`/`ldd`/`readelf -d` and confirmed this
build's AppImage instead uses the modern `AppImage/type2-runtime`, which is fully
statically linked (`ldd` reports "not a dynamic executable") — it does **not** need
`libfuse2` installed on the target system at all. It's left below as a harmless thing to
try, but it's no longer believed to be the likely cause here. This has not yet been
confirmed against a real Mint machine, so treat the order below as best-guess priority,
not confirmed diagnosis.

1. **Check the executable bit first.** Files downloaded via a browser or copied from
   another machine often lose it, and most file managers (including Mint's Nemo) will
   silently do nothing — no error, no dialog — on a double-clicked file that isn't
   marked executable. Right-click the file > Properties > Permissions > "Allow executing
   file as program" (or `chmod +x Sectionist_*_amd64.AppImage` from a terminal).
2. **Run it from a terminal** to see the actual error, since a double-click swallows
   stderr/stdout entirely:
   ```bash
   cd ~/Downloads   # or wherever the AppImage is
   ./Sectionist_*_amd64.AppImage
   ```
   If it's a genuine FUSE/mount failure, it will look like:
   ```
   Cannot mount AppImage, please check your FUSE setup.
   ```
   (not the older `dlopen(): error loading libfuse.so.2`, which would indicate an
   AppImageKit-style runtime instead of the static one this build actually produces).
3. **If FUSE genuinely can't mount** (rare on a normal Mint desktop install — more of a
   restricted-container/VM thing — but confirm the `fuse`/`fuse3` kernel module is
   loaded and `/dev/fuse` is accessible if you do see the error above), bypass FUSE
   entirely by extracting and running directly:
   ```bash
   ./Sectionist_*_amd64.AppImage --appimage-extract-and-run
   # or, to keep the extracted copy around instead of re-extracting every launch:
   ./Sectionist_*_amd64.AppImage --appimage-extract
   ./squashfs-root/AppRun
   ```
   This works regardless of the actual underlying cause. If this works, the extracted
   `squashfs-root/` folder can be run directly going forward in place of the `.AppImage`
   file.
4. **If FUSE2 truly is missing** (confirm via the terminal output in step 2 first — don't
   install this speculatively), the packages are:
   ```bash
   sudo apt update
   sudo apt install -y libfuse2       # Mint 21.x / Ubuntu 22.04 base
   # or, if the above package isn't found (Mint 22.x / Ubuntu 24.04 base, which
   # renamed the package):
   sudo apt install -y libfuse2t64
   ```

Linux Mint normally runs a full Xorg/Cinnamon session, so (unlike this dev machine) it
should not need the Wayland-related `GDK_BACKEND` workaround below at all.

---

## Why every distro needs workaround 3 (not just this dev machine)

Workarounds 1 and 2 below really are specific to this machine's bleeding-edge toolchain
and only matter for local (non-Docker) builds here. Workaround 3 is different: it patches
a bug that shipped in **every** Docker-built release bundle from 50a7a75 up through
a3cd024/076c510, and it broke real user machines, not just this dev box:

- **Fedora** (Wayland/GNOME): WebKitWebProcess aborted (core dump, signal 6) after only
  the native menu bar rendered — the app never painted its content area.
- **Omarchy machine A** (Hyprland, no Xwayland running): the AppImage did not open at
  all — it hung waiting for an X server that was never going to appear.
- **Omarchy machine B** (Hyprland, with Xwayland available): same WebKitWebProcess crash
  as Fedora, just reached through Xwayland instead of failing to reach a display at all.

All three are one bug: the AppImage's `AppRun` hook (generated by the `linuxdeploy-plugin-gtk`
plugin, downloaded fresh on every Docker build since `~/.cache/tauri` isn't a persisted
volume) unconditionally forces `GDK_BACKEND=x11`, so the app is *always* run through
Xwayland on a Wayland session, whether or not Xwayland is even present. Linux Mint's
Cinnamon session is X11 natively, so this hook is a no-op there and the bug was invisible
— which is exactly why it shipped unnoticed. Two earlier attempts to fix the Fedora crash
(`WEBKIT_DISABLE_DMABUF_RENDERER`, `WEBKIT_DISABLE_COMPOSITING_MODE` in `main.rs`) treated
it as a WebKitGTK GPU-negotiation problem and left those env vars in place as a safety net
(harmless on Mint's native X11 session either way), but neither addressed the actual root
cause: the app had no business running through Xwayland on these machines at all.

The fix, applied in `Build Instructions/docker/linuxdeploy-plugin-gtk.sh` and pulled into
the Docker image by the `Dockerfile` (see above), makes the hook conditional — only force
X11 when there's no `WAYLAND_DISPLAY` to use instead — exactly mirroring workaround 3
below, which was already proven to fix the "hangs indefinitely" case on this dev machine.
This is now part of the repo and the Docker pipeline, not a manual per-machine step.

**Note:** this fix only addressed the "won't open at all" hang. The Fedora/Omarchy-B
`WebKitWebProcess` crash (`EGL_BAD_PARAMETER`) turned out to be a second, unrelated bug —
see "Why the WebKitWebProcess EGL_BAD_PARAMETER crash happened" below.

## Why the WebKitWebProcess EGL_BAD_PARAMETER crash happened (not the same bug as GDK_BACKEND)

After the `GDK_BACKEND` fix above shipped, real-machine testing (2026-09-14) showed the
`WebKitWebProcess` crash was still happening on Fedora and Omarchy machine B, and — once
reproduced live on this dev machine's own sandbox (which runs under a VMware virtual GPU,
hitting the exact same crash signature under native Wayland) — turned out to be
independent of whether GDK used native Wayland or Xwayland/X11. The crash:

```
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
```

Root cause: `linuxdeploy` automatically bundles `libwayland-client.so.0`,
`libwayland-cursor.so.0`, `libwayland-egl.so.1`, and `libwayland-server.so.0` as
transitive dependencies of `libgtk-3`/`libgdk-3`/`libwebkit2gtk` — this build's copies are
Ubuntu 22.04-vintage. Unlike most bundled libraries, Wayland client libraries have to
match the *host's* live compositor/Mesa stack, not the build machine's — loading the old
bundled copies makes `eglGetPlatformDisplay()` fail inside `WebKitWebProcess` on newer
hosts. Confirmed by manually deleting those four `.so` files from an extracted AppImage:
the crash disappeared and the app's left/right panes rendered correctly.

Ruled out along the way (neither changed the outcome, since the failure happens at raw
EGL display creation, before either of these would matter): `LIBGL_ALWAYS_SOFTWARE=1`
(forcing Mesa software rendering) and `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`
(this build doesn't even use WebKitGTK's bubblewrap sandbox — `WebKitWebProcess` is a
direct child process, no `bwrap` involved).

Fixed in `Build Instructions/docker/linuxdeploy-plugin-gtk.sh`, at the end of the plugin's
build-time hook: it now deletes those four bundled libraries from the AppDir, so the app
always falls through to the host's own `libwayland-*.so` — present on Fedora, Mint, and
Arch/Omarchy alike as a base GTK3 dependency. This is a no-op on Mint's X11-only Cinnamon
session, since those libraries are never loaded there regardless. Already part of the
Docker pipeline; nothing to do for a local (non-Docker) build other than re-copying the
updated script per workaround 3 below if you build locally on a Wayland machine.

Verified end-to-end: rebuilt all three bundles via `Build Instructions/docker/build.sh`,
confirmed via `--appimage-extract` that the fresh AppImage contains no `libwayland-*`
files, and ran it live on this dev machine's real sandbox — no crash, no coredump, and a
screenshot confirmed both panes render correctly.

## Omarchy/Arch-specific workarounds (this dev machine only, local builds only)

These (1 and 2 below) were needed to get the AppImage to build and actually run when
building directly on this specific bleeding-edge Arch/Omarchy/Hyprland dev machine
(i.e. *not* through Docker). They are **not part of the repo** — they live in a
machine-local build-tool cache (`~/.cache/tauri/`) that gets re-downloaded fresh on a new
machine — so they will not carry over automatically. Linux Mint runs an older, more
conventional toolchain and a normal Xorg/Cinnamon session, so none of this is expected to
be necessary there. Only look at this section if a local (non-Docker) build or run fails
on a similar bleeding-edge/Wayland-only setup.

1. **Stripping fails with a RELR relocation error.** This host's bundled `linuxdeploy`
   ships an older `strip` that can't parse the `.relr.dyn` sections this system's
   modern toolchain emits. Workaround: build with stripping disabled:
   ```bash
   NO_STRIP=1 npx tauri build --bundles appimage
   ```

2. **`copy_tree` fails because a `gdk-pixbuf` loaders directory doesn't exist.** This
   host's `gdk-pixbuf2` uses the newer sandboxed "glycin" loader architecture, so the
   classic `/usr/lib/gdk-pixbuf-2.0/.../loaders` path the bundler plugin expects isn't
   there. Fix by editing the cached plugin script so it skips missing paths instead of
   failing — open `~/.cache/tauri/linuxdeploy-plugin-gtk.sh`, find the `copy_tree()`
   function, and make it `continue` (with a warning) when `[ ! -e "$elem" ]` instead of
   letting `cp` fail.

3. **The built AppImage runs but never shows a window (hangs indefinitely) — or, on
   other machines, opens but the WebView content area crashes/never paints.** The
   AppImage's generated `AppRun` hook unconditionally does `export GDK_BACKEND=x11` (an
   upstream `linuxdeploy-plugin-gtk` workaround for a known Tauri/WebKitGTK Wayland
   crash, see tauri-apps/tauri#8541). On a pure-Wayland session with no working
   Xwayland (this machine, and some Omarchy/Hyprland user machines), forcing X11 makes
   GTK hang forever trying to connect to an X server that isn't there. On a Wayland
   session that *does* have Xwayland (Fedora/GNOME, other Omarchy machines), it instead
   forces the whole app through Xwayland, which is what was actually crashing
   WebKitWebProcess on those machines — see "Why every distro needs workaround 3" above.
   Docker builds already carry the fix via the committed, pre-patched
   `Build Instructions/docker/linuxdeploy-plugin-gtk.sh` (baked into the image by the
   `Dockerfile`) — nothing to do there. For a **local** (non-Docker) build on this
   machine, apply it by hand: copy that repo file over the cached one
   (`cp "Build Instructions/docker/linuxdeploy-plugin-gtk.sh" ~/.cache/tauri/linuxdeploy-plugin-gtk.sh`),
   or edit `~/.cache/tauri/linuxdeploy-plugin-gtk.sh` directly — find the line
   `export GDK_BACKEND=x11 # Crash with Wayland backend...` inside the `HOOKFILE`
   heredoc, and wrap it so it only applies when there's no Wayland session:
   ```bash
   if [ -z "${WAYLAND_DISPLAY:-}" ]; then
       export GDK_BACKEND=x11 # Crash with Wayland backend on Wayland - We tested it without it and ended up with this: https://github.com/tauri-apps/tauri/issues/8541
   fi
   ```
   Then rebuild. You can confirm a window actually opened (rather than just checking
   the process is running) with `hyprctl clients | grep -A5 Sectionist` on Hyprland —
   look for `xwayland: 0` and a mapped window.

   If `~/.cache/tauri/linuxdeploy-plugin-gtk.sh` is ever deleted (e.g. cache cleared,
   or a `linuxdeploy` version bump re-downloads it), workarounds 2 and 3 above will
   need to be reapplied before the AppImage will build/run cleanly on this machine
   again.
