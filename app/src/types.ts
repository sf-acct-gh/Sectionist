// Core data types shared across the frontend.

/** How a file reference is treated: edited in Sectionist, launched externally,
 * or an in-memory buffer with no disk file yet (Notepad++-style "unsaved
 * file"; see store.ts's createUnsavedFileInSection). */
export type FileKind = "editable" | "launchable" | "unsaved";

export interface FileRef {
  /** Canonical identity used for de-duplication and lookups; see paths.ts.
   * For an "unsaved" file this is a synthetic `unsaved:<uuid>` key, never
   * passed to pathMetadata/readTextFile/watchPath. */
  id: string;
  /** The path as it should be displayed/used for OS operations. Equal to
   * `id` for an "unsaved" file, since it has no real path yet. */
  path: string;
  kind: FileKind;
  /** Set only when kind === "unsaved": the N in "Unsaved file N", so the
   * label survives a reload without re-deriving it. */
  unsavedNumber?: number;
}

export interface SectionData {
  id: string;
  name: string;
  expanded: boolean;
  files: FileRef[];
}

export interface PersistedState {
  version: 1;
  sections: SectionData[];
  activeFileId: string | null;
  sectionsPaneVisible: boolean;
  sectionsPaneWidth: number;
  wordWrap: boolean;
  zoom: number;
  /** Id of the active theme (see theme.ts); "light" on first run. */
  theme: string;
  /** Id of the active editor font (see fonts.ts); "default" (OS default) on first run. */
  editorFont: string;
  /** Visual width (in columns) of a tab character in the editor; 4 on first run. */
  tabWidth: number;
  /** Whether wrapped lines hang-indent under their own text start (Notepad++-style
   * "Line Wrap"); true on first run. Independent of wordWrap itself. */
  wrapHangingIndent: boolean;
  /** Last-known cursor position and scroll offset per file (keyed by fileId),
   * so reopening or switching back to a file restores where the user left
   * off instead of always landing at the top. Empty on first run; entries
   * are only added/updated as files are viewed, and are never required to be
   * present (see store.ts's getViewState). */
  viewState: Record<string, FileViewState>;
  /** Edit > Spell Check; the custom in-app spellchecker on the editor
   * surface (see spellcheck/engine.ts) — not the webview's native
   * spellcheck, which is always force-disabled on the editor (see
   * disableNativeSpellCheck in editor.ts). false on first run. */
  spellCheck: boolean;
}

/** A single file's remembered cursor/scroll position. `cursor` is a plain
 * character offset into the document (EditorState.selection.main.head) —
 * stable across sessions since it doesn't depend on line-wrapping or font
 * metrics the way a visual row/column would. `scrollTop` is the editor
 * scroller's raw pixel scrollTop. */
export interface FileViewState {
  cursor: number;
  scrollTop: number;
}

/** Runtime status of a file that has been opened at least once this session. */
export type FileStatus = "ok" | "unavailable" | "external-change";

export interface OpenFileState {
  fileId: string;
  path: string;
  /** Current in-memory buffer contents. */
  content: string;
  /** Contents as last read from or written to disk (for dirty comparison). */
  diskContent: string;
  dirty: boolean;
  status: FileStatus;
  /** Encoding id (see encoding.rs: "utf8", "utf8-bom", "utf16le", "utf16be",
   * or an encoding_rs codepage name like "windows-1252") the in-memory
   * buffer is currently set to save as. */
  encoding: string;
  /** Encoding last confirmed on disk (mirrors diskContent) — a change here
   * that hasn't been saved yet also makes the file dirty. */
  savedEncoding: string;
  /** True for a Notepad++-style "Unsaved file N" buffer with no disk file
   * yet (see FileKind). Save/Save As always prompt for a location for these. */
  isUnsaved: boolean;
}

export interface RecoveryEntry {
  path: string;
  content: string;
  encoding: string;
}

export type RecoveryData = Record<string, RecoveryEntry>;

export function defaultState(): PersistedState {
  return {
    version: 1,
    sections: [],
    activeFileId: null,
    sectionsPaneVisible: true,
    sectionsPaneWidth: 280,
    wordWrap: true,
    zoom: 1,
    theme: "light",
    editorFont: "default",
    tabWidth: 4,
    wrapHangingIndent: true,
    viewState: {},
    spellCheck: false,
  };
}
