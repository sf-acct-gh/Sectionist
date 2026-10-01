// Native application menu (File / Edit / View / Themes / Encoding).
//
// Menu clicks are forwarded to the frontend as a "sectionist:menu-action"
// event carrying the item's string id; the TypeScript side owns the actual
// editor/section logic and reacts to that id. Keeping the Rust side dumb
// (just "something with this id was clicked") avoids duplicating editor
// state across the IPC boundary.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// The full native menu, plus handles to the checkbox items whose checked
/// state the frontend needs to update later. `Menu::get` only searches an
/// app menu's top-level entries (the submenus themselves, not their
/// children), so callers cannot recover these by id after the fact — the
/// handles have to be captured here at construction time instead.
///
/// `themes` and `fonts` are each a mutually-exclusive group (only one item
/// per group is ever checked at a time), stored as (id-suffix, item) pairs
/// so the command handlers in lib.rs can uncheck every other item in the
/// group generically instead of hardcoding each one.
pub struct BuiltMenu<R: Runtime> {
    pub menu: Menu<R>,
    pub word_wrap: CheckMenuItem<R>,
    pub sections_pane: CheckMenuItem<R>,
    pub themes: Vec<(String, CheckMenuItem<R>)>,
    pub fonts: Vec<(String, CheckMenuItem<R>)>,
    pub encodings: Vec<(String, CheckMenuItem<R>)>,
    pub spell_check: CheckMenuItem<R>,
}

// Shortcuts are handled entirely in the frontend (see main.ts's keydown
// handler) rather than via native OS menu accelerators. WebView2 on Windows
// intercepts some Ctrl-combos for its own defaults (e.g. Ctrl+P opening
// print) before the native accelerator table ever sees them, which broke
// most of these shortcuts on Windows while they kept working on Linux/GTK.
// Every accelerator below is therefore `None`, with the shortcut spelled out
// in the label instead, purely for menu discoverability.
pub fn build_menu<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<BuiltMenu<R>> {
    let file_new = MenuItem::with_id(handle, "file_new", "New File (Ctrl+N)", true, None::<&str>)?;
    let file_open =
        MenuItem::with_id(handle, "file_open", "Open File... (Ctrl+O)", true, None::<&str>)?;
    let file_save = MenuItem::with_id(handle, "file_save", "Save (Ctrl+S)", true, None::<&str>)?;
    let file_save_as = MenuItem::with_id(
        handle,
        "file_save_as",
        "Save As... (Ctrl+Shift+S)",
        true,
        None::<&str>,
    )?;
    // `PredefinedMenuItem::quit` is silently unsupported on the GTK/Linux
    // menu backend (muda only renders Separator/Copy/Cut/Paste/SelectAll/
    // About as native predefined items there) — it never shows up in the
    // menu at all. Use a plain menu item instead and let the frontend quit
    // via the window, matching every other menu action's dispatch pattern.
    let file_exit = MenuItem::with_id(handle, "file_exit", "Exit (Ctrl+Q)", true, None::<&str>)?;
    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &file_new,
            &file_open,
            &file_save,
            &file_save_as,
            &PredefinedMenuItem::separator(handle)?,
            &file_exit,
        ],
    )?;

    let edit_undo = MenuItem::with_id(handle, "edit_undo", "Undo (Ctrl+Z)", true, None::<&str>)?;
    let edit_redo = MenuItem::with_id(handle, "edit_redo", "Redo (Ctrl+Y)", true, None::<&str>)?;
    let edit_cut = MenuItem::with_id(handle, "edit_cut", "Cut (Ctrl+X)", true, None::<&str>)?;
    let edit_copy = MenuItem::with_id(handle, "edit_copy", "Copy (Ctrl+C)", true, None::<&str>)?;
    let edit_paste = MenuItem::with_id(handle, "edit_paste", "Paste (Ctrl+V)", true, None::<&str>)?;
    let edit_find = MenuItem::with_id(handle, "edit_find", "Find... (Ctrl+F)", true, None::<&str>)?;
    let edit_replace = MenuItem::with_id(
        handle,
        "edit_replace",
        "Replace... (Ctrl+H)",
        true,
        None::<&str>,
    )?;
    let edit_preferences = MenuItem::with_id(
        handle,
        "edit_preferences",
        "Preferences... (Ctrl+P)",
        true,
        None::<&str>,
    )?;
    let edit_spell_check = CheckMenuItem::with_id(
        handle,
        "edit_spell_check",
        "Spell Check",
        true,
        false,
        None::<&str>,
    )?;
    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &edit_undo,
            &edit_redo,
            &PredefinedMenuItem::separator(handle)?,
            &edit_cut,
            &edit_copy,
            &edit_paste,
            &PredefinedMenuItem::separator(handle)?,
            &edit_find,
            &edit_replace,
            &PredefinedMenuItem::separator(handle)?,
            &edit_preferences,
            &PredefinedMenuItem::separator(handle)?,
            &edit_spell_check,
        ],
    )?;

    let view_word_wrap = CheckMenuItem::with_id(
        handle,
        "view_word_wrap",
        "Word Wrap",
        true,
        true,
        None::<&str>,
    )?;
    let view_zoom_in =
        MenuItem::with_id(handle, "view_zoom_in", "Zoom In (Ctrl+=)", true, None::<&str>)?;
    let view_zoom_out = MenuItem::with_id(
        handle,
        "view_zoom_out",
        "Zoom Out (Ctrl+-)",
        true,
        None::<&str>,
    )?;
    let view_zoom_reset = MenuItem::with_id(
        handle,
        "view_zoom_reset",
        "Reset Zoom (Ctrl+0)",
        true,
        None::<&str>,
    )?;
    let view_toggle_sections = CheckMenuItem::with_id(
        handle,
        "view_toggle_sections",
        "Show Sections Pane (Ctrl+B)",
        true,
        true,
        None::<&str>,
    )?;
    let view_collapse_all = MenuItem::with_id(
        handle,
        "view_collapse_all",
        "Collapse All Sections (Ctrl+[)",
        true,
        None::<&str>,
    )?;
    let view_expand_all = MenuItem::with_id(
        handle,
        "view_expand_all",
        "Expand All Sections (Ctrl+])",
        true,
        None::<&str>,
    )?;

    // Editor font: a fixed list of font-family choices for the plain-text
    // editing surface (see app/src/fonts.ts). Mutually exclusive, like the
    // Themes items below — "Default" (the OS/browser's own default, unset by
    // Sectionist) starts checked.
    const FONTS: &[(&str, &str)] = &[
        ("default", "Default"),
        ("times", "Times New Roman"),
        ("courier", "Courier New (mono)"),
        ("georgia", "Georgia"),
        ("arial", "Arial"),
        ("verdana", "Verdana"),
        ("consolas", "Consolas (mono)"),
        ("wide-mono", "Wide Mono (mono)"),
        ("wider-mono", "Wider Mono (mono)"),
    ];
    let mut fonts = Vec::with_capacity(FONTS.len());
    for (id, label) in FONTS {
        let checked = *id == "default";
        let item = CheckMenuItem::with_id(
            handle,
            format!("view_font_{id}"),
            *label,
            true,
            checked,
            None::<&str>,
        )?;
        fonts.push((id.to_string(), item));
    }
    let font_menu_items: Vec<&dyn tauri::menu::IsMenuItem<R>> =
        fonts.iter().map(|(_, item)| item as &dyn tauri::menu::IsMenuItem<R>).collect();
    let font_menu = Submenu::with_items(handle, "Font", true, &font_menu_items)?;

    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[
            &view_word_wrap,
            &PredefinedMenuItem::separator(handle)?,
            &view_zoom_in,
            &view_zoom_out,
            &view_zoom_reset,
            &PredefinedMenuItem::separator(handle)?,
            &view_toggle_sections,
            &view_collapse_all,
            &view_expand_all,
            &PredefinedMenuItem::separator(handle)?,
            &font_menu,
        ],
    )?;

    // One theme per file in app/src/themes/*.json (see theme.ts) — Light is
    // the default and starts checked. Ids here must match each theme file's
    // "id" field, prefixed with "theme_", so the frontend can dispatch
    // directly without a lookup table.
    const THEMES: &[(&str, &str)] = &[
        ("light", "Light"),
        ("dark", "Dark"),
        ("programmer", "Programmer"),
        ("vscode", "VS Code"),
    ];
    let mut themes = Vec::with_capacity(THEMES.len());
    for (id, label) in THEMES {
        let checked = *id == "light";
        let item = CheckMenuItem::with_id(
            handle,
            format!("theme_{id}"),
            *label,
            true,
            checked,
            None::<&str>,
        )?;
        themes.push((id.to_string(), item));
    }
    let theme_menu_items: Vec<&dyn tauri::menu::IsMenuItem<R>> =
        themes.iter().map(|(_, item)| item as &dyn tauri::menu::IsMenuItem<R>).collect();
    let themes_menu = Submenu::with_items(handle, "Themes", true, &theme_menu_items)?;

    // Per-file (unlike Themes/Fonts, which are global app settings): the
    // frontend enables/disables this submenu and syncs the checked item
    // every time the active file changes (see main.ts and
    // set_encoding_checked/set_encoding_menu_enabled in lib.rs). Starts
    // disabled with nothing checked since no file is open yet.
    const ENCODINGS: &[(&str, &str)] = &[
        ("utf8", "UTF-8"),
        ("utf8-bom", "UTF-8 with BOM"),
        ("utf16le", "UTF-16 LE"),
        ("utf16be", "UTF-16 BE"),
        ("windows-1252", "Windows-1252 (Western European)"),
        ("windows-1251", "Windows-1251 (Cyrillic)"),
        ("shift_jis", "Shift-JIS / CP932 (Japanese)"),
    ];
    let mut encodings = Vec::with_capacity(ENCODINGS.len());
    for (id, label) in ENCODINGS {
        let item = CheckMenuItem::with_id(
            handle,
            format!("encoding_{id}"),
            *label,
            false,
            false,
            None::<&str>,
        )?;
        encodings.push((id.to_string(), item));
    }
    let encoding_menu_items: Vec<&dyn tauri::menu::IsMenuItem<R>> =
        encodings.iter().map(|(_, item)| item as &dyn tauri::menu::IsMenuItem<R>).collect();
    let encoding_menu = Submenu::with_items(handle, "Encoding", true, &encoding_menu_items)?;

    let menu = Menu::with_items(
        handle,
        &[
            &file_menu,
            &edit_menu,
            &view_menu,
            &themes_menu,
            &encoding_menu,
        ],
    )?;

    Ok(BuiltMenu {
        menu,
        word_wrap: view_word_wrap,
        sections_pane: view_toggle_sections,
        themes,
        fonts,
        encodings,
        spell_check: edit_spell_check,
    })
}
