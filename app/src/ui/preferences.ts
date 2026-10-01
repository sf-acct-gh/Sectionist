// Text-editor Preferences window (Edit menu). A plain in-app modal, matching
// the pattern used by promptText/chooseSectionPlacement in dialogs.ts — Tauri's
// dialog plugin has no native "settings form" dialog.

export interface EditorPreferences {
  tabWidth: number;
  wrapHangingIndent: boolean;
}

// Labeled as relative sizes rather than exact character counts: the actual
// on-screen width is measured per-font in pixels (see editor.ts's
// measureSpaceWidthPx), and that measurement can vary slightly by font/
// platform in ways users can visibly notice — so promising "exactly 4
// characters" overstates a precision the rendering can't always guarantee,
// where "smaller / medium / larger amount of space" does not.
const TAB_WIDTH_CHOICES: Array<{ value: number; label: string }> = [
  { value: 2, label: "Small" },
  { value: 4, label: "Medium" },
  { value: 8, label: "Large" },
];

const DEFAULT_PREFERENCES: EditorPreferences = { tabWidth: 4, wrapHangingIndent: true };

export function openPreferences(current: EditorPreferences): Promise<EditorPreferences | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const dialog = document.createElement("div");
    dialog.className = "modal-dialog";

    const heading = document.createElement("h2");
    heading.textContent = "Preferences";

    const tabWidthLabel = document.createElement("label");
    tabWidthLabel.textContent = "Tab width";
    tabWidthLabel.htmlFor = "prefs-tab-width";

    const tabWidthSelect = document.createElement("select");
    tabWidthSelect.id = "prefs-tab-width";
    for (const choice of TAB_WIDTH_CHOICES) {
      const option = document.createElement("option");
      option.value = String(choice.value);
      option.textContent = choice.label;
      if (choice.value === current.tabWidth) option.selected = true;
      tabWidthSelect.append(option);
    }

    const hangingIndentRow = document.createElement("label");
    hangingIndentRow.className = "modal-checkbox-row";

    const hangingIndentCheckbox = document.createElement("input");
    hangingIndentCheckbox.type = "checkbox";
    hangingIndentCheckbox.id = "prefs-wrap-hanging-indent";
    hangingIndentCheckbox.checked = current.wrapHangingIndent;

    hangingIndentRow.append(
      hangingIndentCheckbox,
      document.createTextNode(" Indent wrapped lines under their own text (Line Wrap)"),
    );

    const buttons = document.createElement("div");
    buttons.className = "modal-buttons";

    const resetBtn = document.createElement("button");
    resetBtn.textContent = "Reset to Defaults";
    resetBtn.className = "secondary reset";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.className = "secondary";

    const okBtn = document.createElement("button");
    okBtn.textContent = "OK";
    okBtn.className = "primary";

    resetBtn.addEventListener("click", () => {
      tabWidthSelect.value = String(DEFAULT_PREFERENCES.tabWidth);
      hangingIndentCheckbox.checked = DEFAULT_PREFERENCES.wrapHangingIndent;
    });

    buttons.append(resetBtn, cancelBtn, okBtn);
    dialog.append(heading, tabWidthLabel, tabWidthSelect, hangingIndentRow, buttons);
    overlay.append(dialog);
    document.body.append(overlay);

    function close(result: EditorPreferences | null) {
      overlay.remove();
      resolve(result);
    }

    okBtn.addEventListener("click", () =>
      close({
        tabWidth: Number(tabWidthSelect.value),
        wrapHangingIndent: hangingIndentCheckbox.checked,
      }),
    );
    cancelBtn.addEventListener("click", () => close(null));
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close(null);
    });
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(null);
    });
  });
}
