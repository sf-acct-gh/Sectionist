// Editor font selection: a small fixed list of font-family stacks applied to
// the plain-text editing surface (CodeMirror's .cm-scroller, see editor.ts)
// via the --editor-font CSS custom property. Every stack ends in a generic
// CSS family keyword (serif/monospace/sans-serif) so a missing named font
// (e.g. Times New Roman isn't installed on many Linux distros) still falls
// back to a same-category, readable substitute rather than an arbitrary one.

export interface FontOption {
  id: string;
  label: string;
  /** null = no override, falling back to the editor theme's own hardcoded
   * "monospace" keyword (see fontSizeTheme in editor.ts). Only ever used by
   * "default" historically — but a bare, single generic keyword (as opposed
   * to every other option's multi-name stack) turned out to be an unreliable
   * choice on at least one Linux/WebKitGTK setup, where selecting it caused
   * visibly jumpy/bouncing text that no other font option reproduced. Kept
   * as a documented possibility here (e.g. for a future "inherit OS default"
   * option), but "default" itself now uses an explicit stack instead — see
   * DEFAULT_FONT_ID's entry below. */
  stack: string | null;
  /** Extra tracking applied on top of the font stack, e.g. "0.05em". Only
   * used by "wide-mono"/"wider-mono" today — a guaranteed visual width bump
   * that doesn't depend on which face a given OS actually substitutes in,
   * unlike relying on the named font's own letterforms alone. */
  letterSpacing?: string;
  /** Overrides the rendered font-weight, e.g. "600". Used by "courier" to
   * compensate for a thinner-than-expected substituted face (e.g. Liberation
   * Mono on Linux), which makes identically-colored text read as
   * lighter/grayer purely from stroke weight. This compensates without
   * touching color. */
  fontWeight?: string;
  /** Adds a thin `-webkit-text-stroke` outline (width only, color always
   * follows the text color) to darken a font's apparent weight by a small,
   * continuous amount, e.g. "0.25px". Used instead of fontWeight for "times":
   * Times New Roman/Liberation Serif typically ship only Regular (400) and
   * Bold (700) faces, so any font-weight value in between snaps straight to
   * full Bold rather than looking "a little bolder" — a text-stroke can add
   * just a touch of heft without changing which face renders. */
  textStroke?: string;
  /** True for the monospace font choices only. Drives whether the editor
   * force-disables kerning/ligatures (see applyFont below and fontSizeTheme
   * in editor.ts) — that override exists solely to correct uneven glyph
   * advance widths in "monospace" font files that still carry kerning
   * tables, and should never be applied to a proportional font, which wants
   * normal kerning for correct typography. Forcing every font (including
   * proportional ones) through that disabled-kerning/ligature code path was
   * also implicated in a Windows-only rendering bug where Verdana in
   * particular would visibly shake/jitter while scrolling — likely because
   * it pushes the browser's text shaper down a more complex path than a
   * plain proportional font needs, and Verdana's hint program is unusually
   * sensitive to that. Scoping the override to monospace fonts avoids both
   * problems at once. */
  monospace?: boolean;
}

export const FONT_OPTIONS: FontOption[] = [
  // Deliberately omits "Courier New" — unlike --mono (style.css), which
  // includes it for the app's own UI chrome, this stack must not resolve to
  // the same face as the "courier" option below. ui-monospace and Consolas
  // are both absent on Linux (one's a Mac/WebKit generic keyword many
  // WebKitGTK builds don't recognize, the other's Windows-only), so on Linux
  // this stack falls straight through to the final "monospace" keyword —
  // if "Courier New" were listed before it, "default" and "courier" would
  // both land on Linux's "Courier New" substitute (typically Liberation
  // Mono) and become visually indistinguishable, which is exactly what
  // happened when this stack briefly included it. Still a multi-name list
  // (not a single bare keyword) to avoid the jumpy-text bug documented in
  // the `stack` field's doc comment above.
  { id: "default", label: "Default", stack: "ui-monospace, Consolas, monospace", monospace: true },
  {
    id: "times",
    label: "Times New Roman",
    stack: '"Times New Roman", Times, serif',
    textStroke: "0.25px",
  },
  {
    id: "courier",
    label: "Courier New (mono)",
    // "Nimbus Mono PS" (the URW PostScript Courier clone, bundled with
    // gsfonts/urw-base35-fonts on most Linux distros) is listed first and
    // deliberately ahead of "Courier New": CSS font matching picks the
    // first *exact name* match regardless of how it actually looks, and at
    // least one Linux Mint setup has a literal (lighter/thinner) Courier
    // New TTF installed under that exact name, which won every match before
    // this font-weight/text-stroke could have any effect. Nimbus Mono PS
    // renders as a proper solid/bold typewriter face and was confirmed
    // present via `fc-list` on that same system.
    stack: '"Nimbus Mono PS", "Courier New", Courier, monospace',
    fontWeight: "500",
    // Kept as a fallback in case neither of the above is installed and the
    // system substitutes something thinner than intended — see "times" for
    // the same technique used for the same class of problem.
    textStroke: "0.2px",
    monospace: true,
  },
  { id: "georgia", label: "Georgia", stack: 'Georgia, "Liberation Serif", serif' },
  { id: "arial", label: "Arial", stack: "Arial, Helvetica, sans-serif" },
  // Verdana's letterforms are noticeably wider than Arial/Georgia at the same
  // point size — its whole design goal was legibility at small sizes. Most
  // Linux distros substitute DejaVu Sans (a similarly wide, related design)
  // when the exact font isn't installed.
  { id: "verdana", label: "Verdana", stack: 'Verdana, "DejaVu Sans", sans-serif' },
  { id: "consolas", label: "Consolas (mono)", stack: "Consolas, Menlo, monospace", monospace: true },
  // Wide/Wider Mono used to be built on Lucida Sans Typewriter, but that face
  // (like Lucida Console, removed entirely) predates ClearType and its hint
  // program produces visibly uneven glyph spacing under modern subpixel text
  // shaping, even though the underlying advance widths are uniform — a
  // font-file characteristic no CSS property can correct. Consolas was
  // purpose-built as Microsoft's ClearType showcase monospace font and
  // renders evenly, so these two are now just Consolas plus extra
  // letter-spacing for a wider feel.
  {
    id: "wide-mono",
    label: "Wide Mono (mono)",
    stack: "Consolas, Menlo, monospace",
    letterSpacing: "0.05em",
    monospace: true,
  },
  {
    id: "wider-mono",
    label: "Wider Mono (mono)",
    stack: "Consolas, Menlo, monospace",
    letterSpacing: "0.18em",
    monospace: true,
  },
];

export const DEFAULT_FONT_ID = "default";

export function getFontOption(id: string): FontOption {
  return FONT_OPTIONS.find((f) => f.id === id) ?? FONT_OPTIONS[0];
}

/** Sets (or clears) the --editor-font/--editor-letter-spacing variables
 * driving the editor's font-family. A no-op DOM write, safe to call before
 * the rest of the app has mounted. */
export function applyFont(id: string): void {
  const option = getFontOption(id);
  const root = document.documentElement;
  if (option.stack) {
    root.style.setProperty("--editor-font", option.stack);
  } else {
    root.style.removeProperty("--editor-font");
  }
  if (option.letterSpacing) {
    root.style.setProperty("--editor-letter-spacing", option.letterSpacing);
  } else {
    root.style.removeProperty("--editor-letter-spacing");
  }
  if (option.fontWeight) {
    root.style.setProperty("--editor-font-weight", option.fontWeight);
  } else {
    root.style.removeProperty("--editor-font-weight");
  }
  if (option.textStroke) {
    root.style.setProperty("--editor-text-stroke", option.textStroke);
  } else {
    root.style.removeProperty("--editor-text-stroke");
  }
  if (option.monospace) {
    root.style.setProperty("--editor-font-kerning", "none");
    root.style.setProperty("--editor-font-ligatures", "none");
    root.style.setProperty("--editor-font-feature-settings", '"kern" 0, "liga" 0, "clig" 0, "calt" 0');
  } else {
    root.style.removeProperty("--editor-font-kerning");
    root.style.removeProperty("--editor-font-ligatures");
    root.style.removeProperty("--editor-font-feature-settings");
  }
}
