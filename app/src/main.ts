import "./style.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Store } from "./store";
import { Editor } from "./editor";
import { SectionsPane } from "./ui/sectionsPane";
import { chooseSectionPlacement, promptText } from "./ui/dialogs";
import { openPreferences } from "./ui/preferences";
import {
  onMenuAction,
  onOpenFileRequest,
  pickFileToAdd,
  pickSaveLocation,
  setEncodingChecked,
  setEncodingMenuEnabled,
  setFontChecked,
  setSectionsPaneChecked,
  setSpellCheckChecked,
  setThemeChecked,
  setWordWrapChecked,
  showError,
  takePendingLaunchFile,
} from "./native";
import { displayName, extensionOf, fileName } from "./paths";
import { renderMarkdownToSafeHtml } from "./markdown";
import { applyFont } from "./fonts";
import { applyTheme, getThemeById } from "./theme";
import type { OpenFileState } from "./types";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;

async function main() {
  // Applied before any DOM is built (the store itself has no visual effect
  // until this point) so there's no flash of an unthemed/default-font frame
  // on startup — see theme.ts/fonts.ts for why this is safe with zero
  // hardcoded color/font fallbacks in style.css.
  const store = new Store();
  await store.init();
  applyTheme(getThemeById(store.getTheme()));
  applyFont(store.getEditorFont());

  const app = document.getElementById("app")!;
  app.replaceChildren();

  const layout = document.createElement("div");
  layout.id = "layout";

  const sectionsPaneEl = document.createElement("div");
  sectionsPaneEl.id = "sections-pane";

  const sectionsList = document.createElement("div");
  sectionsList.id = "sections-list";

  const sectionsFooter = document.createElement("div");
  sectionsFooter.id = "sections-footer";
  const hideBtn = document.createElement("button");
  hideBtn.textContent = "Hide";
  const newSectionBtn = document.createElement("button");
  newSectionBtn.textContent = "New Section";
  newSectionBtn.className = "primary";
  sectionsFooter.append(hideBtn, newSectionBtn);

  sectionsPaneEl.append(sectionsList, sectionsFooter);

  const resizer = document.createElement("div");
  resizer.id = "pane-resizer";

  const editorPane = document.createElement("div");
  editorPane.id = "editor-pane";
  const editorHost = document.createElement("div");
  editorHost.id = "editor-host";
  const statusBar = document.createElement("div");
  statusBar.id = "status-bar";
  const statusPath = document.createElement("span");
  statusPath.id = "status-path";
  const statusLines = document.createElement("span");
  statusLines.id = "status-lines";
  statusBar.append(statusPath, statusLines);
  editorPane.append(editorHost, statusBar);

  layout.append(sectionsPaneEl, resizer, editorPane);
  app.append(layout);

  let currentEditorKey: string | null = null;
  // The fileId of whatever is currently mounted in `editor` (if anything),
  // so its cursor/scroll position can be captured right before it's torn
  // down for a different file — see captureViewState below.
  let mountedFileId: string | null = null;
  function captureViewState() {
    if (!mountedFileId) return;
    const viewState = editor.getViewState();
    if (viewState) store.setViewState(mountedFileId, viewState);
  }
  // Local, non-persisted: always resets to "edit" when the active file
  // changes, per the requirement that Plain Text Edit is the default every
  // time a markdown file becomes active.
  let markdownViewMode: "edit" | "rendered" = "edit";
  let markdownViewModeFileId: string | null = null;
  const editor = new Editor(
    editorHost,
    (content) => {
      store.updateActiveFileContent(content);
      updateStatusBar();
    },
    () => updateStatusBar(),
    (encoding) => {
      store.updateActiveFileEncoding(encoding);
      void setEncodingChecked(encoding);
      updateStatusBar();
    },
  );

  const sectionsPane = new SectionsPane(sectionsList, store, (fileId) => {
    void store.setActiveFile(fileId);
  });

  function applyPaneVisibility() {
    const visible = store.isSectionsPaneVisible();
    sectionsPaneEl.style.display = visible ? "" : "none";
    resizer.style.display = visible ? "" : "none";
  }

  function updateStatusBar() {
    const activeId = store.getActiveFileId();
    const open = activeId ? store.getOpenFile(activeId) : undefined;
    if (!open) {
      statusPath.textContent = "";
      statusLines.textContent = "";
      void setEncodingMenuEnabled(false);
      return;
    }
    const ref = activeId ? store.getFileRef(activeId) : undefined;
    // Full path, except for a not-yet-saved virtual buffer, which has no real
    // path yet — open.path there is just its synthetic "unsaved:<id>" key, so
    // it falls back to the same "Unsaved file N" label shown in the sections
    // pane instead.
    statusPath.textContent = ref?.kind === "unsaved" ? displayName(ref) : open.path;
    statusLines.textContent = open.status === "ok" ? `Total Lines: ${editor.lineCount()}` : "";
    void setEncodingMenuEnabled(open.status === "ok");
    void setEncodingChecked(open.encoding);
  }

  function renderEditorArea() {
    const activeId = store.getActiveFileId();
    const open = activeId ? store.getOpenFile(activeId) : undefined;

    if (activeId !== markdownViewModeFileId) {
      markdownViewMode = "edit";
      markdownViewModeFileId = activeId;
    }

    if (!open) {
      captureViewState();
      mountedFileId = null;
      currentEditorKey = null;
      editor.destroy();
      editorHost.replaceChildren(placeholder("Select a file from a section to begin editing."));
      updateStatusBar();
      return;
    }

    const isMarkdown = extensionOf(open.path) === "md";
    const showRendered = isMarkdown && open.status === "ok" && markdownViewMode === "rendered";
    const key = `${open.fileId}:${open.status}:${showRendered ? "rendered" : "edit"}`;

    if (currentEditorKey !== key) {
      captureViewState();
      currentEditorKey = key;
      mountedFileId = open.fileId;
      editor.destroy();

      const banners: HTMLElement[] = [];
      if (open.status === "unavailable" || open.status === "external-change") {
        banners.push(fileIssueBanner(open));
      }
      if (isMarkdown && open.status === "ok") {
        banners.push(markdownToggleBanner());
      }
      editorHost.replaceChildren(...banners);

      if (showRendered) {
        const rendered = document.createElement("div");
        rendered.className = "markdown-rendered";
        rendered.innerHTML = renderMarkdownToSafeHtml(open.content);
        editorHost.append(rendered);
      } else {
        const savedViewState = store.getViewState(open.fileId);
        editor.mount(
          open.content,
          store.getWordWrap(),
          store.getZoom(),
          store.getTabWidth(),
          store.getWrapHangingIndent(),
          open.encoding,
          store.getSpellCheck(),
          {
            readOnly: open.status !== "ok",
            initialCursor: savedViewState?.cursor,
            initialScrollTop: savedViewState?.scrollTop,
          },
        );
      }
    }
    updateStatusBar();
  }

  /** Banner shown above a read-only editor when the active file is either no
   * longer available on disk (deleted/moved/renamed) or was changed by
   * another program. The file stays open (nothing is discarded) so the user
   * can recover it via Reload/Save/Save As, or explicitly Close File. */
  function fileIssueBanner(open: OpenFileState): HTMLElement {
    const banner = document.createElement("div");
    banner.className = "file-issue-banner";

    const text = document.createElement("span");
    text.className = "file-issue-banner-text";

    const buttons: HTMLButtonElement[] = [];

    if (open.status === "external-change") {
      text.textContent = "Detected changes from another editor.";

      const reloadBtn = document.createElement("button");
      reloadBtn.textContent = "Reload";
      reloadBtn.addEventListener("click", () => void handleReload(open.fileId));
      buttons.push(reloadBtn);

      const overwriteBtn = document.createElement("button");
      overwriteBtn.textContent = "Save (overwrite existing)";
      overwriteBtn.addEventListener("click", () => void handleOverwrite(open.fileId));
      buttons.push(overwriteBtn);

      const saveAsBtn = document.createElement("button");
      saveAsBtn.textContent = "Save As";
      saveAsBtn.addEventListener("click", () => void handleUnavailableSaveAs(open.fileId));
      buttons.push(saveAsBtn);

      const closeBtn = document.createElement("button");
      closeBtn.textContent = "Close File";
      closeBtn.addEventListener("click", () => store.closeUnavailableFile(open.fileId));
      buttons.push(closeBtn);
    } else {
      text.textContent = "Detected file is no longer on disk.";

      const saveBtn = document.createElement("button");
      saveBtn.textContent = "Save (original location)";
      saveBtn.addEventListener("click", () => void handleSaveToOriginalLocation(open.fileId));
      buttons.push(saveBtn);

      const saveAsBtn = document.createElement("button");
      saveAsBtn.textContent = "Save As";
      saveAsBtn.addEventListener("click", () => void handleUnavailableSaveAs(open.fileId));
      buttons.push(saveAsBtn);

      const closeBtn = document.createElement("button");
      closeBtn.textContent = "Close File";
      closeBtn.addEventListener("click", () => store.closeUnavailableFile(open.fileId));
      buttons.push(closeBtn);
    }

    banner.append(text, ...buttons);
    return banner;
  }

  /** Banner offering to switch a markdown file between the normal editable
   * CodeMirror view and a read-only rendered HTML view. Always defaults
   * back to Plain Text Edit whenever a different file becomes active (see
   * markdownViewModeFileId reset above), and composes with fileIssueBanner
   * above it when the file also has a status issue. */
  function markdownToggleBanner(): HTMLElement {
    const banner = document.createElement("div");
    banner.className = "file-issue-banner markdown-toggle-banner";

    const text = document.createElement("span");
    text.className = "file-issue-banner-text";
    text.textContent = "Markdown view:";

    const editBtn = document.createElement("button");
    editBtn.textContent = "Plain Text Edit";
    editBtn.className = markdownViewMode === "edit" ? "primary" : "";
    editBtn.addEventListener("click", () => {
      if (markdownViewMode === "edit") return;
      markdownViewMode = "edit";
      currentEditorKey = null;
      scheduleRender();
    });

    const renderedBtn = document.createElement("button");
    renderedBtn.textContent = "Rendered View";
    renderedBtn.className = markdownViewMode === "rendered" ? "primary" : "";
    renderedBtn.addEventListener("click", () => {
      if (markdownViewMode === "rendered") return;
      markdownViewMode = "rendered";
      currentEditorKey = null;
      scheduleRender();
    });

    banner.append(text, editBtn, renderedBtn);
    return banner;
  }

  async function handleUnavailableSaveAs(fileId: string) {
    const open = store.getOpenFile(fileId);
    const target = await pickSaveLocation(open ? fileName(open.path) : undefined);
    if (!target) return;
    const result = await store.saveUnavailableFileAs(fileId, target);
    if (!result.ok) await showError(result.error, "Could Not Save");
  }

  async function handleReload(fileId: string) {
    const result = await store.reloadActiveFileFromDisk(fileId);
    if (!result.ok) await showError(result.error, "Could Not Reload");
  }

  async function handleOverwrite(fileId: string) {
    const result = await store.overwriteExternalChangeFile(fileId);
    if (!result.ok) await showError(result.error, "Could Not Save");
  }

  async function handleSaveToOriginalLocation(fileId: string) {
    const result = await store.saveUnavailableFileToOriginalLocation(fileId);
    if (!result.ok) await showError(result.error, "Could Not Save");
  }

  function placeholder(text: string): HTMLElement {
    const div = document.createElement("div");
    div.className = "editor-placeholder";
    div.textContent = text;
    return div;
  }

  let renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => {
      renderScheduled = false;
      sectionsPane.render();
      applyPaneVisibility();
      renderEditorArea();
    });
  }

  store.subscribe(scheduleRender);
  scheduleRender();

  // ---- section pane footer / resizing ----------------------------------

  hideBtn.addEventListener("click", () => {
    store.setSectionsPaneVisible(false);
    void setSectionsPaneChecked(false);
  });

  newSectionBtn.addEventListener("click", async () => {
    const name = await promptText({ title: "New Section", label: "Section name" });
    if (name) store.createSection(name);
  });

  sectionsPaneEl.style.width = `${store.getSectionsPaneWidth()}px`;
  let resizing = false;
  function stopResizing() {
    if (!resizing) return;
    resizing = false;
    document.body.style.cursor = "";
    store.setSectionsPaneWidth(sectionsPaneEl.getBoundingClientRect().width);
  }
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizing = true;
    document.body.style.cursor = "col-resize";
    resizer.setPointerCapture(e.pointerId);
  });
  resizer.addEventListener("pointermove", (e) => {
    if (!resizing) return;
    const width = Math.min(600, Math.max(160, e.clientX));
    sectionsPaneEl.style.width = `${width}px`;
  });
  resizer.addEventListener("pointerup", stopResizing);
  resizer.addEventListener("pointercancel", stopResizing);
  window.addEventListener("blur", stopResizing);

  // ---- file operations ---------------------------------------------------

  /** Prompts for a save location for an "Unsaved file N" buffer and writes
   * it there for the first time — used by both Save and Save As for these
   * buffers, since neither has a prior disk location to fall back to (see
   * Store.promoteUnsavedFileToPath). */
  async function handleSaveUnsavedBuffer(fileId: string) {
    const ref = store.getFileRef(fileId);
    const suggestedName = ref ? `${displayName(ref)}.txt` : undefined;
    const target = await pickSaveLocation(suggestedName);
    if (!target) return;
    const result = await store.promoteUnsavedFileToPath(fileId, target);
    if (!result.ok) await showError(result.error, "Could Not Save");
  }

  async function handleSave() {
    const activeId = store.getActiveFileId();
    const open = activeId ? store.getOpenFile(activeId) : undefined;
    if (open?.isUnsaved) {
      await handleSaveUnsavedBuffer(open.fileId);
      return;
    }
    const result = await store.saveActiveFile();
    if (!result.ok) await showError(result.error, "Could Not Save");
  }

  async function handleSaveAs() {
    const activeId = store.getActiveFileId();
    const open = activeId ? store.getOpenFile(activeId) : undefined;
    if (!open || open.status !== "ok") {
      await showError("Open a file before using Save As.", "Save As");
      return;
    }
    if (open.isUnsaved) {
      await handleSaveUnsavedBuffer(open.fileId);
      return;
    }
    const target = await pickSaveLocation(fileName(open.path));
    if (!target) return;
    const result = await store.saveActiveFileAs(target);
    if (!result.ok) {
      await showError(result.error, "Could Not Save");
    }
  }

  /** Prompts for which section a new file reference should land in: skips
   * straight to "create a section" when none exist yet, otherwise asks
   * whether to use an existing section or create a new one. Returns null if
   * the user cancels at any step. Shared by handleIncomingFilePath and
   * handleNewFile. */
  async function chooseSectionForNewFile(): Promise<string | null> {
    const sections = store.getSections();
    if (sections.length === 0) {
      const name = await promptText({ title: "New Section", label: "Section name" });
      if (!name) return null;
      return store.createSection(name).id;
    }
    const choice = await chooseSectionPlacement(sections);
    if (!choice) return null;
    if (choice.type === "existing") return choice.sectionId;
    const name = await promptText({ title: "New Section", label: "Section name" });
    if (!name) return null;
    return store.createSection(name).id;
  }

  /** File > New / Ctrl+N and the section header's "New file" button both
   * create a Notepad++-style in-memory "Unsaved file N" buffer (see
   * Store.createUnsavedFileInSection) instead of immediately writing to
   * disk — nothing is created on disk until Save/Save As. */
  async function handleNewFile() {
    const sectionId = await chooseSectionForNewFile();
    if (!sectionId) return;
    store.createUnsavedFileInSection(sectionId);
  }

  async function handleOpenFile() {
    const target = await pickFileToAdd();
    if (!target) return;
    await handleIncomingFilePath(target);
  }

  /** Shared placement flow for every way an existing file can arrive in
   * Sectionist: the Open File menu action, and an OS file association /
   * single-instance forward. Cancel at any step leaves Sectionist untouched.
   * `Store.addFileToSection` already only activates the file when it's plain
   * text/Markdown, so no extra active-file logic is needed here. */
  async function handleIncomingFilePath(path: string) {
    const sectionId = await chooseSectionForNewFile();
    if (!sectionId) return;
    store.addFileToSection(sectionId, path);
  }

  // ---- menu / keyboard action dispatch --------------------------------
  //
  // Native OS menu accelerators are unreliable on Windows (WebView2 claims
  // some Ctrl-combos for its own defaults, e.g. Ctrl+P opening print, before
  // the accelerator table sees them), so `menu.rs` no longer registers any
  // accelerators. Shortcuts for menu-only actions are instead handled here,
  // directly in the frontend, identically on every platform. Undo/Redo/Cut/
  // Copy/Paste/Find/Replace are deliberately NOT handled here: CodeMirror's
  // own internal keymap (editor.ts) already handles all of those reliably
  // whenever the editor has focus, and duplicating them here would risk a
  // double-fire (e.g. undo running twice per keypress).
  async function runAction(id: string) {
    switch (id) {
      case "file_new":
        await handleNewFile();
        break;
      case "file_open":
        await handleOpenFile();
        break;
      case "file_save":
        await handleSave();
        break;
      case "file_save_as":
        await handleSaveAs();
        break;
      case "file_exit":
        await getCurrentWindow().close();
        break;
      case "edit_undo":
        editor.undo();
        break;
      case "edit_redo":
        editor.redo();
        break;
      case "edit_cut":
        editor.cut();
        break;
      case "edit_copy":
        editor.copy();
        break;
      case "edit_paste":
        editor.paste();
        break;
      case "edit_find":
        editor.openFind();
        break;
      case "edit_replace":
        editor.openReplace();
        break;
      case "edit_spell_check": {
        const next = !store.getSpellCheck();
        store.setSpellCheck(next);
        editor.setSpellCheck(next);
        void setSpellCheckChecked(next);
        break;
      }
      case "encoding_utf8":
      case "encoding_utf8-bom":
      case "encoding_utf16le":
      case "encoding_utf16be":
      case "encoding_windows-1252":
      case "encoding_windows-1251":
      case "encoding_shift_jis": {
        const encodingId = id.slice("encoding_".length);
        editor.setEncoding(encodingId);
        void setEncodingChecked(encodingId);
        break;
      }
      case "edit_preferences": {
        const result = await openPreferences({
          tabWidth: store.getTabWidth(),
          wrapHangingIndent: store.getWrapHangingIndent(),
        });
        if (result) {
          store.setTabWidth(result.tabWidth);
          store.setWrapHangingIndent(result.wrapHangingIndent);
          editor.setTabWidth(result.tabWidth);
          editor.setWrapHangingIndent(result.wrapHangingIndent);
        }
        break;
      }
      case "view_word_wrap": {
        const next = !store.getWordWrap();
        store.setWordWrap(next);
        editor.setWordWrap(next);
        void setWordWrapChecked(next);
        break;
      }
      case "view_zoom_in": {
        const next = Math.min(ZOOM_MAX, round1(store.getZoom() + ZOOM_STEP));
        store.setZoom(next);
        editor.setZoom(next);
        break;
      }
      case "view_zoom_out": {
        const next = Math.max(ZOOM_MIN, round1(store.getZoom() - ZOOM_STEP));
        store.setZoom(next);
        editor.setZoom(next);
        break;
      }
      case "view_zoom_reset": {
        store.setZoom(1);
        editor.setZoom(1);
        break;
      }
      case "view_toggle_sections": {
        const next = !store.isSectionsPaneVisible();
        store.setSectionsPaneVisible(next);
        void setSectionsPaneChecked(next);
        break;
      }
      case "view_collapse_all":
        store.collapseAllSections();
        break;
      case "view_expand_all":
        store.expandAllSections();
        break;
      case "view_font_default":
      case "view_font_times":
      case "view_font_courier":
      case "view_font_georgia":
      case "view_font_arial":
      case "view_font_verdana":
      case "view_font_consolas":
      case "view_font_wide-mono":
      case "view_font_wider-mono": {
        const fontId = id.slice("view_font_".length);
        store.setEditorFont(fontId);
        applyFont(fontId);
        editor.refreshFontMetrics();
        void setFontChecked(fontId);
        break;
      }
      case "theme_light":
      case "theme_dark":
      case "theme_programmer":
      case "theme_vscode": {
        const themeId = id.slice("theme_".length);
        store.setTheme(themeId);
        applyTheme(getThemeById(themeId));
        void setThemeChecked(themeId);
        break;
      }
    }
  }

  await onMenuAction(async (id) => {
    await runAction(id);
  });

  // A file passed via OS file association / `sectionist <path>` while
  // Sectionist was already running arrives as an event (single-instance
  // forward); one passed at startup is fetched once, here, after this
  // listener is registered, to avoid racing the backend's own emit — see
  // lib.rs's PendingLaunchFile for why it isn't just emitted directly.
  await onOpenFileRequest(async (path) => {
    await handleIncomingFilePath(path);
  });
  const pendingLaunchFile = await takePendingLaunchFile();
  if (pendingLaunchFile) {
    await handleIncomingFilePath(pendingLaunchFile);
  }

  // Maps a keydown event to a menu-only action id, or null if this key
  // combo isn't one of ours (e.g. it's a CodeMirror-handled shortcut, or an
  // unrelated key entirely).
  function keyboardActionId(e: KeyboardEvent): string | null {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
    const key = e.key;
    if (e.shiftKey) {
      if (key.toLowerCase() === "s") return "file_save_as";
      return null;
    }
    switch (key) {
      case "n":
      case "N":
        return "file_new";
      case "o":
      case "O":
        return "file_open";
      case "s":
      case "S":
        return "file_save";
      case "q":
      case "Q":
        return "file_exit";
      case "=":
      case "+":
        return "view_zoom_in";
      case "-":
        return "view_zoom_out";
      case "0":
        return "view_zoom_reset";
      case "b":
      case "B":
        return "view_toggle_sections";
      case "p":
      case "P":
        return "edit_preferences";
      case "[":
        return "view_collapse_all";
      case "]":
        return "view_expand_all";
      default:
        return null;
    }
  }

  window.addEventListener("keydown", (e) => {
    const id = keyboardActionId(e);
    if (!id) return;
    e.preventDefault();
    void runAction(id);
  });

  // Keep the native menu checkboxes in sync with restored persisted state.
  void setWordWrapChecked(store.getWordWrap());
  void setSectionsPaneChecked(store.isSectionsPaneVisible());
  void setThemeChecked(store.getTheme());
  void setFontChecked(store.getEditorFont());
  void setSpellCheckChecked(store.getSpellCheck());

  // ---- shutdown: flush any pending recovery/state writes ----------------
  //
  // beforeunload can't delay window teardown for async work, so a save it
  // merely kicks off (fire-and-forget) can lose the race with the webview
  // closing — e.g. quitting right after the very first view of a file, with
  // no earlier file-switch already having flushed a write. onCloseRequested
  // lets us await the flush first, but its "close anyway if you don't call
  // preventDefault" behavior only fires if our handler resolves without
  // throwing — Tauri's own close-request/plugin interaction is known to be
  // flaky (e.g. tauri-apps/tauri#12334), and if the flush ever throws or
  // hangs, that implicit auto-close never happens and the window becomes
  // permanently unclosable. So preventDefault is called unconditionally, and
  // the window is destroyed explicitly in a `finally`, guaranteeing the
  // close always goes through no matter what happens during the flush.
  let closing = false;
  await getCurrentWindow().onCloseRequested(async (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    try {
      captureViewState();
      await Promise.race([
        store.flushPersistence(),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch (e) {
      console.error("Failed to flush state before closing:", e);
    } finally {
      try {
        await getCurrentWindow().destroy();
      } catch (e) {
        console.error("Failed to destroy window on close:", e);
      }
    }
  });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

void main();
