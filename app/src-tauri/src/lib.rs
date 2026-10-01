mod commands;
mod encoding;
mod menu;
mod watcher;

use std::sync::Mutex;

use tauri::menu::CheckMenuItem;
use tauri::{Emitter, Manager};

/// Holds a file path passed on the command line at startup (e.g. via an OS
/// file association) until the frontend is ready to receive it. Emitting an
/// event during `.setup()` would race the frontend's own listener
/// registration and could be silently dropped, so the path is stashed here
/// instead and pulled by `take_pending_launch_file` once the frontend has
/// finished initializing.
struct PendingLaunchFile(Mutex<Option<String>>);

#[tauri::command]
fn take_pending_launch_file(state: tauri::State<PendingLaunchFile>) -> Option<String> {
    state.0.lock().unwrap().take()
}

/// Finds the first argument that looks like a file path to open, ignoring
/// the program name itself (`args[0]`). Used both for the initial launch's
/// `std::env::args()` and for a second launch's forwarded `argv` — both are
/// plain OS-provided argument lists with no flags of our own to parse
/// around.
fn first_file_arg(args: &[String]) -> Option<String> {
    args.iter().skip(1).find(|a| !a.is_empty()).cloned()
}

/// Resolves a possibly-relative path (as OS file associations may pass)
/// against the working directory the launch/forward happened from.
fn resolve_against_cwd(path: String, cwd: &str) -> String {
    let p = std::path::Path::new(&path);
    if p.is_absolute() || cwd.is_empty() {
        path
    } else {
        std::path::Path::new(cwd)
            .join(p)
            .to_string_lossy()
            .into_owned()
    }
}

/// Handles to the checkbox-style menu items whose checked state the
/// frontend needs to keep in sync with persisted settings (word wrap
/// defaults on; the sections pane defaults visible; theme/font each default
/// to their first entry).
///
/// `themes` and `fonts` are each a mutually-exclusive group — every entry's
/// id-suffix paired with its item — so the commands below can uncheck every
/// other item in the group generically instead of hardcoding each one.
struct MenuCheckboxes {
    word_wrap: CheckMenuItem<tauri::Wry>,
    sections_pane: CheckMenuItem<tauri::Wry>,
    themes: Vec<(String, CheckMenuItem<tauri::Wry>)>,
    fonts: Vec<(String, CheckMenuItem<tauri::Wry>)>,
    encodings: Vec<(String, CheckMenuItem<tauri::Wry>)>,
    spell_check: CheckMenuItem<tauri::Wry>,
}

#[tauri::command]
fn set_word_wrap_checked(state: tauri::State<MenuCheckboxes>, checked: bool) -> Result<(), String> {
    state.word_wrap.set_checked(checked).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_sections_pane_checked(
    state: tauri::State<MenuCheckboxes>,
    checked: bool,
) -> Result<(), String> {
    state
        .sections_pane
        .set_checked(checked)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_theme_checked(state: tauri::State<MenuCheckboxes>, id: String) -> Result<(), String> {
    for (item_id, item) in &state.themes {
        item.set_checked(*item_id == id).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_font_checked(state: tauri::State<MenuCheckboxes>, id: String) -> Result<(), String> {
    for (item_id, item) in &state.fonts {
        item.set_checked(*item_id == id).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// `id` is checked and every other encoding item is unchecked, mirroring
/// `set_theme_checked`/`set_font_checked`. Unlike those, the Encoding menu
/// is per-file, so the frontend calls this every time the active file
/// changes (not just on user selection) to keep the checkmark in sync.
#[tauri::command]
fn set_encoding_checked(state: tauri::State<MenuCheckboxes>, id: String) -> Result<(), String> {
    for (item_id, item) in &state.encodings {
        item.set_checked(*item_id == id).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Enables/disables the whole Encoding item group at once, since the menu
/// only makes sense for an active, editable file (see set_encoding_checked).
#[tauri::command]
fn set_encoding_menu_enabled(state: tauri::State<MenuCheckboxes>, enabled: bool) -> Result<(), String> {
    for (_, item) in &state.encodings {
        item.set_enabled(enabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_spell_check_checked(state: tauri::State<MenuCheckboxes>, checked: bool) -> Result<(), String> {
    state
        .spell_check
        .set_checked(checked)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(path) = first_file_arg(&argv) {
                let path = resolve_against_cwd(path, &cwd);
                let _ = app.emit("sectionist:open-file-request", path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(watcher::WatcherState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all())
                .build(),
        )
        .setup(|app| {
            let initial_file = first_file_arg(&std::env::args().collect::<Vec<_>>())
                .map(|path| resolve_against_cwd(path, &std::env::current_dir()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default()));
            app.manage(PendingLaunchFile(Mutex::new(initial_file)));

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let built_menu = menu::build_menu(app.handle())?;
            app.set_menu(built_menu.menu)?;
            app.manage(MenuCheckboxes {
                word_wrap: built_menu.word_wrap,
                sections_pane: built_menu.sections_pane,
                themes: built_menu.themes,
                fonts: built_menu.fonts,
                encodings: built_menu.encodings,
                spell_check: built_menu.spell_check,
            });

            let handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let _ = handle.emit("sectionist:menu-action", event.id().0.clone());
            });

            // This is a confirmed upstream bug in tao's Wayland CSD
            // implementation (tauri-apps/tauri#13749): set_title() updates
            // the compositor's own notion of the title (what `hyprctl
            // clients` reports) but the custom-drawn GtkHeaderBar widget
            // never repaints to match, on any code path — hide/show cycles,
            // creating the window hidden until after retitling, and
            // toggling resizable off/on all made no visible difference.
            // Fixed upstream in tao 0.36 (bundled with Tauri 2.12), which
            // hasn't shipped as a stable release yet. As a stopgap, reach
            // past tao's set_title() and set the title directly on the
            // GtkHeaderBar widget it installed as the window's titlebar.
            // tao's wayland/header.rs wraps the HeaderBar in a GtkEventBox
            // before calling set_titlebar(), so the titlebar widget itself
            // downcasts to EventBox, not HeaderBar — the HeaderBar is its
            // one child.
            if let Some(window) = app.get_webview_window("main") {
                let title = format!("Sectionist - v{}", app.package_info().version);
                window.set_title(&title)?;

                #[cfg(any(
                    target_os = "linux",
                    target_os = "dragonfly",
                    target_os = "freebsd",
                    target_os = "netbsd",
                    target_os = "openbsd"
                ))]
                {
                    use gtk::prelude::{BinExt, Cast, GtkWindowExt, HeaderBarExt};
                    if let Ok(gtk_window) = window.gtk_window() {
                        if let Some(titlebar) = gtk_window.titlebar() {
                            let header_bar = titlebar
                                .downcast_ref::<gtk::EventBox>()
                                .and_then(|event_box| event_box.child())
                                .and_then(|child| child.downcast::<gtk::HeaderBar>().ok());
                            if let Some(header_bar) = header_bar {
                                header_bar.set_title(Some(&title));
                            }
                        }
                    }

                    // WebKitGTK ships with spell-checking disabled at the
                    // WebContext level regardless of the `spellcheck` DOM
                    // attribute editor.ts sets on the editor's contenteditable
                    // element — without this, toggling Edit > Spell Check has
                    // no visible effect at all, on any element, since the
                    // webview never checks spelling in the first place. The
                    // DOM attribute still gates whether checking is actually
                    // active for the editor; this just makes the webview
                    // capable of it.
                    use webkit2gtk::{WebContextExt, WebViewExt};
                    let _ = window.with_webview(|webview| {
                        let wv = webview.inner();
                        if let Some(ctx) = wv.context() {
                            ctx.set_spell_checking_enabled(true);
                            let lang = std::env::var("LANG")
                                .or_else(|_| std::env::var("LC_ALL"))
                                .ok()
                                .and_then(|v| v.split('.').next().map(str::to_string))
                                .filter(|v| !v.is_empty() && v != "C" && v != "POSIX")
                                .unwrap_or_else(|| "en_US".to_string());
                            ctx.set_spell_checking_languages(&[&lang]);
                        }
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::read_text_file,
            commands::read_text_file_detect,
            commands::write_text_file,
            commands::write_text_file_detect,
            commands::create_text_file,
            commands::path_metadata,
            commands::launch_path,
            commands::app_config_dir,
            commands::path_join,
            watcher::watch_path,
            watcher::unwatch_path,
            take_pending_launch_file,
            set_word_wrap_checked,
            set_sections_pane_checked,
            set_theme_checked,
            set_font_checked,
            set_encoding_checked,
            set_encoding_menu_enabled,
            set_spell_check_checked,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
