// Thin wrappers around Tauri's invoke/dialog/event APIs so the rest of the
// app depends on a small, typed surface instead of scattering `invoke()`
// calls (and their string command names) throughout the codebase.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { alertMessage } from "./ui/dialogs";

/** Linux's own file-chooser tends to fall back to an unhelpful tmp
 * directory unless given an explicit starting location - default to the
 * user's home folder there (still fully browsable). macOS/Windows already
 * default sensibly (last-used location), so leave them alone. */
function isLinux(): boolean {
  return /linux/i.test(navigator.userAgent);
}

export interface PathMetadata {
  exists: boolean;
  isFile: boolean;
  modifiedMs: number | null;
  size: number | null;
}

export async function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke("write_text_file", { path, contents });
}

export interface DecodedFile {
  contents: string;
  encoding: string;
}

/** Like readTextFile, but detects the file's actual encoding (BOM, plain
 * UTF-8, UTF-16, or a best-effort legacy codepage guess) instead of assuming
 * UTF-8 — see encoding.rs. Used for the user's own documents. */
export async function readTextFileWithEncoding(path: string): Promise<DecodedFile> {
  return invoke<DecodedFile>("read_text_file_detect", { path });
}

/** Like writeTextFile, but encodes `contents` into `encoding`'s on-disk byte
 * format instead of always writing UTF-8. */
export async function writeTextFileWithEncoding(
  path: string,
  contents: string,
  encoding: string,
): Promise<void> {
  return invoke("write_text_file_detect", { path, contents, encoding });
}

export async function createTextFile(path: string): Promise<void> {
  return invoke("create_text_file", { path });
}

export async function pathMetadata(path: string): Promise<PathMetadata> {
  const raw = await invoke<{
    exists: boolean;
    is_file: boolean;
    modified_ms: number | null;
    size: number | null;
  }>("path_metadata", { path });
  return {
    exists: raw.exists,
    isFile: raw.is_file,
    modifiedMs: raw.modified_ms,
    size: raw.size,
  };
}

export async function launchPath(path: string): Promise<void> {
  return invoke("launch_path", { path });
}

export async function appConfigDir(): Promise<string> {
  return invoke<string>("app_config_dir");
}

export async function pathJoin(base: string, name: string): Promise<string> {
  return invoke<string>("path_join", { base, name });
}

export async function watchPath(path: string): Promise<void> {
  return invoke("watch_path", { path });
}

export async function unwatchPath(path: string): Promise<void> {
  return invoke("unwatch_path", { path });
}

export async function setWordWrapChecked(checked: boolean): Promise<void> {
  return invoke("set_word_wrap_checked", { checked });
}

export async function setSectionsPaneChecked(checked: boolean): Promise<void> {
  return invoke("set_sections_pane_checked", { checked });
}

export async function setThemeChecked(id: string): Promise<void> {
  return invoke("set_theme_checked", { id });
}

export async function setFontChecked(id: string): Promise<void> {
  return invoke("set_font_checked", { id });
}

export async function setEncodingChecked(id: string): Promise<void> {
  return invoke("set_encoding_checked", { id });
}

export async function setEncodingMenuEnabled(enabled: boolean): Promise<void> {
  return invoke("set_encoding_menu_enabled", { enabled });
}

export async function setSpellCheckChecked(checked: boolean): Promise<void> {
  return invoke("set_spell_check_checked", { checked });
}

export interface FileEventPayload {
  path: string;
  kind: "modified" | "removed";
}

export function onFileEvent(handler: (payload: FileEventPayload) => void): Promise<UnlistenFn> {
  return listen<FileEventPayload>("sectionist:file-event", (e) => handler(e.payload));
}

export function onMenuAction(handler: (id: string) => void): Promise<UnlistenFn> {
  return listen<string>("sectionist:menu-action", (e) => handler(e.payload));
}

/** A file path forwarded from a second launch attempt (OS file association
 * double-click, or `sectionist <path>` from a shell) while Sectionist was
 * already running — see tauri-plugin-single-instance's callback in lib.rs. */
export function onOpenFileRequest(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>("sectionist:open-file-request", (e) => handler(e.payload));
}

/** A file path passed on Sectionist's own command line at startup (same
 * OS file association / shell-invocation cases as onOpenFileRequest, but for
 * when Sectionist wasn't already running). Returns null if there wasn't
 * one; only returns a given path once, since the backend clears it after
 * handing it over. */
export async function takePendingLaunchFile(): Promise<string | null> {
  return invoke<string | null>("take_pending_launch_file");
}

/** Opens the OS file picker for adding one existing file to a section. */
export async function pickFileToAdd(): Promise<string | null> {
  const result = await openDialog({ multiple: false, directory: false });
  if (!result) return null;
  return Array.isArray(result) ? result[0] ?? null : result;
}

/** Opens the OS save dialog, used by both New File and Save As. */
export async function pickSaveLocation(defaultName?: string): Promise<string | null> {
  let defaultPath = defaultName;
  if (isLinux()) {
    const home = await homeDir();
    defaultPath = defaultName ? await pathJoin(home, defaultName) : home;
  }
  const result = await saveDialog({ defaultPath });
  return result ?? null;
}

export async function showMessage(text: string, title = "Sectionist"): Promise<void> {
  await alertMessage(text, title);
}

export async function showError(text: string, title = "Sectionist"): Promise<void> {
  await alertMessage(text, title);
}
