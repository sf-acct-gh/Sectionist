// Notepad++-style "Line Wrap": a wrapped line's continuation rows visually
// start under where that line's own text starts, without inserting any real
// whitespace characters. Standard CodeMirror 6 hanging-indent recipe: a
// negative text-indent cancels the indent on the line's own first visual
// row, and padding-left applies it to every wrapped continuation row.
//
// Measuring via view.coordsAtPos (rather than counting characters) is what
// makes this correct for tabs, proportional (non-monospace) fonts, and zoom
// — it reads CodeMirror's own rendered layout instead of guessing from
// character counts.

import { RangeSet, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

const LEADING_WHITESPACE = /^[ \t]*/;

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const leading = LEADING_WHITESPACE.exec(line.text)?.[0] ?? "";
      // Only lines that actually span more than one visual row need (or
      // should get) this decoration. Applying it to every indented line
      // regardless of wrapping caused a visible jump: as soon as a line with
      // only leading whitespace gained its first real character (e.g. right
      // after pressing Tab, then typing), the decoration would switch on
      // mid-edit and re-layout that still-single-row line, shifting already
      // -rendered content (and the cursor) sideways for no visual benefit.
      const wraps = view.lineBlockAt(line.from).height > view.defaultLineHeight * 1.5;
      if (leading.length > 0 && leading.length < line.text.length && wraps) {
        const start = view.coordsAtPos(line.from);
        const end = view.coordsAtPos(line.from + leading.length);
        if (start && end) {
          const px = end.left - start.left;
          if (px > 0) {
            builder.add(
              line.from,
              line.from,
              Decoration.line({
                attributes: { style: `text-indent: -${px}px; padding-left: ${px}px;` },
              }),
            );
          }
        }
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const wrapIndentPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    // Guards against overlapping measure cycles: without this, a second
    // scheduleMeasure() call arriving (e.g. from a geometryChanged update)
    // before the first one's write phase has run would queue a second
    // requestMeasure on top of the first, and if measuring ever produced
    // slightly different pixel values between the two (float jitter in
    // coordsAtPos, observed to be more likely on Windows/WebView2's text
    // metrics than Linux/WebKitGTK's), each write's no-op dispatch would
    // itself trigger another geometryChanged update — an unbounded
    // measure-dispatch-update loop that would explain an occasional frozen
    // UI thread on Windows.
    measurePending = false;
    private unregisterFontsReady: (() => void) | null = null;

    constructor(view: EditorView) {
      this.scheduleMeasure(view);
      // If the editor's font is still downloading/rasterizing when the
      // initial measurement above runs, coordsAtPos measures glyph
      // positions against the fallback font and this decoration's pixel
      // offsets go stale the moment the real font swaps in — visible as a
      // one-time jump that a resize (the next geometryChanged event)
      // happens to fix. Re-measuring once the browser reports all fonts
      // loaded closes that gap without waiting on a user-triggered resize.
      let cancelled = false;
      document.fonts.ready.then(() => {
        if (!cancelled) this.scheduleMeasure(view);
      });
      this.unregisterFontsReady = () => {
        cancelled = true;
      };
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        // A doc/viewport change's own update() call runs before CodeMirror
        // patches the DOM to match the new state, so reading coordsAtPos
        // synchronously here would measure the *previous* layout. Deferring
        // to requestMeasure's read phase guarantees the DOM already reflects
        // the new content; the write phase re-dispatches so the view
        // actually redraws with the freshly computed decorations.
        this.scheduleMeasure(update.view);
      }
    }
    destroy() {
      this.unregisterFontsReady?.();
    }
    scheduleMeasure(view: EditorView) {
      if (this.measurePending) return;
      this.measurePending = true;
      view.requestMeasure({
        read: () => buildDecorations(view),
        write: (decorations, view) => {
          this.measurePending = false;
          // Skip the redispatch entirely when nothing actually changed —
          // the common case for a geometryChanged event that didn't affect
          // any wrapped line's indent (e.g. a resize that doesn't change
          // which lines wrap). Redispatching unconditionally here is what
          // produced the occasional visible flash even when the computed
          // decorations were identical to what was already showing.
          if (RangeSet.eq([this.decorations], [decorations])) return;
          this.decorations = decorations;
          // requestMeasure's write phase still runs inside the update that
          // scheduled it, so dispatching here directly throws ("Calls to
          // EditorView.update are not allowed while an update is in
          // progress"). Deferring to a microtask lets that update finish
          // first; the follow-up no-op dispatch is what makes the view
          // actually redraw with the freshly computed decorations.
          Promise.resolve().then(() => view.dispatch({}));
        },
      });
    }
  },
  { decorations: (v) => v.decorations },
);
