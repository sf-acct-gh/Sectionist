// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { Editor } from "./editor";
import { _resetSessionStateForTests } from "./spellcheck/engine";

// EditorView.posAtCoords relies on real layout metrics (getClientRects etc.)
// that jsdom doesn't compute, so the right-click flow is exercised here by
// invoking the Editor's private suggestion-menu machinery directly with a
// manually-built range rather than dispatching a real "contextmenu" DOM
// event at pixel coordinates. This still exercises the real menu-building,
// suggestion-click, Ignore, and Add to Dictionary code paths end to end —
// only the coordinate-based hit-testing step (handleContextMenu itself) is
// bypassed, since that step is a thin, already-obviously-correct wrapper
// around posAtCoords + misspelledRangeAt.
interface EditorInternals {
  view: unknown;
  showSuggestionMenu(
    view: unknown,
    range: { from: number; to: number; word: string },
    clientX: number,
    clientY: number,
  ): Promise<void>;
}

function internals(editor: Editor): EditorInternals {
  return editor as unknown as EditorInternals;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function misspelledEls(): NodeListOf<Element> {
  return document.querySelectorAll(".cm-misspelled");
}

describe("Editor spell check", () => {
  let parent: HTMLElement;
  let editor: Editor;

  beforeEach(() => {
    _resetSessionStateForTests();
    localStorage.clear();
    document.body.innerHTML = "";
    parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = new Editor(
      parent,
      () => {},
      () => {},
      () => {},
    );
  });

  it("flags a pre-existing misspelling as soon as spell check is enabled on mount", async () => {
    editor.mount("This has a speling mistake.", false, 1, 4, true, "utf8", true);
    await waitFor(() => misspelledEls().length > 0);
    expect(misspelledEls().length).toBe(1);
    expect(misspelledEls()[0]?.textContent).toBe("speling");
  });

  it("does not flag anything when spell check is disabled", async () => {
    editor.mount("This has a speling mistake.", false, 1, 4, true, "utf8", false);
    // Give any (incorrectly) scheduled check a chance to run before asserting.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(misspelledEls().length).toBe(0);
  });

  it("flags a newly typed misspelling after the debounce window", async () => {
    editor.mount("Correct text.", false, 1, 4, true, "utf8", true);
    await waitFor(() => document.querySelector(".cm-content") !== null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(misspelledEls().length).toBe(0);

    const view = internals(editor).view as {
      dispatch: (spec: unknown) => void;
      state: { doc: { length: number } };
    };
    view.dispatch({ changes: { from: view.state.doc.length, insert: " speling" } });

    await waitFor(() => misspelledEls().length > 0, 3000);
    expect(misspelledEls()[0]?.textContent).toBe("speling");
  });

  it("clears decorations immediately when spell check is turned off", async () => {
    editor.mount("This has a speling mistake.", false, 1, 4, true, "utf8", true);
    await waitFor(() => misspelledEls().length > 0);
    editor.setSpellCheck(false);
    expect(misspelledEls().length).toBe(0);
  });

  it("replaces the word when a suggestion is clicked", async () => {
    const text = "I did not recieve it.";
    editor.mount(text, false, 1, 4, true, "utf8", true);
    await waitFor(() => misspelledEls().length > 0);

    const from = text.indexOf("recieve");
    const to = from + "recieve".length;
    await internals(editor).showSuggestionMenu(
      internals(editor).view,
      { from, to, word: "recieve" },
      10,
      10,
    );

    const menu = document.querySelector(".spellcheck-menu");
    expect(menu).not.toBeNull();
    const items = Array.from(menu?.querySelectorAll(".spellcheck-menu-item") ?? []);
    const labels = items.map((el) => el.textContent);
    expect(labels[0]).toBe("receive");

    items[0]?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(editor.getContent()).toBe("I did not receive it.");
    expect(document.querySelector(".spellcheck-menu")).toBeNull();
  });

  it("Ignore removes the underline for the session without persisting it", async () => {
    const text = "This has a speling mistake.";
    editor.mount(text, false, 1, 4, true, "utf8", true);
    await waitFor(() => misspelledEls().length > 0);

    const from = text.indexOf("speling");
    const to = from + "speling".length;
    await internals(editor).showSuggestionMenu(
      internals(editor).view,
      { from, to, word: "speling" },
      10,
      10,
    );
    const items = Array.from(document.querySelectorAll(".spellcheck-menu-item"));
    const ignoreItem = items.find((el) => el.textContent === "Ignore");
    expect(ignoreItem).toBeDefined();
    ignoreItem?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    await waitFor(() => misspelledEls().length === 0);
    expect(localStorage.getItem("sectionist.spellcheck.personalDictionary")).toBeNull();
  });

  it("Add to Dictionary removes the underline and persists across a fresh editor instance", async () => {
    const text = "This has a speling mistake.";
    editor.mount(text, false, 1, 4, true, "utf8", true);
    await waitFor(() => misspelledEls().length > 0);

    const from = text.indexOf("speling");
    const to = from + "speling".length;
    await internals(editor).showSuggestionMenu(
      internals(editor).view,
      { from, to, word: "speling" },
      10,
      10,
    );
    const items = Array.from(document.querySelectorAll(".spellcheck-menu-item"));
    const addItem = items.find((el) => el.textContent === "Add to Dictionary");
    expect(addItem).toBeDefined();
    addItem?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    await waitFor(() => misspelledEls().length === 0);
    const stored = localStorage.getItem("sectionist.spellcheck.personalDictionary");
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored ?? "[]")).toContain("speling");

    editor.destroy();
    const parent2 = document.createElement("div");
    document.body.appendChild(parent2);
    const editor2 = new Editor(
      parent2,
      () => {},
      () => {},
      () => {},
    );
    editor2.mount(text, false, 1, 4, true, "utf8", true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(misspelledEls().length).toBe(0);
    editor2.destroy();
  });
});
