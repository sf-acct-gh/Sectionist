// Tauri's dialog plugin only exposes native message/confirm/file dialogs —
// there is no native "prompt for text" dialog. Section naming/renaming
// needs one, so this is a small in-app modal (confirms with OK or Enter, as
// AGENTS.md requires).

import { ask } from "@tauri-apps/plugin-dialog";
import type { SectionData } from "../types";

export function promptText(options: {
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const dialog = document.createElement("div");
    dialog.className = "modal-dialog";

    const heading = document.createElement("h2");
    heading.textContent = options.title;

    const label = document.createElement("label");
    label.textContent = options.label;
    label.htmlFor = "modal-text-input";

    const input = document.createElement("input");
    input.type = "text";
    input.id = "modal-text-input";
    input.value = options.initialValue ?? "";

    const buttons = document.createElement("div");
    buttons.className = "modal-buttons";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.className = "secondary";

    const okBtn = document.createElement("button");
    okBtn.textContent = options.confirmLabel ?? "OK";
    okBtn.className = "primary";

    buttons.append(cancelBtn, okBtn);
    dialog.append(heading, label, input, buttons);
    overlay.append(dialog);
    document.body.append(overlay);

    input.focus();
    input.select();

    function close(result: string | null) {
      overlay.remove();
      resolve(result);
    }

    okBtn.addEventListener("click", () => close(input.value.trim() || null));
    cancelBtn.addEventListener("click", () => close(null));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") close(input.value.trim() || null);
      if (e.key === "Escape") close(null);
    });
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(null);
    });
  });
}

export async function confirmAction(
  message: string,
  title = "Sectionist",
  labels?: { okLabel?: string; cancelLabel?: string },
): Promise<boolean> {
  return ask(message, { title, kind: "warning", ...labels });
}

/** Asks where an incoming file should go: an existing section (picked from
 * a dropdown) or a new one. Used by every file-opening entry point (OS file
 * association / single-instance forward, the Open File menu action, and New
 * File) so this choice only has one implementation. */
export function chooseSectionPlacement(
  sections: SectionData[],
): Promise<{ type: "existing"; sectionId: string } | { type: "new" } | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const dialog = document.createElement("div");
    dialog.className = "modal-dialog";

    const heading = document.createElement("h2");
    heading.textContent = "Add File to Section";

    const label = document.createElement("label");
    label.textContent = "Section";
    label.htmlFor = "modal-section-select";

    const select = document.createElement("select");
    select.id = "modal-section-select";
    for (const section of sections) {
      const option = document.createElement("option");
      option.value = section.id;
      option.textContent = section.name;
      select.append(option);
    }

    const buttons = document.createElement("div");
    buttons.className = "modal-buttons";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.className = "secondary";

    const newSectionBtn = document.createElement("button");
    newSectionBtn.textContent = "Create New Section";
    newSectionBtn.className = "secondary";

    const useSelectedBtn = document.createElement("button");
    useSelectedBtn.textContent = "Use Selected Section";
    useSelectedBtn.className = "primary";

    buttons.append(cancelBtn, newSectionBtn, useSelectedBtn);
    dialog.append(heading, label, select, buttons);
    overlay.append(dialog);
    document.body.append(overlay);

    function close(result: { type: "existing"; sectionId: string } | { type: "new" } | null) {
      overlay.remove();
      resolve(result);
    }

    useSelectedBtn.addEventListener("click", () =>
      close({ type: "existing", sectionId: select.value }),
    );
    newSectionBtn.addEventListener("click", () => close({ type: "new" }));
    cancelBtn.addEventListener("click", () => close(null));
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close(null);
    });
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(null);
    });
  });
}
