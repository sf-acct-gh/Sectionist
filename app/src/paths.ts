// Path helpers. Sectionist deals with paths from arbitrary locations on
// disk (Windows or Linux), so identity comparisons need to be forgiving of
// separator style and platform case-sensitivity without mutating the path
// used for actual file operations.

import type { FileRef } from "./types";

/** Key used for de-duplication/lookup only; never used for file I/O. */
export function canonicalKey(path: string): string {
  const normalizedSeparators = path.replace(/\\/g, "/");
  // Windows paths are case-insensitive in practice; lower-casing the key
  // avoids spurious duplicates like "C:/Notes.txt" vs "c:/notes.txt". This
  // only affects the identity key, never the displayed/stored path.
  return normalizedSeparators.toLowerCase();
}

export function fileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

export function extensionOf(path: string): string {
  const name = fileName(path);
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx + 1).toLowerCase();
}

// Extensions known to be a binary/media/document format the OS should open
// in whatever app owns it, rather than something Sectionist should attempt
// to decode as text. Everything NOT in this list is attempted as text: on
// success it opens normally regardless of extension (.log, .csv, .json,
// .ini, unfamiliar extensions, etc. all work), and on failure the user sees
// a clear "Unsupported Encoding" alert instead of the file silently doing
// nothing (see Store.addFileToSection). An allowlist of just "editable"
// extensions used to gate this instead, which meant any file the user
// explicitly chose to add that wasn't .txt/.md went silently unopened with
// no feedback at all.
const NON_TEXT_EXTENSIONS = new Set([
  // Images
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "tif", "svg", "heic", "heif",
  // Audio/video
  "mp3", "wav", "flac", "ogg", "m4a", "aac", "mp4", "mov", "avi", "mkv", "webm", "wmv",
  // Documents/archives
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz",
  // Executables/installers/fonts
  "exe", "msi", "dmg", "app", "appimage", "deb", "rpm", "dll", "so", "dylib",
  "ttf", "otf", "woff", "woff2",
]);

export function isEditableExtension(path: string): boolean {
  return !NON_TEXT_EXTENSIONS.has(extensionOf(path));
}

/** Display label for a file reference: its filename, or "Unsaved file N"
 * for a not-yet-saved virtual buffer that has no real path yet (see
 * FileKind). */
export function displayName(ref: FileRef): string {
  return ref.kind === "unsaved" ? `Unsaved file ${ref.unsavedNumber}` : fileName(ref.path);
}
