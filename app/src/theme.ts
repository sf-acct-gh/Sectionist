// Theme loading, validation, and application.
//
// Every theme is a single self-contained JSON file (app/src/themes/*.json) —
// none of them borrow values from another, so a new theme can be added
// purely by dropping in a file matching this schema, with no code changes.
// This module is also where a future user-supplied themes folder would plug
// in: it would just call validateTheme/applyTheme on JSON read from disk
// instead of a bundled import.

import lightThemeJson from "./themes/light.json";
import darkThemeJson from "./themes/dark.json";
import programmerThemeJson from "./themes/programmer.json";
import vscodeThemeJson from "./themes/vscode.json";

export interface Theme {
  id: string;
  name: string;
  scheme: "light" | "dark";
  colors: Record<string, string>;
}

/** Every CSS custom property a theme file must define. Kept in one place so
 * "a theme is fully self-contained" is an enforced rule, not a convention —
 * an incomplete theme is rejected outright rather than partially applied. */
export const REQUIRED_COLOR_KEYS = [
  "text",
  "text-muted",
  "bg",
  "pane-bg",
  "border",
  "accent",
  "active-file",
  "dirty",
  "file-issue",
  "launch",
  "drop-target-bg",
  /** Focused text-selection highlight in the editor (see colorTheme() in
   * editor.ts). Deliberately separate from "drop-target-bg": that variable
   * is tuned to be a faint hover/drop indicator, too weak to read as a
   * confident selection highlight, and reusing it also collided with a
   * higher-specificity built-in CodeMirror rule that otherwise always wins
   * while the editor is focused (hard-coding a pale lavender regardless of
   * theme) — see colorTheme()'s focused-selection selector for why two
   * separate selectors matter here. */
  "editor-selection-bg",
  "readonly-bg",
  "readonly-gutter-bg",
  "warning-bg",
  "warning-border",
  /** Color of the plain-text editor's own content (see colorTheme() in
   * editor.ts). Kept separate from "text" (used for surrounding chrome —
   * dialogs, the section list, etc.) so a theme like Programmer can give the
   * editing surface its signature accent color without recoloring every
   * other piece of text in the app to match. */
  "editor-text",
] as const;

export function validateTheme(input: unknown): Theme | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.id !== "string" || candidate.id.trim() === "") return null;
  if (typeof candidate.name !== "string" || candidate.name.trim() === "") return null;
  if (candidate.scheme !== "light" && candidate.scheme !== "dark") return null;
  if (!candidate.colors || typeof candidate.colors !== "object") return null;

  const colors = candidate.colors as Record<string, unknown>;
  for (const key of REQUIRED_COLOR_KEYS) {
    if (typeof colors[key] !== "string" || (colors[key] as string).trim() === "") return null;
  }

  return {
    id: candidate.id,
    name: candidate.name,
    scheme: candidate.scheme,
    colors: colors as Record<string, string>,
  };
}

/** Applies a theme to the document. Invalid input is rejected entirely
 * (logged, nothing changed) rather than partially applied, so a malformed
 * theme file can never leave some variables set from the new theme and some
 * from whatever was active before — the concrete guard against ending up
 * with unset variables and invisible/unreadable text. */
export function applyTheme(input: unknown): boolean {
  const theme = validateTheme(input);
  if (!theme) {
    console.warn("Ignored invalid theme (missing or malformed fields):", input);
    return false;
  }

  const root = document.documentElement;
  for (const key of REQUIRED_COLOR_KEYS) {
    root.style.setProperty(`--${key}`, theme.colors[key]);
  }
  root.style.colorScheme = theme.scheme;
  return true;
}

function loadBuiltin(json: unknown): Theme {
  const theme = validateTheme(json);
  if (!theme) throw new Error("Built-in theme file failed validation");
  return theme;
}

export const BUILTIN_THEMES: Theme[] = [
  loadBuiltin(lightThemeJson),
  loadBuiltin(darkThemeJson),
  loadBuiltin(programmerThemeJson),
  loadBuiltin(vscodeThemeJson),
];

export const DEFAULT_THEME_ID = "light";

export function getThemeById(id: string): Theme {
  return BUILTIN_THEMES.find((t) => t.id === id) ?? loadBuiltin(lightThemeJson);
}
