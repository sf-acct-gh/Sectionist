// Central application state: sections, open files, and their runtime
// status. This module owns all mutations and persistence side effects; the
// UI layer only reads from it and calls its methods.

import { Debouncer } from "./debounce";
import {
  onFileEvent,
  pathMetadata,
  readTextFileWithEncoding,
  showError,
  unwatchPath,
  watchPath,
  writeTextFileWithEncoding,
} from "./native";
import { canonicalKey, displayName, fileName, isEditableExtension } from "./paths";
import { loadRecovery, loadState, saveRecovery, saveState } from "./persistence";
import type {
  FileRef,
  FileViewState,
  OpenFileState,
  PersistedState,
  RecoveryData,
  SectionData,
} from "./types";

const STATE_SAVE_DELAY_MS = 400;
const RECOVERY_SAVE_DELAY_MS = 1500;

type Listener = () => void;

export class Store {
  private state: PersistedState = {
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

  private openFiles = new Map<string, OpenFileState>();
  // Launchable files (non-editable, e.g. images/PDFs) have no editor buffer
  // and are never "open" in the OpenFileState sense, but their availability
  // on disk is still tracked so the section browser can flag one in red
  // when it disappears, the same way an editable file would be. Holds the
  // fileIds currently known to be missing; absence from this set means
  // available (or not yet checked).
  private unavailableLaunchableFiles = new Set<string>();
  private recovery: RecoveryData = {};
  // Every path currently being watched for external changes. Unlike the
  // active file alone, *every* file with status "ok" is watched, so a file
  // changed externally while the user has a different file focused is still
  // caught — its status flips immediately, and (per openFileForEditing's
  // short-circuit) the banner shows as soon as the user switches back to it.
  private watchedPaths = new Set<string>();
  private listeners = new Set<Listener>();

  private readonly stateSaver = new Debouncer(STATE_SAVE_DELAY_MS);
  private readonly recoverySaver = new Debouncer(RECOVERY_SAVE_DELAY_MS);

  async init(): Promise<void> {
    this.state = await loadState();
    this.recovery = await loadRecovery();

    // Hydrate runtime status for every file with a pending recovery buffer
    // so unsaved indicators are correct immediately at startup, without
    // waiting for the user to click into each file.
    for (const [fileId, entry] of Object.entries(this.recovery)) {
      // An "Unsaved file N" buffer has no disk path — its recovery entry is
      // its only persisted content, so it never touches pathMetadata/the
      // watcher, and stays dirty until Save/Save As promotes it (see
      // createUnsavedFileInSection/promoteUnsavedFileToPath).
      if (this.findFileRef(fileId)?.kind === "unsaved") {
        this.openFiles.set(fileId, {
          fileId,
          path: entry.path,
          content: entry.content,
          diskContent: "",
          dirty: true,
          status: "ok",
          encoding: entry.encoding,
          savedEncoding: entry.encoding,
          isUnsaved: true,
        });
        continue;
      }

      const meta = await pathMetadata(entry.path);
      this.openFiles.set(fileId, {
        fileId,
        path: entry.path,
        content: entry.content,
        diskContent: entry.content,
        dirty: true,
        status: meta.exists ? "ok" : "unavailable",
        encoding: entry.encoding,
        savedEncoding: entry.encoding,
        isUnsaved: false,
      });
      if (meta.exists) this.startWatching(entry.path);
    }

    // Launchable files have no recovery entries (nothing to recover — they
    // aren't edited), so their initial availability has to be checked
    // directly against disk here instead.
    for (const section of this.state.sections) {
      for (const file of section.files) {
        if (file.kind !== "launchable") continue;
        const meta = await pathMetadata(file.path);
        if (meta.exists) {
          this.startWatching(file.path);
        } else {
          this.unavailableLaunchableFiles.add(file.id);
        }
      }
    }

    await onFileEvent((payload) => this.handleFileEvent(payload));

    if (this.state.activeFileId) {
      await this.openFileForEditing(this.state.activeFileId, false);
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  // ---- persistence ----------------------------------------------------

  private persistState(): void {
    this.stateSaver.schedule(() => saveState(this.state));
  }

  private persistRecovery(): void {
    this.recoverySaver.schedule(() => saveRecovery(this.recovery));
  }

  /** Force any pending debounced writes out immediately, and wait for the
   * writes themselves to finish (used on quit) — flushing the debouncer only
   * kicks the save off; without awaiting it here, the window could close
   * before the disk write actually completes. */
  async flushPersistence(): Promise<void> {
    await Promise.all([this.stateSaver.flush(), this.recoverySaver.flush()]);
  }

  // ---- read accessors ---------------------------------------------------

  getSections(): SectionData[] {
    return this.state.sections;
  }

  getSection(id: string): SectionData | undefined {
    return this.state.sections.find((s) => s.id === id);
  }

  getActiveFileId(): string | null {
    return this.state.activeFileId;
  }

  getOpenFile(fileId: string): OpenFileState | undefined {
    return this.openFiles.get(fileId);
  }

  /** True if a launchable (non-editable) file has been detected as missing
   * from disk. Launchable files are never edited or made active, so this is
   * the only status they track — used to show the same red file-issue
   * indicator an editable file gets when it's no longer available. */
  isLaunchableFileUnavailable(fileId: string): boolean {
    return this.unavailableLaunchableFiles.has(fileId);
  }

  isSectionsPaneVisible(): boolean {
    return this.state.sectionsPaneVisible;
  }

  getSectionsPaneWidth(): number {
    return this.state.sectionsPaneWidth;
  }

  getWordWrap(): boolean {
    return this.state.wordWrap;
  }

  getSpellCheck(): boolean {
    return this.state.spellCheck;
  }

  getZoom(): number {
    return this.state.zoom;
  }

  getTheme(): string {
    return this.state.theme;
  }

  getEditorFont(): string {
    return this.state.editorFont;
  }

  /** Editable files in a section (including not-yet-saved "unsaved" buffers,
   * which are edited the same way — see FileKind), alphabetical by display
   * name. */
  editableFiles(section: SectionData): FileRef[] {
    return section.files
      .filter((f) => f.kind === "editable" || f.kind === "unsaved")
      .sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { sensitivity: "base" }));
  }

  /** Launchable (non-editor) files in a section, alphabetical by filename. */
  launchableFiles(section: SectionData): FileRef[] {
    return section.files
      .filter((f) => f.kind === "launchable")
      .sort((a, b) => fileName(a.path).localeCompare(fileName(b.path), undefined, { sensitivity: "base" }));
  }

  // ---- sections ----------------------------------------------------------

  createSection(name: string): SectionData {
    const section: SectionData = {
      id: crypto.randomUUID(),
      name,
      expanded: true,
      files: [],
    };
    this.state.sections.push(section);
    this.persistState();
    this.notify();
    return section;
  }

  renameSection(id: string, name: string): void {
    const section = this.getSection(id);
    if (!section) return;
    section.name = name;
    this.persistState();
    this.notify();
  }

  /** Closes a section: removes it and its file references only. Never
   * touches anything on disk. */
  closeSection(id: string): void {
    const section = this.getSection(id);
    if (!section) return;

    // A file can be referenced by more than one section (dedup by path in
    // addFileToSection); only forget its open/recovery/watch state once no
    // other surviving section still references it, so it stays open there
    // untouched. Mirrors the stillReferenced check in removeFileFromSection.
    for (const file of section.files) {
      const stillReferenced = this.state.sections.some(
        (s) => s.id !== id && s.files.some((f) => f.id === file.id),
      );
      if (stillReferenced) continue;
      if (file.kind === "launchable") {
        this.forgetLaunchableFile(file.id, file.path);
      } else {
        this.forgetOpenFile(file.id);
      }
    }
    this.state.sections = this.state.sections.filter((s) => s.id !== id);
    this.persistState();
    this.persistRecovery();
    this.notify();
  }

  toggleExpanded(id: string): void {
    const section = this.getSection(id);
    if (!section) return;
    section.expanded = !section.expanded;
    this.persistState();
    this.notify();
  }

  expandAllSections(): void {
    for (const section of this.state.sections) section.expanded = true;
    this.persistState();
    this.notify();
  }

  collapseAllSections(): void {
    for (const section of this.state.sections) section.expanded = false;
    this.persistState();
    this.notify();
  }

  reorderSections(orderedIds: string[]): void {
    const byId = new Map(this.state.sections.map((s) => [s.id, s]));
    const reordered = orderedIds.map((id) => byId.get(id)).filter((s): s is SectionData => !!s);
    if (reordered.length !== this.state.sections.length) return; // safety: malformed order, ignore
    this.state.sections = reordered;
    this.persistState();
    this.notify();
  }

  // ---- files ----------------------------------------------------------

  /** Adds an existing file (chosen via picker or drag-and-drop) to a
   * section. Returns the resulting reference, which may be a pre-existing
   * one if this path was already present in the section.
   *
   * `activate` defaults to true (the normal single-file behavior: an
   * editable file becomes active immediately). Pass false when adding
   * several files at once via a multi-select picker, so focus stays on
   * whatever was already active instead of jumping around once per file. */
  addFileToSection(sectionId: string, path: string, activate = true): FileRef | null {
    const section = this.getSection(sectionId);
    if (!section) return null;

    const id = canonicalKey(path);
    const existing = section.files.find((f) => f.id === id);
    if (existing) {
      if (activate && existing.kind === "editable") {
        void this.setActiveFile(existing.id);
      }
      return existing;
    }

    const ref: FileRef = {
      id,
      path,
      kind: isEditableExtension(path) ? "editable" : "launchable",
    };
    section.files.push(ref);
    this.persistState();
    if (activate && ref.kind === "editable") {
      void this.setActiveFile(ref.id);
    } else {
      this.startWatching(path);
      this.notify();
    }
    return ref;
  }

  /** Removes a file from a section (not from disk). If it was the active
   * file, automatically activates a replacement (see
   * findReplacementActiveFileId) rather than leaving the closed file's
   * buffer on screen or falling back to the empty editor placeholder while
   * another eligible file still exists. */
  removeFileFromSection(sectionId: string, fileId: string): void {
    const section = this.getSection(sectionId);
    if (!section) return;

    const removedRef = section.files.find((f) => f.id === fileId);
    const wasActive = this.state.activeFileId === fileId;
    // Captured before mutating section.files: this is what lets the
    // replacement search find the closed file's neighbors within the
    // section it was closed from.
    const originalEditable = this.editableFiles(section);

    section.files = section.files.filter((f) => f.id !== fileId);

    // Only forget the open-file/recovery state if no other section still
    // references the same path.
    const stillReferenced = this.state.sections.some((s) => s.files.some((f) => f.id === fileId));
    if (!stillReferenced) {
      if (removedRef?.kind === "launchable") {
        this.forgetLaunchableFile(fileId, removedRef.path);
      } else {
        this.forgetOpenFile(fileId);
      }
    }

    this.persistState();
    this.persistRecovery();

    if (wasActive) {
      const replacementId = this.findReplacementActiveFileId(sectionId, fileId, originalEditable);
      void this.setActiveFile(replacementId);
    } else {
      this.notify();
    }
  }

  /** Finds the file that should become active after the currently active
   * file (`excludeFileId`) is closed from `originSectionId`, per this
   * precedence:
   * 1. The next eligible file below it in the same section.
   * 2. If none, the next eligible file above it in the same section.
   * 3. If none, the first eligible file in each following section, top to
   *    bottom, checking sections in order below `originSectionId`.
   * 4. If none, the last eligible file in each preceding section, checking
   *    sections in order above `originSectionId` (nearest first).
   * Returns null only if no eligible file exists anywhere. `originalEditable`
   * is the origin section's editable file list captured *before* the closed
   * file was removed from it, so its neighbors can still be located.
   * "Eligible" means an editable (text/Markdown) FileRef other than
   * `excludeFileId` itself — never a launchable file, and never the file
   * being closed, even if that same file is still referenced by another
   * section. */
  private findReplacementActiveFileId(
    originSectionId: string,
    excludeFileId: string,
    originalEditable: FileRef[],
  ): string | null {
    const closedIndex = originalEditable.findIndex((f) => f.id === excludeFileId);
    if (closedIndex !== -1) {
      for (let i = closedIndex + 1; i < originalEditable.length; i++) {
        if (originalEditable[i].id !== excludeFileId) return originalEditable[i].id;
      }
      for (let i = closedIndex - 1; i >= 0; i--) {
        if (originalEditable[i].id !== excludeFileId) return originalEditable[i].id;
      }
    }

    const sections = this.state.sections;
    const originIndex = sections.findIndex((s) => s.id === originSectionId);

    for (let i = originIndex === -1 ? 0 : originIndex + 1; i < sections.length; i++) {
      const candidate = this.editableFiles(sections[i]).find((f) => f.id !== excludeFileId);
      if (candidate) return candidate.id;
    }

    if (originIndex !== -1) {
      for (let i = originIndex - 1; i >= 0; i--) {
        const editable = this.editableFiles(sections[i]).filter((f) => f.id !== excludeFileId);
        if (editable.length > 0) return editable[editable.length - 1].id;
      }
    }

    return null;
  }

  /** Moves a file reference from one section to another without touching
   * the file on disk. No-ops if the destination already has it. */
  moveFileBetweenSections(fileId: string, fromSectionId: string, toSectionId: string): void {
    if (fromSectionId === toSectionId) return;
    const from = this.getSection(fromSectionId);
    const to = this.getSection(toSectionId);
    if (!from || !to) return;

    const ref = from.files.find((f) => f.id === fileId);
    if (!ref) return;
    if (to.files.some((f) => f.id === fileId)) {
      // Already present in destination; just drop it from the source.
      from.files = from.files.filter((f) => f.id !== fileId);
      this.persistState();
      this.notify();
      return;
    }

    from.files = from.files.filter((f) => f.id !== fileId);
    to.files.push(ref);
    this.persistState();
    this.notify();
  }

  private forgetOpenFile(fileId: string): void {
    const open = this.openFiles.get(fileId);
    if (open) this.stopWatching(open.path);
    this.openFiles.delete(fileId);
    delete this.recovery[fileId];
    delete this.state.viewState[fileId];
    if (this.state.activeFileId === fileId) {
      this.state.activeFileId = null;
    }
  }

  private forgetLaunchableFile(fileId: string, path: string): void {
    this.stopWatching(path);
    this.unavailableLaunchableFiles.delete(fileId);
  }

  private startWatching(path: string): void {
    if (this.watchedPaths.has(path)) return;
    this.watchedPaths.add(path);
    void watchPath(path);
  }

  private stopWatching(path: string): void {
    if (!this.watchedPaths.has(path)) return;
    this.watchedPaths.delete(path);
    void unwatchPath(path);
  }

  // ---- active file / editing -------------------------------------------

  async setActiveFile(fileId: string | null): Promise<OpenFileState | null> {
    const previousActiveFileId = this.state.activeFileId;
    this.state.activeFileId = fileId;
    this.persistState();

    if (!fileId) {
      this.notify();
      return null;
    }

    const opened = await this.openFileForEditing(fileId);
    if (!opened) {
      // A brand-new file failed to decode and was rolled back entirely (see
      // openFileForEditing) — restore whatever was active before this
      // attempt instead of leaving activeFileId pointing at a file that no
      // longer exists in any section.
      this.state.activeFileId = previousActiveFileId;
      this.persistState();
      this.notify();
      return null;
    }
    this.notify();
    return opened;
  }

  /** Loads (or refreshes) a file's content and availability status. Uses a
   * recovered unsaved buffer instead of disk content when one exists.
   * Returns null if a brand-new file (one that was never successfully
   * opened and has no pending recovery buffer to protect) turned out to be
   * undecodable — the caller must then treat the file as if it was never
   * added at all (see setActiveFile). `allowRollback` is false only for the
   * startup restore path (init()), where a decode failure means a
   * previously-established file went bad while the app was closed — that
   * should surface as the usual "file issue" banner, not vanish from its
   * section, since the user never just "added" it this session. */
  private async openFileForEditing(
    fileId: string,
    allowRollback = true,
  ): Promise<OpenFileState | null> {
    const existing = this.openFiles.get(fileId);
    if (existing && (existing.status === "unavailable" || existing.status === "external-change")) {
      // Once flagged broken, stay flagged — even across switching to another
      // file and back — until the user explicitly resolves it via the "file
      // issue" banner's Save As or Close File. Re-probing disk here would
      // risk silently reverting the status (e.g. "external-change" back to
      // "ok" just because the file still exists) without the user ever
      // seeing the banner.
      return existing;
    }
    // An "Unsaved file N" buffer has no disk path to read — its in-memory
    // OpenFileState (hydrated from recovery.json at startup, or created
    // directly by createUnsavedFileInSection) is already everything there
    // is.
    if (existing?.isUnsaved) {
      return existing;
    }

    const ref = this.findFileRef(fileId);
    const path = ref?.path ?? this.openFiles.get(fileId)?.path;
    if (!path) {
      const missing: OpenFileState = {
        fileId,
        path: "",
        content: "",
        diskContent: "",
        dirty: false,
        status: "unavailable",
        encoding: "utf8",
        savedEncoding: "utf8",
        isUnsaved: false,
      };
      this.openFiles.set(fileId, missing);
      return missing;
    }

    const meta = await pathMetadata(path);
    if (!meta.exists || !meta.isFile) {
      this.stopWatching(path);
      const state: OpenFileState = {
        fileId,
        path,
        content: existing?.content ?? "",
        diskContent: existing?.diskContent ?? "",
        dirty: existing?.dirty ?? false,
        status: "unavailable",
        encoding: existing?.encoding ?? "utf8",
        savedEncoding: existing?.savedEncoding ?? "utf8",
        isUnsaved: false,
      };
      this.openFiles.set(fileId, state);
      return state;
    }

    const recovered = this.recovery[fileId];
    let diskContent: string;
    let diskEncoding: string;
    try {
      const decoded = await readTextFileWithEncoding(path);
      diskContent = decoded.contents;
      diskEncoding = decoded.encoding;
    } catch (e) {
      this.stopWatching(path);
      await showError(String(e), "Unsupported Encoding");

      if (allowRollback && !existing && !recovered) {
        // A file the user just added has never been successfully opened and
        // has no unsaved edits to protect — remove it entirely rather than
        // leaving a permanently-broken entry behind (it can never decode
        // successfully later, since its on-disk bytes aren't changing).
        for (const section of this.state.sections) {
          section.files = section.files.filter((f) => f.id !== fileId);
        }
        this.openFiles.delete(fileId);
        this.persistState();
        return null;
      }

      const state: OpenFileState = {
        fileId,
        path,
        content: recovered?.content ?? "",
        diskContent: "",
        dirty: !!recovered,
        status: "unavailable",
        encoding: recovered?.encoding ?? "utf8",
        savedEncoding: "utf8",
        isUnsaved: false,
      };
      this.openFiles.set(fileId, state);
      return state;
    }

    let content: string;
    let encoding: string;
    let dirty: boolean;
    if (recovered && (recovered.content !== diskContent || recovered.encoding !== diskEncoding)) {
      content = recovered.content;
      encoding = recovered.encoding;
      dirty = true;
    } else {
      content = diskContent;
      encoding = diskEncoding;
      dirty = false;
      if (recovered) delete this.recovery[fileId]; // recovery matched disk; nothing to protect
    }

    const state: OpenFileState = {
      fileId,
      path,
      content,
      diskContent,
      dirty,
      status: "ok",
      encoding,
      savedEncoding: diskEncoding,
      isUnsaved: false,
    };
    this.openFiles.set(fileId, state);
    this.startWatching(path);

    return state;
  }

  /** Called by the editor on every content change for the active file. */
  updateActiveFileContent(newContent: string): void {
    const fileId = this.state.activeFileId;
    if (!fileId) return;
    const open = this.openFiles.get(fileId);
    if (!open || open.status !== "ok") return;

    open.content = newContent;
    open.dirty = open.isUnsaved || newContent !== open.diskContent || open.encoding !== open.savedEncoding;

    if (open.dirty) {
      this.recovery[fileId] = { path: open.path, content: newContent, encoding: open.encoding };
    } else {
      delete this.recovery[fileId];
    }
    this.persistRecovery();
    this.notify();
  }

  /** Called by the editor whenever the active file's encoding changes (menu
   * selection, or an undo/redo crossing an encoding-change point — see
   * editor.ts's onEncodingChange). Mirrors updateActiveFileContent's dirty
   * tracking, since a pending encoding change is exactly as "unsaved" as a
   * pending content change. */
  updateActiveFileEncoding(encoding: string): void {
    const fileId = this.state.activeFileId;
    if (!fileId) return;
    const open = this.openFiles.get(fileId);
    if (!open || open.status !== "ok") return;

    open.encoding = encoding;
    open.dirty = open.isUnsaved || open.content !== open.diskContent || open.encoding !== open.savedEncoding;

    if (open.dirty) {
      this.recovery[fileId] = { path: open.path, content: open.content, encoding: open.encoding };
    } else {
      delete this.recovery[fileId];
    }
    this.persistRecovery();
    this.notify();
  }

  async saveActiveFile(): Promise<{ ok: true } | { ok: false; error: string }> {
    const fileId = this.state.activeFileId;
    if (!fileId) return { ok: false, error: "No file is open." };
    const open = this.openFiles.get(fileId);
    if (!open || open.status !== "ok") {
      return { ok: false, error: "This file cannot be saved right now." };
    }
    if (open.isUnsaved) {
      // Not-yet-saved "Unsaved file N" buffers have no disk path — the
      // caller (main.ts) must route Save/Save As through
      // promoteUnsavedFileToPath instead, which prompts for a location.
      return { ok: false, error: "This file has not been saved yet." };
    }

    try {
      await writeTextFileWithEncoding(open.path, open.content, open.encoding);
    } catch (e) {
      return { ok: false, error: String(e) };
    }

    open.diskContent = open.content;
    open.savedEncoding = open.encoding;
    open.dirty = false;
    delete this.recovery[fileId];
    this.persistRecovery();
    this.notify();
    return { ok: true };
  }

  /** Save As: writes the active buffer's content to a new location, adds the
   * new file to every section the original file was in (the original stays
   * put, it is not removed or replaced), and makes the new file active. */
  async saveActiveFileAs(newPath: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const fileId = this.state.activeFileId;
    const open = fileId ? this.openFiles.get(fileId) : undefined;
    const content = open?.content ?? "";
    const encoding = open?.encoding ?? "utf8";
    try {
      await writeTextFileWithEncoding(newPath, content, encoding);
    } catch (e) {
      return { ok: false, error: String(e) };
    }

    const newId = canonicalKey(newPath);
    if (fileId) {
      for (const section of this.state.sections) {
        const hasOriginal = section.files.some((f) => f.id === fileId);
        if (hasOriginal && !section.files.some((f) => f.id === newId)) {
          section.files.push({ id: newId, path: newPath, kind: "editable" });
        }
      }
    }

    this.openFiles.set(newId, {
      fileId: newId,
      path: newPath,
      content,
      diskContent: content,
      dirty: false,
      status: "ok",
      encoding,
      savedEncoding: encoding,
      isUnsaved: false,
    });
    this.startWatching(newPath);
    this.state.activeFileId = newId;

    this.persistState();
    this.persistRecovery();
    this.notify();
    return { ok: true };
  }

  /** Returns the next "Unsaved file N" number app-wide — restarts at 1 once
   * no unsaved buffer remains anywhere, per the Notepad++-style numbering
   * this feature is modeled on. */
  private nextUnsavedNumber(): number {
    let max = 0;
    for (const section of this.state.sections) {
      for (const file of section.files) {
        if (file.kind === "unsaved" && file.unsavedNumber !== undefined) {
          max = Math.max(max, file.unsavedNumber);
        }
      }
    }
    return max + 1;
  }

  /** Creates a new in-memory "Unsaved file N" buffer directly in the given
   * section (the new section-header button; see ui/sectionsPane.ts) and
   * activates it. Nothing touches disk until Save/Save As, which routes
   * through promoteUnsavedFileToPath instead of the normal save path. */
  createUnsavedFileInSection(sectionId: string): FileRef | null {
    const section = this.getSection(sectionId);
    if (!section) return null;

    const unsavedNumber = this.nextUnsavedNumber();
    const id = `unsaved:${crypto.randomUUID()}`;
    const ref: FileRef = { id, path: id, kind: "unsaved", unsavedNumber };
    section.files.push(ref);

    const open: OpenFileState = {
      fileId: id,
      path: id,
      content: "",
      diskContent: "",
      dirty: true,
      status: "ok",
      encoding: "utf8",
      savedEncoding: "utf8",
      isUnsaved: true,
    };
    this.openFiles.set(id, open);
    this.recovery[id] = { path: id, content: "", encoding: "utf8" };

    this.persistState();
    this.persistRecovery();
    void this.setActiveFile(id);
    return ref;
  }

  /** Writes an "Unsaved file N" buffer's content to a real disk path for the
   * first time, replacing its synthetic FileRef in place (splice, not push,
   * to preserve position) in every section that contains it — unlike
   * saveActiveFileAs, there is no "original" file left behind, since the
   * unsaved buffer never had a real location to begin with. */
  async promoteUnsavedFileToPath(
    fileId: string,
    newPath: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const open = this.openFiles.get(fileId);
    if (!open) return { ok: false, error: "This file is no longer open." };

    try {
      await writeTextFileWithEncoding(newPath, open.content, open.encoding);
    } catch (e) {
      return { ok: false, error: String(e) };
    }

    const newId = canonicalKey(newPath);
    for (const section of this.state.sections) {
      const idx = section.files.findIndex((f) => f.id === fileId);
      if (idx === -1) continue;
      if (section.files.some((f) => f.id === newId)) {
        section.files.splice(idx, 1);
      } else {
        section.files[idx] = { id: newId, path: newPath, kind: "editable" };
      }
    }

    this.openFiles.delete(fileId);
    delete this.recovery[fileId];
    this.openFiles.set(newId, {
      fileId: newId,
      path: newPath,
      content: open.content,
      diskContent: open.content,
      dirty: false,
      status: "ok",
      encoding: open.encoding,
      savedEncoding: open.encoding,
      isUnsaved: false,
    });
    this.startWatching(newPath);

    if (this.state.activeFileId === fileId) {
      this.state.activeFileId = newId;
    }

    this.persistState();
    this.persistRecovery();
    this.notify();
    return { ok: true };
  }

  private findFileRef(fileId: string): FileRef | undefined {
    for (const section of this.state.sections) {
      const found = section.files.find((f) => f.id === fileId);
      if (found) return found;
    }
    return undefined;
  }

  /** Public lookup of a file's reference (for its kind/unsavedNumber/display
   * name) by id — see paths.ts's displayName. */
  getFileRef(fileId: string): FileRef | undefined {
    return this.findFileRef(fileId);
  }

  // ---- view settings ----------------------------------------------------

  setSectionsPaneVisible(visible: boolean): void {
    this.state.sectionsPaneVisible = visible;
    this.persistState();
    this.notify();
  }

  setSectionsPaneWidth(width: number): void {
    this.state.sectionsPaneWidth = width;
    this.persistState();
  }

  setWordWrap(enabled: boolean): void {
    this.state.wordWrap = enabled;
    this.persistState();
    this.notify();
  }

  setSpellCheck(enabled: boolean): void {
    this.state.spellCheck = enabled;
    this.persistState();
    this.notify();
  }

  setZoom(zoom: number): void {
    this.state.zoom = zoom;
    this.persistState();
    this.notify();
  }

  setTheme(id: string): void {
    this.state.theme = id;
    this.persistState();
    this.notify();
  }

  setEditorFont(id: string): void {
    this.state.editorFont = id;
    this.persistState();
    this.notify();
  }

  getTabWidth(): number {
    return this.state.tabWidth;
  }

  setTabWidth(width: number): void {
    this.state.tabWidth = width;
    this.persistState();
    this.notify();
  }

  getWrapHangingIndent(): boolean {
    return this.state.wrapHangingIndent;
  }

  setWrapHangingIndent(enabled: boolean): void {
    this.state.wrapHangingIndent = enabled;
    this.persistState();
    this.notify();
  }

  /** Last-known cursor/scroll position for a file, or undefined if it's
   * never been viewed (or was viewed before this feature existed). */
  getViewState(fileId: string): FileViewState | undefined {
    return this.state.viewState[fileId];
  }

  /** Records where the user left off in a file. Deliberately does not call
   * notify(): this has no effect on anything currently rendered (it only
   * matters the next time this file is opened), so broadcasting a change
   * here would just trigger pointless re-renders on every scroll/cursor
   * move. */
  setViewState(fileId: string, viewState: FileViewState): void {
    this.state.viewState[fileId] = viewState;
    this.persistState();
  }

  // ---- external change / availability -----------------------------------

  private handleFileEvent(payload: { path: string; kind: "modified" | "removed" }): void {
    // Every "ok" open file is watched, not just the active one (see
    // watchedPaths), so this must find and flag whichever open file the
    // event is about — the file may not be active right now, and should
    // still show its banner once the user switches back to it.
    const fileId = canonicalKey(payload.path);
    const open = this.openFiles.get(fileId);
    if (open && open.status === "ok") {
      open.status = payload.kind === "removed" ? "unavailable" : "external-change";
      this.stopWatching(open.path);
      this.notify();
      return;
    }

    // Launchable files have no editable status to flip, only a red
    // file-issue indicator for the section browser when they disappear —
    // their content changing externally isn't Sectionist's concern.
    if (payload.kind === "removed" && this.findFileRef(fileId)?.kind === "launchable") {
      this.unavailableLaunchableFiles.add(fileId);
      this.stopWatching(payload.path);
      this.notify();
    }
  }

  /** User closed a file from the "no longer available" / "changed
   * externally" banner. Unlike a normal remove-from-section (which only
   * affects the section it was removed from), this drops the reference from
   * every section it appears in, since the file itself is the problem, not
   * any one section's copy of it. If it was the active file, automatically
   * activates a replacement per the same precedence as
   * removeFileFromSection, using the first section that contained it (in
   * display order) as the search's point of origin. */
  closeUnavailableFile(fileId: string): void {
    const wasActive = this.state.activeFileId === fileId;
    let originSectionId = "";
    let originalEditable: FileRef[] = [];
    if (wasActive) {
      const origin = this.state.sections.find((s) => s.files.some((f) => f.id === fileId));
      if (origin) {
        originSectionId = origin.id;
        originalEditable = this.editableFiles(origin);
      }
    }

    for (const section of this.state.sections) {
      section.files = section.files.filter((f) => f.id !== fileId);
    }
    this.forgetOpenFile(fileId);
    this.persistState();
    this.persistRecovery();

    if (wasActive) {
      const replacementId = this.findReplacementActiveFileId(originSectionId, fileId, originalEditable);
      void this.setActiveFile(replacementId);
    } else {
      this.notify();
    }
  }

  /** User used "Save As" from the "no longer available" / "changed
   * externally" banner to write the buffer Sectionist remembers to a new
   * location. The new path replaces the old (broken) reference everywhere it
   * appeared, becomes the active file, and resumes normal watching/editing. */
  async saveUnavailableFileAs(
    fileId: string,
    newPath: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const open = this.openFiles.get(fileId);
    if (!open) return { ok: false, error: "This file is no longer open." };

    try {
      await writeTextFileWithEncoding(newPath, open.content, open.encoding);
    } catch (e) {
      return { ok: false, error: String(e) };
    }

    const newId = canonicalKey(newPath);
    for (const section of this.state.sections) {
      const idx = section.files.findIndex((f) => f.id === fileId);
      if (idx === -1) continue;
      if (section.files.some((f) => f.id === newId)) {
        // The new location is already referenced in this section; don't add a duplicate.
        section.files.splice(idx, 1);
      } else {
        section.files[idx] = { id: newId, path: newPath, kind: "editable" };
      }
    }

    this.openFiles.delete(fileId);
    delete this.recovery[fileId];
    this.openFiles.set(newId, {
      fileId: newId,
      path: newPath,
      content: open.content,
      diskContent: open.content,
      dirty: false,
      status: "ok",
      encoding: open.encoding,
      savedEncoding: open.encoding,
      isUnsaved: false,
    });
    this.startWatching(newPath);

    if (this.state.activeFileId === fileId) {
      this.state.activeFileId = newId;
    }

    this.persistState();
    this.persistRecovery();
    this.notify();
    return { ok: true };
  }

  /** User clicked "Reload" on the "changed by another editor" banner:
   * discards the in-memory buffer and re-reads the file fresh from disk,
   * resuming normal editing. If the file is no longer there by the time this
   * runs, the status naturally becomes "unavailable" instead, and the
   * banner swaps itself accordingly. */
  async reloadActiveFileFromDisk(fileId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const open = this.openFiles.get(fileId);
    if (!open) return { ok: false, error: "This file is no longer open." };

    const meta = await pathMetadata(open.path);
    if (!meta.exists || !meta.isFile) {
      open.status = "unavailable";
      this.notify();
      return { ok: false, error: "This file is no longer on disk." };
    }

    let content: string;
    let encoding: string;
    try {
      const decoded = await readTextFileWithEncoding(open.path);
      content = decoded.contents;
      encoding = decoded.encoding;
    } catch (e) {
      open.status = "unavailable";
      this.notify();
      return { ok: false, error: String(e) };
    }

    open.content = content;
    open.diskContent = content;
    open.encoding = encoding;
    open.savedEncoding = encoding;
    open.dirty = false;
    open.status = "ok";
    delete this.recovery[fileId];
    this.persistRecovery();
    this.startWatching(open.path);
    this.notify();
    return { ok: true };
  }

  /** User clicked "Save (overwrite existing)" on the "changed by another
   * editor" banner: writes Sectionist's in-memory buffer over the
   * externally changed file, deliberately discarding the other program's
   * changes — the user has already been warned by the banner. */
  async overwriteExternalChangeFile(fileId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const open = this.openFiles.get(fileId);
    if (!open) return { ok: false, error: "This file is no longer open." };

    try {
      await writeTextFileWithEncoding(open.path, open.content, open.encoding);
    } catch (e) {
      return { ok: false, error: String(e) };
    }

    open.diskContent = open.content;
    open.savedEncoding = open.encoding;
    open.dirty = false;
    open.status = "ok";
    delete this.recovery[fileId];
    this.persistRecovery();
    this.startWatching(open.path);
    this.notify();
    return { ok: true };
  }

  /** User clicked "Save (original location)" on the "no longer on disk"
   * banner: recreates the file at its original path from the buffer
   * Sectionist remembers. Unlike Save As, the path/identity doesn't change,
   * so section references don't need updating. */
  async saveUnavailableFileToOriginalLocation(
    fileId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const open = this.openFiles.get(fileId);
    if (!open) return { ok: false, error: "This file is no longer open." };

    try {
      await writeTextFileWithEncoding(open.path, open.content, open.encoding);
    } catch (e) {
      return { ok: false, error: String(e) };
    }

    open.diskContent = open.content;
    open.savedEncoding = open.encoding;
    open.dirty = false;
    open.status = "ok";
    delete this.recovery[fileId];
    this.persistRecovery();
    this.startWatching(open.path);
    this.notify();
    return { ok: true };
  }
}
