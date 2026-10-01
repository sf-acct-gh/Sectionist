// Tauri commands: the trusted backend surface the frontend calls into.
//
// These are intentionally thin wrappers around std::fs / the `open` crate.
// We do not use tauri-plugin-fs here because that plugin's scope/capability
// system is designed for sandboxing webview content that loads remote code.
// Sectionist is a local trusted desktop app whose entire purpose is to read
// and write files the user explicitly chooses from anywhere on disk, so a
// direct std::fs implementation is simpler and avoids fighting the scope
// system for a guarantee we don't need.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};

use crate::encoding::{detect_and_decode, encode_for_save};
use crate::watcher::WatcherState;

#[derive(Serialize)]
pub struct DecodedFile {
    pub contents: String,
    pub encoding: String,
}

#[derive(Serialize)]
pub struct PathMetadata {
    pub exists: bool,
    pub is_file: bool,
    /// Milliseconds since the Unix epoch, when available.
    pub modified_ms: Option<u128>,
    pub size: Option<u64>,
}

#[tauri::command]
pub fn read_text_file(
    watcher_state: tauri::State<WatcherState>,
    path: String,
) -> Result<String, String> {
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("Could not read '{path}': {e}"))?;
    // Record what Sectionist itself just read as this path's known-good
    // content, so a later filesystem event that still matches it (e.g. an
    // editor that briefly touches the file without changing it) isn't
    // misreported as an external change.
    watcher_state.record_known_content(Path::new(&path), contents.as_bytes());
    Ok(contents)
}

/// Like `read_text_file`, but detects the file's actual encoding (BOM, plain
/// UTF-8, UTF-16, or a best-effort legacy codepage guess) instead of
/// assuming UTF-8 — see encoding.rs. Used for the user's own documents;
/// `read_text_file` remains UTF-8-only for Sectionist's own config/recovery
/// JSON files, which are always written by Sectionist itself.
#[tauri::command]
pub fn read_text_file_detect(
    watcher_state: tauri::State<WatcherState>,
    path: String,
) -> Result<DecodedFile, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Could not read '{path}': {e}"))?;
    let (contents, encoding) = detect_and_decode(&bytes)?;
    watcher_state.record_known_content(Path::new(&path), &bytes);
    Ok(DecodedFile { contents, encoding })
}

#[tauri::command]
pub fn write_text_file(
    watcher_state: tauri::State<WatcherState>,
    path: String,
    contents: String,
) -> Result<(), String> {
    // Write to a sibling temp file and rename over the target so a save that
    // fails partway (disk full, power loss) can never leave the original
    // file half-written. Renames within the same directory are atomic on
    // both Windows (NTFS/ReFS) and Linux (same filesystem).
    let target = Path::new(&path);
    let dir = target.parent().ok_or_else(|| format!("Invalid path: {path}"))?;
    let file_name = target
        .file_name()
        .ok_or_else(|| format!("Invalid path: {path}"))?
        .to_string_lossy();
    let tmp_path = dir.join(format!(".{file_name}.sectionist-tmp"));

    fs::write(&tmp_path, contents.as_bytes())
        .map_err(|e| format!("Could not write '{path}': {e}"))?;
    // Record this write's content as the known-good hash for this path
    // *before* performing the rename, so there is no race between the
    // filesystem event firing and us recording it — the watcher compares
    // by content, not timing, so this is safe to set slightly ahead.
    watcher_state.record_known_content(target, contents.as_bytes());
    fs::rename(&tmp_path, target).map_err(|e| {
        // Best-effort cleanup of the temp file if the rename itself failed.
        let _ = fs::remove_file(&tmp_path);
        format!("Could not save '{path}': {e}")
    })
}

/// Like `write_text_file`, but encodes `contents` into `encoding_id`'s
/// on-disk byte format (see encoding.rs) instead of always writing UTF-8.
#[tauri::command]
pub fn write_text_file_detect(
    watcher_state: tauri::State<WatcherState>,
    path: String,
    contents: String,
    encoding: String,
) -> Result<(), String> {
    let bytes = encode_for_save(&contents, &encoding)?;
    let target = Path::new(&path);
    let dir = target.parent().ok_or_else(|| format!("Invalid path: {path}"))?;
    let file_name = target
        .file_name()
        .ok_or_else(|| format!("Invalid path: {path}"))?
        .to_string_lossy();
    let tmp_path = dir.join(format!(".{file_name}.sectionist-tmp"));

    fs::write(&tmp_path, &bytes).map_err(|e| format!("Could not write '{path}': {e}"))?;
    watcher_state.record_known_content(target, &bytes);
    fs::rename(&tmp_path, target).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Could not save '{path}': {e}")
    })
}

/// Creates a new empty UTF-8 text file at `path`. This is only ever called
/// after the user has chosen the destination through the native save
/// dialog, which already asks to confirm overwriting an existing file, so
/// truncating here does not silently destroy anything the user was not
/// just warned about.
#[tauri::command]
pub fn create_text_file(path: String) -> Result<(), String> {
    fs::write(&path, b"").map_err(|e| format!("Could not create '{path}': {e}"))
}

#[tauri::command]
pub fn path_metadata(path: String) -> PathMetadata {
    match fs::metadata(&path) {
        Ok(meta) => PathMetadata {
            exists: true,
            is_file: meta.is_file(),
            modified_ms: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis()),
            size: Some(meta.len()),
        },
        Err(_) => PathMetadata {
            exists: false,
            is_file: false,
            modified_ms: None,
            size: None,
        },
    }
}

#[tauri::command]
pub fn launch_path(path: String) -> Result<(), String> {
    // `open::that`/`that_detached` shell out to `xdg-open` first on Linux.
    // `xdg-open`'s desktop-environment detection unconditionally runs the
    // X11 `xprop` tool, which hangs forever on a Wayland session with no
    // Xwayland (observed on this machine's Hyprland setup) — so the
    // (successfully, detached-ly spawned) `xdg-open` process never gets
    // around to actually opening anything, and `that_detached` has no way
    // to know that and try the next opener. `gio open` resolves the same
    // desktop mime-association/portal without going through that broken
    // detection path, so prefer it directly on Linux and fall back to the
    // `open` crate's own opener chain (xdg-open/gio/gnome-open/kde-open) if
    // `gio` isn't installed.
    #[cfg(target_os = "linux")]
    {
        use std::process::{Command, Stdio};

        // When running from an AppImage, its `AppRun` injects an
        // `LD_LIBRARY_PATH` (plus related GTK/GIO vars) pointing at its own
        // bundled libraries so Sectionist itself links against them. That
        // environment is inherited by this subprocess too, but `gio` here is
        // the *target system's* binary - forcing it to resolve against the
        // bundled (older) glib instead of the system's own causes
        // undefined-symbol failures and `gio open` silently doing nothing
        // (observed on Linux Mint: clicking a non-editable file did nothing).
        // Strip those vars so `gio` runs against the system's own libraries;
        // this is a no-op outside an AppImage.
        match Command::new("gio")
            .arg("open")
            .arg(&path)
            .env_remove("LD_LIBRARY_PATH")
            .env_remove("GTK_PATH")
            .env_remove("GTK_EXE_PREFIX")
            .env_remove("GTK_DATA_PREFIX")
            .env_remove("GTK_IM_MODULE_FILE")
            .env_remove("GDK_PIXBUF_MODULE_FILE")
            .env_remove("GIO_EXTRA_MODULES")
            .env_remove("GSETTINGS_SCHEMA_DIR")
            .env_remove("XDG_DATA_DIRS")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(mut child) => {
                // `gio open` itself exits almost immediately once it has
                // handed off to the launched app; reap it on a background
                // thread so it doesn't accumulate as a zombie process.
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(());
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not open '{path}': {e}")),
        }
    }

    open::that_detached(&path).map_err(|e| format!("Could not open '{path}': {e}"))
}

/// Directory for Sectionist's own configuration/recovery data, kept
/// separate from the user's documents. Created if it does not exist yet.
#[tauri::command]
pub fn app_config_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not resolve app config directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create app config directory: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn path_join(base: String, name: String) -> String {
    let joined: PathBuf = Path::new(&base).join(name);
    joined.to_string_lossy().to_string()
}
