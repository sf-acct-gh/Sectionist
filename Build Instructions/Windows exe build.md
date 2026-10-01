# Windows Build

Produces Windows builds of Sectionist in two forms, from the same source:

1. **Installers** — an NSIS-based `.exe` installer plus an `.msi`, both of which install
   the app under the user's profile/Start Menu like a normal Windows application.
2. **Portable/standalone `.exe`** — a single `Sectionist.exe` with no installer at all;
   copy it anywhere and double-click to run.

**This must be built on an actual Windows machine** — Tauri does not support reliably
cross-compiling a Windows build from Linux, and this project has not set up
cross-compilation. Build this directly on Windows 11.

## 1. One-time prerequisites (on the Windows machine)

1. **Node.js** (18+): <https://nodejs.org>
2. **Rust**, via rustup: <https://rustup.rs> — during install, choose the
   `stable-x86_64-pc-windows-msvc` toolchain (the default on Windows).
3. **Microsoft C++ Build Tools** — required by the MSVC Rust toolchain. Install
   "Visual Studio Build Tools" (or full Visual Studio) with the
   **"Desktop development with C++"** workload checked:
   <https://visualstudio.microsoft.com/visual-cpp-build-tools/>
4. **WebView2 Runtime** — comes preinstalled on Windows 11, so normally nothing to do
   here. If missing, get it from
   <https://developer.microsoft.com/en-us/microsoft-edge/webview2/>. Both the
   installers and the portable exe rely on this system-provided runtime rather than
   bundling their own — it is a prerequisite either way.

Full/authoritative prerequisite list: <https://v2.tauri.app/start/prerequisites/>.

Clone/copy the repository onto the Windows machine, then from the `app` folder,
install JS dependencies once (PowerShell or Command Prompt):

```powershell
cd app
npm install
```

## 2. Installers (`.exe` setup + `.msi`)

From the `app` folder:

```powershell
npx tauri build
```

(No `--bundles` flag needed — on Windows, Tauri's default bundle targets are already
just `msi` and `nsis`.)

### Where the output goes

```
app\src-tauri\target\release\bundle\nsis\Sectionist_<version>_x64-setup.exe
app\src-tauri\target\release\bundle\msi\Sectionist_<version>_x64_en-US.msi
```

The `.exe` (NSIS) installer is the one referred to as the "Windows exe build"; the
`.msi` is produced alongside it automatically and can also be distributed if useful.

### Copy to the consolidated Releases folder

From the repository root, in PowerShell:

```powershell
New-Item -ItemType Directory -Force -Path "Releases" | Out-Null
Copy-Item "app\src-tauri\target\release\bundle\nsis\Sectionist_*_x64-setup.exe" "Releases\"
Copy-Item "app\src-tauri\target\release\bundle\msi\Sectionist_*_x64_en-US.msi" "Releases\"
```

This overwrites any previously copied installer with the same filename (i.e. the same
version). If you bump the app version, the old file will remain in `Releases\` under
its old name unless you delete it manually.

### Verify

Run the copied `.exe` and step through the installer, then launch Sectionist from the
Start Menu and confirm it opens normally.

## 3. Portable/standalone `.exe` (no installer)

Since Sectionist uses the OS-provided WebView2 runtime rather than bundling its own
browser engine, the raw compiled binary is already a complete, self-contained app — it
can be copied anywhere and double-clicked directly, with no install step. From the `app`
folder:

```powershell
npm install
npx tauri build --no-bundle
```

Skip the installer-packaging step with `--no-bundle`; this still runs the full release
build (frontend + Rust backend in release mode), it just skips producing the NSIS/MSI
installers afterward.

**`npm install` first, every time, on a fresh clone/VM.** Confirmed 2026-09-14 on a fresh
Windows VM: running `npx tauri build --no-bundle` directly (skipping `npm install`, even
though it's listed under prerequisites above) fails with:
```
npm error could not determine executable to run
```
This happens because `npx tauri` resolves to the `tauri` binary that `npm install`
creates at `node_modules\.bin\` from the `@tauri-apps/cli` dependency — with no
`node_modules` yet, npx has nothing to resolve locally. Running `npm install` once per
clone (already done in step 1 above, but easy to skip when jumping straight to section 3)
fixes it.

### Where the output goes

```
app\src-tauri\target\release\Sectionist.exe
```

(Named `Sectionist.exe` via the `mainBinaryName` setting in
`app/src-tauri/tauri.conf.json`. Without that setting, the raw `cargo` output would
instead be named after the Rust package, `app.exe` — if a `tauri` version ever fails to
apply the rename, `app.exe` in the same folder is functionally identical; just copy/
rename that instead.)

### Copy to the consolidated Releases folder

From the repository root, in PowerShell (substitute the current version, from `version`
in `app/src-tauri/tauri.conf.json`):

```powershell
New-Item -ItemType Directory -Force -Path "Releases" | Out-Null
Copy-Item "app\src-tauri\target\release\Sectionist.exe" "Releases\Sectionist_<version>_x64-portable.exe"
```

### Verify

Copy `Sectionist_<version>_x64-portable.exe` to a location outside the build tree (e.g.
the Desktop, or a USB drive) and double-click it there — it should launch directly with
no setup wizard. Confirm the window opens, the native menu works, and a file can be
opened and saved.

### Notes

- The portable exe still stores its config/window-state/unsaved-recovery data in the
  same per-user `%APPDATA%\com.sectionist.app` location the installed version uses (via
  Tauri's standard app-data-dir resolution) — it does not keep its settings next to the
  exe file itself. That's normal for a portable Windows executable and requires no write
  access next to the exe, so it can be run from a read-only location (e.g. a USB drive).
- Requires the WebView2 Runtime, same as the installed version (see prerequisite #4
  above).

## 4. Committing built artifacts

`Releases/` is tracked in git (not gitignored) — after copying any of the above, `git
add`/commit the updated file(s) so the repo's copy stays current.
