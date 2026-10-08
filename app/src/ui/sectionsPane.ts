// Renders the left section browser and wires up its interactions:
// section CRUD, expand/collapse, in-app drag-and-drop (section reordering
// and moving files between sections), and per-file actions.

import type { Store } from "../store";
import type { FileRef, SectionData } from "../types";
import { confirmAction, promptText } from "./dialogs";
import { pickFilesToAdd, launchPath, showError } from "../native";
import { displayName } from "../paths";

const SECTION_DRAG_MIME = "application/x-sectionist-section";
const FILE_DRAG_MIME = "application/x-sectionist-file";

export class SectionsPane {
  constructor(
    private readonly container: HTMLElement,
    private readonly store: Store,
    private readonly onSelectFile: (fileId: string) => void,
  ) {}

  render(): void {
    this.container.replaceChildren();
    const sections = this.store.getSections();

    for (const section of sections) {
      this.container.append(this.renderSection(section));
    }

    // A drop target after the last section lets the user drag a section to
    // the very end of the list.
    const tail = document.createElement("div");
    tail.className = "section-list-tail";
    tail.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes(SECTION_DRAG_MIME)) e.preventDefault();
    });
    tail.addEventListener("drop", (e) => {
      const draggedId = e.dataTransfer?.getData(SECTION_DRAG_MIME);
      if (!draggedId) return;
      const order = sections.map((s) => s.id).filter((id) => id !== draggedId);
      order.push(draggedId);
      this.store.reorderSections(order);
    });
    this.container.append(tail);
  }

  private renderSection(section: SectionData): HTMLElement {
    const root = document.createElement("div");
    root.className = "section";
    root.dataset.sectionId = section.id;

    const header = document.createElement("div");
    header.className = "section-header";
    header.draggable = true;

    const disclosure = document.createElement("button");
    disclosure.className = "icon-btn disclosure";
    disclosure.textContent = section.expanded ? "▾" : "▸";
    disclosure.title = section.expanded ? "Collapse" : "Expand";
    disclosure.draggable = false;
    disclosure.addEventListener("click", () => this.store.toggleExpanded(section.id));

    const name = document.createElement("span");
    name.className = "section-name";
    name.textContent = section.name;

    const renameBtn = this.iconButton("✎", "Rename section", async () => {
      const newName = await promptText({
        title: "Rename Section",
        label: "Section name",
        initialValue: section.name,
        confirmLabel: "OK",
      });
      if (newName) this.store.renameSection(section.id, newName);
    });

    const closeBtn = this.iconButton("✕", "Close section", async () => {
      const dirtyFiles = section.files.filter((f) => this.store.getOpenFile(f.id)?.dirty);
      if (dirtyFiles.length > 0) {
        // Distinguished because the consequence differs: an edited-but-real
        // file keeps its last-saved disk copy, while a never-saved "Unsaved
        // file N" buffer has no disk copy at all to fall back to.
        const editedFiles = dirtyFiles.filter((f) => f.kind !== "unsaved");
        const neverSavedFiles = dirtyFiles.filter((f) => f.kind === "unsaved");

        const parts: string[] = [];
        if (editedFiles.length > 0) {
          const names = editedFiles.map((f) => displayName(f)).join(", ");
          parts.push(
            `Closing this section will discard unsaved edits in: ${names}. The files will remain on disk without any of the changes you've made.`,
          );
        }
        if (neverSavedFiles.length > 0) {
          const names = neverSavedFiles.map((f) => displayName(f)).join(", ");
          parts.push(
            `Closing this section will discard and remove from disk the following files created in Sectionist: ${names}.`,
          );
        }
        parts.push("Would you like to close this section anyway?");

        const proceed = await confirmAction(
          parts.join("\n\n"),
          "Unsaved Changes",
          { okLabel: "Close Anyway", cancelLabel: "Keep Section Open" },
        );
        if (!proceed) return;
      } else {
        // The [x] sits right next to the section header and is easy to
        // click by accident, so always confirm even when nothing is dirty.
        const proceed = await confirmAction(
          `Close section "${section.name}"? Its files will not be deleted from disk.`,
          "Close Section",
        );
        if (!proceed) return;
      }
      this.store.closeSection(section.id);
    });

    // Creates a Notepad++-style in-memory "Unsaved file N" buffer directly
    // in this section — no file picker, unlike addBtn (see
    // Store.createUnsavedFileInSection).
    const newFileBtn = this.iconButton("❐", "New file", () => {
      this.store.createUnsavedFileInSection(section.id);
    });

    const addBtn = this.iconButton("+", "Add file", async () => {
      const paths = await pickFilesToAdd();
      // Selecting a single file keeps the existing behavior of switching
      // focus to it. Selecting several at once leaves the active file
      // alone instead of jumping once per added file.
      const activate = paths.length === 1;
      for (const path of paths) {
        this.store.addFileToSection(section.id, path, activate);
      }
    });

    header.append(disclosure, name, renameBtn, closeBtn, newFileBtn, addBtn);
    root.append(header);

    this.wireSectionDrag(header, root, section.id);

    if (section.expanded) {
      const body = document.createElement("div");
      body.className = "section-body";

      const editable = this.store.editableFiles(section);
      for (const file of editable) {
        body.append(this.renderFileRow(section, file, false));
      }

      // Non-editable ("launchable") files are listed in the same file list,
      // alphabetically, below all editable files — distinguished only by
      // blue text rather than a separate labeled area, to conserve space.
      const launchable = this.store.launchableFiles(section);
      for (const file of launchable) {
        body.append(this.renderFileRow(section, file, true));
      }

      this.wireFileDropTarget(body, section.id);
      root.append(body);
    } else {
      this.wireFileDropTarget(root, section.id);
    }

    return root;
  }

  private renderFileRow(section: SectionData, file: FileRef, launchable: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "file-row";
    row.draggable = true;
    row.dataset.fileId = file.id;

    const label = document.createElement("span");
    label.className = "file-name";
    label.textContent = displayName(file);
    label.title = file.kind === "unsaved" ? displayName(file) : file.path;

    if (!launchable) {
      const open = this.store.getOpenFile(file.id);
      const isActive = this.store.getActiveFileId() === file.id;
      if (isActive) label.classList.add("active");
      if (open?.dirty) label.classList.add("dirty");
      if (open && open.status !== "ok") label.classList.add("file-issue");
      label.addEventListener("click", () => this.onSelectFile(file.id));
    } else {
      label.classList.add("launchable");
      if (this.store.isLaunchableFileUnavailable(file.id)) label.classList.add("file-issue");
      label.title = `${file.path}\n(opens in the default system application)`;
      label.addEventListener("click", async () => {
        try {
          await launchPath(file.path);
        } catch (e) {
          await showError(String(e));
        }
      });
    }

    const removeBtn = this.iconButton("✕", "Remove from section", async () => {
      const open = this.store.getOpenFile(file.id);
      if (open?.dirty) {
        // If another section still references this same file, removing it
        // here doesn't discard anything — the file stays open, dirty, and
        // editable there (mirrors the stillReferenced check in
        // Store.removeFileFromSection/closeSection), so the warning should
        // say so instead of implying data loss.
        const openElsewhere = this.store
          .getSections()
          .some((s) => s.id !== section.id && s.files.some((f) => f.id === file.id));

        const proceed = openElsewhere
          ? await confirmAction(
              `"${label.textContent}" has unsaved changes. However, this file is currently open in another section. Closing this file will leave the file open for edits in the other section. Continue?`,
              "Unsaved Changes",
            )
          : await confirmAction(
              `"${label.textContent}" has unsaved changes. Removing it from this section will discard the unsaved edits (the file on disk will not be modified). Continue?`,
              "Unsaved Changes",
              { okLabel: "Close Anyway", cancelLabel: "Leave File" },
            );
        if (!proceed) return;
      }
      this.store.removeFileFromSection(section.id, file.id);
    });

    row.append(label, removeBtn);

    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData(FILE_DRAG_MIME, JSON.stringify({ fileId: file.id, fromSectionId: section.id }));
      e.dataTransfer!.effectAllowed = "move";
    });

    return row;
  }

  private wireFileDropTarget(el: HTMLElement, sectionId: string): void {
    el.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes(FILE_DRAG_MIME)) {
        e.preventDefault();
        el.classList.add("drop-target");
      }
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
    el.addEventListener("drop", (e) => {
      el.classList.remove("drop-target");
      const raw = e.dataTransfer?.getData(FILE_DRAG_MIME);
      if (!raw) return;
      e.preventDefault();
      const { fileId, fromSectionId } = JSON.parse(raw) as { fileId: string; fromSectionId: string };
      this.store.moveFileBetweenSections(fileId, fromSectionId, sectionId);
    });
  }

  private wireSectionDrag(header: HTMLElement, root: HTMLElement, sectionId: string): void {
    header.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData(SECTION_DRAG_MIME, sectionId);
      e.dataTransfer!.effectAllowed = "move";
    });
    root.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(SECTION_DRAG_MIME)) return;
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      root.classList.toggle("drop-before", before);
      root.classList.toggle("drop-after", !before);
    });
    root.addEventListener("dragleave", () => {
      root.classList.remove("drop-before", "drop-after");
    });
    root.addEventListener("drop", (e) => {
      const draggedId = e.dataTransfer?.getData(SECTION_DRAG_MIME);
      root.classList.remove("drop-before", "drop-after");
      if (!draggedId || draggedId === sectionId) return;
      e.preventDefault();

      const rect = root.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      const ids = this.store.getSections().map((s) => s.id).filter((id) => id !== draggedId);
      const targetIndex = ids.indexOf(sectionId);
      const insertAt = before ? targetIndex : targetIndex + 1;
      ids.splice(insertAt, 0, draggedId);
      this.store.reorderSections(ids);
    });
  }

  private iconButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "icon-btn";
    btn.textContent = label;
    btn.title = title;
    btn.draggable = false;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }
}
