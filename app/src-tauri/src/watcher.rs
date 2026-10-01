// External file-change monitoring.
//
// We watch the *parent directory* of each file rather than the file itself.
// Many editors (and "safe save" patterns in general) save by writing a new
// temp file and renaming it over the original. That replaces the original
// inode, which silently breaks a watch placed directly on the file. Watching
// the containing directory and filtering by filename survives that pattern.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

struct DirWatch {
    _watcher: RecommendedWatcher,
    watched_files: HashSet<PathBuf>,
}

#[derive(Default)]
pub struct WatcherState {
    dirs: Mutex<HashMap<PathBuf, DirWatch>>,
    // Coalesce bursts of events for the same path so a single external save
    // (which often triggers several filesystem events) produces one signal.
    last_emit: Mutex<HashMap<PathBuf, (&'static str, Instant)>>,
    // Content hash of the data Sectionist itself last read from or wrote to
    // each path, recorded by `read_text_file`/`write_text_file`. A
    // "modified"-classified filesystem event (which, per `handle_event`,
    // includes a raw Remove event for a path that still exists on disk —
    // see the comment there) whose current on-disk content still hashes the
    // same as this is our own save reflected back by the OS (the
    // temp-file-then-rename pattern generates a filesystem event
    // indistinguishable from an external edit), not a real external change.
    // Checking by content rather than a timing window means this can't be
    // fooled by how quickly (or slowly — observed on Windows, whose
    // ReadDirectoryChangesW delivery is less prompt than Linux inotify) the
    // OS actually delivers the event.
    known_content: Mutex<HashMap<PathBuf, u64>>,
}

fn hash_content(contents: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    contents.hash(&mut hasher);
    hasher.finish()
}

impl WatcherState {
    // Hashed as raw bytes rather than as a `String`: a file opened via
    // read_text_file_detect/write_text_file_detect (see commands.rs) may be
    // UTF-16 or a legacy codepage on disk, and re-reading it here with
    // fs::read_to_string (which assumes UTF-8) would simply fail for those,
    // making every save of a non-UTF-8 file look like an unmatched external
    // change to the code below.
    pub fn record_known_content(&self, path: &Path, contents: &[u8]) {
        self.known_content
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), hash_content(contents));
    }

    /// True if `path`'s current on-disk content hashes the same as the last
    /// content Sectionist itself read or wrote for it, meaning this
    /// "modified" event is not a real external change.
    fn matches_known_content(&self, path: &Path) -> bool {
        let known = self.known_content.lock().unwrap();
        let Some(expected) = known.get(path) else {
            return false;
        };
        match fs::read(path) {
            Ok(contents) => hash_content(&contents) == *expected,
            Err(_) => false,
        }
    }
}

#[derive(Serialize, Clone)]
struct FileEventPayload {
    path: String,
    kind: &'static str, // "modified" | "removed"
}

const DEBOUNCE: Duration = Duration::from_millis(250);

impl WatcherState {
    fn should_emit(&self, path: &Path, kind: &'static str) -> bool {
        let mut last = self.last_emit.lock().unwrap();
        let now = Instant::now();
        if let Some((prev_kind, at)) = last.get(path) {
            if *prev_kind == kind && now.duration_since(*at) < DEBOUNCE {
                return false;
            }
        }
        last.insert(path.to_path_buf(), (kind, now));
        true
    }
}

fn handle_event(app: &AppHandle, state: &WatcherState, dir: &Path, event: Event) {
    let dirs = state.dirs.lock().unwrap();
    let Some(watch) = dirs.get(dir) else { return };

    for changed_path in &event.paths {
        if !watch.watched_files.contains(changed_path) {
            continue;
        }
        // Whether the path still exists on disk is the authority on
        // "removed" vs. "modified", not the raw event kind. Replacing a
        // file via rename (our own atomic-save pattern, and many other
        // editors' "safe save") is reported inconsistently across
        // platforms: on Windows this has been observed to surface as an
        // `EventKind::Remove` for the destination path even though the
        // rename succeeded and the file exists again immediately
        // afterward. Trusting that event kind unconditionally turned every
        // Windows save into a false "file no longer on disk" — so a Remove
        // event for a path that still exists is treated as a potential
        // modification (and run through the content-hash check below)
        // rather than an automatic removal.
        let still_exists = changed_path.exists();
        let kind = if !still_exists {
            "removed"
        } else if matches!(
            event.kind,
            EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
        ) {
            "modified"
        } else {
            continue;
        };

        if kind == "modified" && state.matches_known_content(changed_path) {
            continue;
        }

        if state.should_emit(changed_path, kind) {
            let _ = app.emit(
                "sectionist:file-event",
                FileEventPayload {
                    path: changed_path.to_string_lossy().to_string(),
                    kind,
                },
            );
        }
    }
}

#[tauri::command]
pub fn watch_path(
    app: AppHandle,
    state: tauri::State<WatcherState>,
    path: String,
) -> Result<(), String> {
    let file_path = PathBuf::from(&path);
    let dir = file_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("Cannot watch '{path}': no parent directory"))?
        .to_path_buf();

    let mut dirs = state.dirs.lock().unwrap();
    if let Some(existing) = dirs.get_mut(&dir) {
        existing.watched_files.insert(file_path);
        return Ok(());
    }

    let app_for_watcher = app.clone();
    let dir_for_watcher = dir.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            // The WatcherState is managed app state; look it up fresh on
            // every callback rather than trying to capture it (it isn't
            // Send+'static-friendly to clone into this closure directly).
            let state = app_for_watcher.state::<WatcherState>();
            handle_event(&app_for_watcher, &state, &dir_for_watcher, event);
        }
    })
    .map_err(|e| format!("Could not create file watcher: {e}"))?;

    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Could not watch '{}': {e}", dir.display()))?;

    let mut watched_files = HashSet::new();
    watched_files.insert(file_path);
    dirs.insert(
        dir,
        DirWatch {
            _watcher: watcher,
            watched_files,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn unwatch_path(state: tauri::State<WatcherState>, path: String) -> Result<(), String> {
    let file_path = PathBuf::from(&path);
    let Some(dir) = file_path.parent().map(|p| p.to_path_buf()) else {
        return Ok(());
    };

    let mut dirs = state.dirs.lock().unwrap();
    if let Some(watch) = dirs.get_mut(&dir) {
        watch.watched_files.remove(&file_path);
        if watch.watched_files.is_empty() {
            dirs.remove(&dir);
        }
    }
    Ok(())
}
