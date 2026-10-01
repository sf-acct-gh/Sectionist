// CodeMirror 6 wrapper. Sectionist treats .txt and .md identically as plain
// text (AGENTS.md is explicit that Markdown must not get preview or
// Markdown-specific editing behavior), so no language/syntax extension is
// used here at all.

import { EditorState, Compartment, StateEffect, StateField } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  Decoration,
  type DecorationSet,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  insertTab,
  indentLess,
  undo as cmUndo,
  redo as cmRedo,
  invertedEffects,
} from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { wrapIndentPlugin } from "./wrapIndent";
import {
  findMisspellings,
  suggest,
  ignoreWord,
  addToDictionary,
  type WordRange,
} from "./spellcheck/engine";

const BASE_FONT_PX = 14;

// Lets an encoding change (which touches no document text) participate in
// the same undo/redo history as text edits, via CodeMirror's documented
// invertedEffects extension point — rather than building a separate undo
// stack just for this one non-document piece of state.
const setEncodingEffect = StateEffect.define<string>();
const encodingField = StateField.define<string>({
  create: () => "utf8",
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEncodingEffect)) value = effect.value;
    }
    return value;
  },
});
const encodingHistory = invertedEffects.of((tr) => {
  if (!tr.effects.some((e) => e.is(setEncodingEffect))) return [];
  return [setEncodingEffect.of(tr.startState.field(encodingField))];
});

// WebKitGTK's own native, continuous spellchecker only evaluates text as it's
// typed — it never retroactively checks text already sitting in the
// contenteditable, with no script-level way to force it to (confirmed
// empirically across cursor traversal, silent document replacement, bulk and
// per-character execCommand replays, an attribute off/on transition, and
// probing for a native "check document now" editing command). The custom
// decoration-based spellchecker below (see misspellingsField and
// spellcheck/engine.ts) replaces it entirely for the main editor surface, so
// the native attribute is always forced off here to avoid a second,
// independent underline mechanism double-marking (or disagreeing on) the
// same words once the user actually does type a fresh misspelling.
function disableNativeSpellCheck() {
  return EditorView.contentAttributes.of({
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
  });
}

const setMisspellings = StateEffect.define<readonly WordRange[]>();
const misspelledMark = Decoration.mark({ class: "cm-misspelled" });

const misspellingsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setMisspellings)) {
        deco = Decoration.set(
          effect.value.map((r) => misspelledMark.range(r.from, r.to)),
          true,
        );
      }
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

interface MisspelledRange {
  from: number;
  to: number;
  word: string;
}

function misspelledRangeAt(view: EditorView, pos: number): MisspelledRange | null {
  let found: MisspelledRange | null = null;
  view.state.field(misspellingsField).between(pos, pos, (from, to) => {
    found = { from, to, word: view.state.sliceDoc(from, to) };
    return false;
  });
  return found;
}

export class Editor {
  private view: EditorView | null = null;
  private readonly wrapCompartment = new Compartment();
  private readonly themeCompartment = new Compartment();
  private readonly tabCompartment = new Compartment();
  private suppressChangeNotification = false;
  private wordWrapEnabled = false;
  private hangingIndentEnabled = true;
  private tabWidth = 4;
  private spellCheckEnabled = false;
  private spellCheckDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private spellCheckToken = 0;
  private activeSuggestionMenu: HTMLElement | null = null;

  constructor(
    private readonly parent: HTMLElement,
    private readonly onChange: (content: string) => void,
    private readonly onViewportChange: () => void,
    private readonly onEncodingChange: (encoding: string) => void,
  ) {}

  mount(
    content: string,
    wordWrap: boolean,
    zoom: number,
    tabWidth: number,
    wrapHangingIndent: boolean,
    encoding: string,
    spellCheck: boolean,
    options?: { readOnly?: boolean; initialCursor?: number; initialScrollTop?: number },
  ): void {
    this.destroy();

    const readOnly = options?.readOnly ?? false;
    this.wordWrapEnabled = wordWrap;
    this.hangingIndentEnabled = wrapHangingIndent;
    this.tabWidth = tabWidth;
    this.spellCheckEnabled = spellCheck;
    const initialCursor = Math.min(Math.max(options?.initialCursor ?? 0, 0), content.length);

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !this.suppressChangeNotification) {
        this.onChange(update.state.doc.toString());
      }
      if (update.docChanged || update.geometryChanged) {
        this.onViewportChange();
      }
      if (update.docChanged && this.spellCheckEnabled) {
        this.scheduleSpellCheck();
      }
      const prevEncoding = update.startState.field(encodingField);
      const nextEncoding = update.state.field(encodingField);
      if (prevEncoding !== nextEncoding) {
        this.onEncodingChange(nextEncoding);
      }
    });

    const state = EditorState.create({
      doc: content,
      selection: { anchor: initialCursor },
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        dropCursor(),
        history(),
        encodingField.init(() => encoding),
        encodingHistory,
        search({ top: true }),
        this.wrapCompartment.of(this.wrapExtensions()),
        // A real space-width measurement needs the live .cm-scroller element
        // (see measureSpaceWidthPx), which doesn't exist until the EditorView
        // below is constructed — so this starts with a rough placeholder and
        // applyTabSize() immediately corrects it once the view exists, before
        // this function returns (no visible flash of the wrong tab width).
        this.tabCompartment.of(tabExtensions(tabWidth, BASE_FONT_PX * 0.6)),
        this.themeCompartment.of(fontSizeTheme(zoom)),
        disableNativeSpellCheck(),
        misspellingsField.init(() => Decoration.none),
        spellCheckTheme(),
        EditorView.domEventHandlers({
          contextmenu: (event, view) => this.handleContextMenu(event, view),
        }),
        colorTheme(),
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false), readOnlyTheme()] : [],
        keymap.of([
          { key: "Mod-h", run: openSearchPanel },
          ...searchKeymap,
          ...historyKeymap,
          { key: "Tab", run: insertTab, shift: indentLess },
          ...defaultKeymap,
        ]),
        updateListener,
      ],
    });

    this.view = new EditorView({ state, parent: this.parent });
    this.applyTabSize();

    if (this.spellCheckEnabled) {
      this.scheduleSpellCheck(true);
    }

    const scrollTop = options?.initialScrollTop;
    if (scrollTop) {
      // Setting this once, right after construction, isn't always enough:
      // CodeMirror still has a pending initial measurement/layout pass at
      // this point (it only just got a parent), and that pass can reset or
      // clamp scrollTop before the true content height has settled. A
      // follow-up on the next animation frame — after that pass completes —
      // makes the restore reliable.
      this.view.scrollDOM.scrollTop = scrollTop;
      requestAnimationFrame(() => {
        if (this.view) this.view.scrollDOM.scrollTop = scrollTop;
      });
    }
  }

  /** Current cursor offset and scroll position, for persisting where the
   * user left off in this file (see store.ts's viewState). Returns null if
   * nothing is mounted (e.g. the Markdown rendered-preview mode, which has
   * no CodeMirror view at all). */
  getViewState(): { cursor: number; scrollTop: number } | null {
    if (!this.view) return null;
    return {
      cursor: this.view.state.selection.main.head,
      scrollTop: this.view.scrollDOM.scrollTop,
    };
  }

  destroy(): void {
    if (this.spellCheckDebounceTimer !== null) {
      clearTimeout(this.spellCheckDebounceTimer);
      this.spellCheckDebounceTimer = null;
    }
    this.spellCheckToken++; // invalidates any in-flight findMisspellings() call
    this.closeSuggestionMenu();
    this.view?.destroy();
    this.view = null;
  }

  focus(): void {
    this.view?.focus();
  }

  getContent(): string {
    return this.view?.state.doc.toString() ?? "";
  }

  /** Replace the document without treating it as a user edit (used when
   * loading/reloading a file, as opposed to typing). */
  setContentSilently(content: string): void {
    if (!this.view) return;
    this.suppressChangeNotification = true;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: content },
    });
    this.suppressChangeNotification = false;
  }

  private wrapExtensions() {
    if (!this.wordWrapEnabled) return [];
    return this.hangingIndentEnabled
      ? [EditorView.lineWrapping, wrapIndentPlugin]
      : [EditorView.lineWrapping];
  }

  setWordWrap(enabled: boolean): void {
    this.wordWrapEnabled = enabled;
    this.view?.dispatch({ effects: this.wrapCompartment.reconfigure(this.wrapExtensions()) });
  }

  setWrapHangingIndent(enabled: boolean): void {
    this.hangingIndentEnabled = enabled;
    this.view?.dispatch({ effects: this.wrapCompartment.reconfigure(this.wrapExtensions()) });
  }

  setTabWidth(width: number): void {
    this.tabWidth = width;
    this.applyTabSize();
  }

  /** Dispatches through the normal transaction/undo pipeline (see
   * setEncodingEffect/encodingHistory above), so this shows up in Ctrl+Z
   * history alongside text edits instead of needing its own tracking. */
  setEncoding(id: string): void {
    this.view?.dispatch({ effects: setEncodingEffect.of(id) });
  }

  getEncoding(): string {
    return this.view?.state.field(encodingField) ?? "utf8";
  }

  setSpellCheck(enabled: boolean): void {
    this.spellCheckEnabled = enabled;
    if (this.spellCheckDebounceTimer !== null) {
      clearTimeout(this.spellCheckDebounceTimer);
      this.spellCheckDebounceTimer = null;
    }
    if (enabled) {
      this.scheduleSpellCheck(true);
    } else {
      this.spellCheckToken++; // invalidates any in-flight findMisspellings() call
      this.closeSuggestionMenu();
      this.view?.dispatch({ effects: setMisspellings.of([]) });
    }
  }

  /** Debounces re-checking the whole document after an edit (immediate=true
   * skips the debounce, used for the initial check on mount/enable and for
   * ignore/add-to-dictionary, which should feel instant). Re-checking the
   * full document rather than just the edited region is simpler and, since
   * nspell's lookups are fast, cheap enough even for large files — see
   * spellcheck/engine.ts. */
  private scheduleSpellCheck(immediate = false): void {
    if (this.spellCheckDebounceTimer !== null) {
      clearTimeout(this.spellCheckDebounceTimer);
      this.spellCheckDebounceTimer = null;
    }
    const run = () => {
      this.spellCheckDebounceTimer = null;
      void this.runSpellCheck();
    };
    if (immediate) run();
    else this.spellCheckDebounceTimer = setTimeout(run, 400);
  }

  private async runSpellCheck(): Promise<void> {
    if (!this.view || !this.spellCheckEnabled) return;
    const token = ++this.spellCheckToken;
    const text = this.view.state.doc.toString();
    const misspellings = await findMisspellings(text);
    // Stale if: this Editor moved on to a different mount/toggle (token), or
    // the document changed again while the dictionary/check was in flight —
    // in the latter case the docChanged handler above already scheduled a
    // fresh check against the new text, so silently dropping this one is
    // correct rather than applying now-wrong ranges.
    if (token !== this.spellCheckToken || !this.view) return;
    if (this.view.state.doc.toString() !== text) return;
    this.view.dispatch({ effects: setMisspellings.of(misspellings) });
  }

  private handleContextMenu(event: MouseEvent, view: EditorView): boolean {
    if (!this.spellCheckEnabled) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    const range = misspelledRangeAt(view, pos);
    if (!range) return false;
    event.preventDefault();
    void this.showSuggestionMenu(view, range, event.clientX, event.clientY);
    return true;
  }

  private closeSuggestionMenu(): void {
    if (!this.activeSuggestionMenu) return;
    this.activeSuggestionMenu.remove();
    this.activeSuggestionMenu = null;
    document.removeEventListener("mousedown", this.handleSuggestionMenuOutsideClick, true);
    document.removeEventListener("keydown", this.handleSuggestionMenuEscape, true);
  }

  private readonly handleSuggestionMenuOutsideClick = (event: MouseEvent): void => {
    if (this.activeSuggestionMenu && !this.activeSuggestionMenu.contains(event.target as Node)) {
      this.closeSuggestionMenu();
    }
  };

  private readonly handleSuggestionMenuEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.closeSuggestionMenu();
  };

  /** Right-click context menu for a misspelled word: suggestions from
   * nspell, plus Notepad++-style "Ignore" (session only) and "Add to
   * Dictionary" (persistent — see spellcheck/engine.ts) entries. */
  private async showSuggestionMenu(
    view: EditorView,
    range: MisspelledRange,
    clientX: number,
    clientY: number,
  ): Promise<void> {
    this.closeSuggestionMenu();
    const suggestions = await suggest(range.word);
    // The view may have been torn down (file switched/closed) while
    // suggestions were loading.
    if (this.view !== view) return;

    const menu = document.createElement("div");
    menu.className = "spellcheck-menu";
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;

    const addItem = (label: string, onSelect: () => void, extraClass?: string): void => {
      const item = document.createElement("div");
      item.className = extraClass ? `spellcheck-menu-item ${extraClass}` : "spellcheck-menu-item";
      item.textContent = label;
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        onSelect();
        this.closeSuggestionMenu();
      });
      menu.appendChild(item);
    };

    if (suggestions.length === 0) {
      addItem("No suggestions", () => {}, "spellcheck-menu-empty");
    } else {
      for (const word of suggestions.slice(0, 8)) {
        addItem(word, () => {
          this.view?.dispatch({
            changes: { from: range.from, to: range.to, insert: word },
            selection: { anchor: range.from + word.length },
          });
        });
      }
    }

    const separator = document.createElement("div");
    separator.className = "spellcheck-menu-separator";
    menu.appendChild(separator);

    addItem("Ignore", () => {
      ignoreWord(range.word);
      this.scheduleSpellCheck(true);
    });
    addItem("Add to Dictionary", () => {
      void addToDictionary(range.word).then(() => this.scheduleSpellCheck(true));
    });

    document.body.appendChild(menu);
    this.activeSuggestionMenu = menu;
    document.addEventListener("mousedown", this.handleSuggestionMenuOutsideClick, true);
    document.addEventListener("keydown", this.handleSuggestionMenuEscape, true);
  }

  setZoom(zoom: number): void {
    this.view?.dispatch({
      effects: this.themeCompartment.reconfigure(fontSizeTheme(zoom)),
    });
    this.applyTabSize();
  }

  /** Call after changing the editor font (fonts.ts's applyFont) — the tab
   * width is measured in actual rendered pixels for the current font (see
   * measureSpaceWidthPx), so a font change invalidates that measurement even
   * though the font itself lives outside any compartment here. */
  refreshFontMetrics(): void {
    this.applyTabSize();
  }

  private applyTabSize(): void {
    if (!this.view) return;
    const spaceWidthPx = measureSpaceWidthPx(this.view.scrollDOM);
    this.view.dispatch({
      effects: this.tabCompartment.reconfigure(tabExtensions(this.tabWidth, spaceWidthPx)),
    });
  }

  lineCount(): number {
    return this.view?.state.doc.lines ?? 0;
  }

  openFind(): void {
    if (this.view) openSearchPanel(this.view);
  }

  openReplace(): void {
    // The built-in panel exposes both find and replace controls together.
    if (this.view) openSearchPanel(this.view);
  }

  undo(): void {
    if (this.view) cmUndo(this.view);
  }

  redo(): void {
    if (this.view) cmRedo(this.view);
  }

  /** Best-effort: native Ctrl+X/C/V already work without this (the browser
   * handles clipboard events on the focused editable region directly); this
   * exists only so the Edit menu's Cut/Copy/Paste items do something when
   * clicked with the mouse instead of via keyboard. */
  cut(): void {
    this.view?.focus();
    document.execCommand("cut");
  }

  copy(): void {
    this.view?.focus();
    document.execCommand("copy");
  }

  paste(): void {
    this.view?.focus();
    document.execCommand("paste");
  }
}

function fontSizeTheme(zoom: number) {
  const px = Math.round(BASE_FONT_PX * zoom);
  return EditorView.theme({
    "&": { fontSize: `${px}px`, height: "100%" },
    ".cm-scroller": {
      fontFamily: "var(--editor-font, monospace)",
      letterSpacing: "var(--editor-letter-spacing, normal)",
      fontWeight: "var(--editor-font-weight, normal)",
      WebkitTextStroke: "var(--editor-text-stroke, 0px) currentColor",
      // Some "monospace" font files still carry kerning/ligature tables from
      // their original design, which browsers apply by default even though
      // the font is flagged fixed-pitch. That reintroduces per-letter-pair
      // spacing adjustments (e.g. around "W"/"A"/"V") on top of what should
      // be equal character widths. Disabling both forces every glyph to use
      // its plain, uniform advance width instead — but only for fonts that
      // actually need it (see fonts.ts's `monospace` flag/applyFont): a
      // proportional font wants normal kerning for correct typography, and
      // forcing it through this same disabled-kerning path was implicated in
      // a Windows-only bug where Verdana specifically would visibly
      // shake/jitter while scrolling. These custom properties are only set
      // when the active font is monospace, so every other font gets the
      // browser's normal (unset) behavior here.
      fontKerning: "var(--editor-font-kerning, normal)",
      fontVariantLigatures: "var(--editor-font-ligatures, normal)",
      fontFeatureSettings: "var(--editor-font-feature-settings, normal)",
      overflow: "auto",
    },
    ".cm-content": { minHeight: "100%" },
  });
}

/** Tab width (facet + real CSS tab-size) and indentUnit, kept together since
 * both need to change in lockstep whenever the tab-width preference changes.
 * indentUnit is set to a literal tab character so multi-line block
 * indent/dedent (Tab/Shift-Tab with a selection) stays consistent with
 * single-cursor tab-character insertion — see the Tab keymap entry above.
 *
 * tab-size is set as an explicit pixel length (width * the font's actual
 * measured space-character width) rather than the bare-number form (e.g.
 * "4"), which asks the browser to measure that same space width itself.
 * That built-in measurement turned out to be unreliable for some fonts
 * (tabs rendering at roughly half the intended width for certain families),
 * so this measures it directly instead — see measureSpaceWidthPx. */
function tabExtensions(width: number, spaceWidthPx: number) {
  return [
    EditorState.tabSize.of(width),
    indentUnit.of("\t"),
    EditorView.theme({ "&": { tabSize: `${width * spaceWidthPx}px` } }),
  ];
}

/** Measures the actual rendered width of a space character by appending one
 * as a real child of the live .cm-scroller element (passed in as `container`)
 * and reading its layout box, rather than hand-copying font-family/letter-
 * spacing/font-weight/etc. onto a wholly separate offscreen probe. An earlier
 * version of this did copy those properties by hand, and it was fragile in
 * exactly the way that sounds: it silently missed the font-kerning/ligature
 * overrides added to .cm-scroller later (see fontSizeTheme), so the probe and
 * the real editor text could shape differently and disagree on width. Being
 * an actual DOM descendant of .cm-scroller means every current and future
 * font-affecting property inherits automatically — no properties to
 * remember to keep in sync by hand. position:absolute plus large negative
 * offsets keep it out of the visible/scrollable area without affecting
 * .cm-scroller's scrollWidth/Height. */
function measureSpaceWidthPx(container: HTMLElement): number {
  const probe = document.createElement("span");
  probe.textContent = " ".repeat(20);
  probe.style.cssText = [
    "position: absolute",
    "visibility: hidden",
    "white-space: pre",
    "top: -9999px",
    "left: -9999px",
    "pointer-events: none",
  ].join(";");
  container.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 20;
  container.removeChild(probe);
  return width > 0 ? width : BASE_FONT_PX * 0.6;
}

/** Colors the editor surface from the same CSS custom properties the rest of
 * the app's chrome uses (see theme.ts), so every theme — including any added
 * in the future — covers the actual text-editing area too, not just the
 * surrounding panels. Referencing var(...) directly means switching themes
 * needs no reconfiguration here: the browser re-evaluates these on its own
 * whenever the active theme's variables change. */
function colorTheme() {
  return EditorView.theme({
    "&": { backgroundColor: "var(--bg)", color: "var(--editor-text)" },
    ".cm-content": { caretColor: "var(--editor-text)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--editor-text)" },
    ".cm-gutters": {
      backgroundColor: "var(--pane-bg)",
      color: "var(--text-muted)",
      borderRight: "1px solid var(--border)",
    },
    ".cm-activeLine": { backgroundColor: "var(--drop-target-bg)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--drop-target-bg)" },
    // @codemirror/view's drawSelection() extension ships its own baseTheme
    // rule for the focused case — "&light.cm-focused > .cm-scroller >
    // .cm-selectionLayer .cm-selectionBackground" — which has higher CSS
    // specificity than a plain ".cm-selectionBackground" rule and always
    // matches here (Sectionist never sets EditorView.theme's `dark` option,
    // so CodeMirror always considers itself "light" internally regardless of
    // which Sectionist theme is active). Without matching that selector's
    // shape, our override loses and every theme gets CodeMirror's hard-coded
    // pale lavender (#d7d4f0) whenever the editor has focus. The unfocused
    // selector below is unaffected by this and can stay simple.
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
      backgroundColor: "var(--editor-selection-bg)",
    },
    ".cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--drop-target-bg)",
    },
  });
}

/** Visual treatment for a file shown but not editable (e.g. no longer
 * available on disk): a light gray background makes it obvious at a glance
 * that this view can't be typed into. */
function readOnlyTheme() {
  return EditorView.theme({
    "&": { backgroundColor: "var(--readonly-bg, #ececec)" },
    ".cm-gutters": { backgroundColor: "var(--readonly-gutter-bg, #e2e2e2)" },
    ".cm-content": { caretColor: "transparent" },
  });
}

/** Squiggly-underline styling for misspelled words (see misspellingsField
 * above). text-decoration never affects layout/line height the way a
 * background-image underline trick would, so this can never itself be the
 * cause of jumpiness/reflow. */
function spellCheckTheme() {
  return EditorView.theme({
    ".cm-misspelled": {
      textDecoration: "underline",
      textDecorationStyle: "wavy",
      textDecorationColor: "#e54040",
      textDecorationThickness: "1px",
      textUnderlineOffset: "3px",
    },
  });
}
