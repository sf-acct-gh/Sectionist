// @vitest-environment jsdom
//
// Covers the multi-file "+" add button added to SectionsPane: selecting a
// single file keeps the existing behavior of activating it, while
// selecting several at once leaves the active file alone instead of
// jumping once per added file. Store logic (dedup, sorting, activation)
// is already covered by store.test.ts; this only exercises the UI-layer
// decision of which `activate` flag to pass based on how many paths the
// picker returned.

import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = new Map<string, string>();

vi.mock("../native", () => ({
  readTextFileWithEncoding: vi.fn(async (path: string) => {
    if (!disk.has(path)) throw new Error(`ENOENT: ${path}`);
    return { contents: disk.get(path)!, encoding: "utf8" };
  }),
  writeTextFileWithEncoding: vi.fn(async () => {}),
  pathMetadata: vi.fn(async (path: string) => ({
    exists: disk.has(path),
    isFile: disk.has(path),
    modifiedMs: null,
    size: disk.has(path) ? disk.get(path)!.length : null,
  })),
  watchPath: vi.fn(async () => {}),
  unwatchPath: vi.fn(async () => {}),
  onFileEvent: vi.fn(async () => () => {}),
  showError: vi.fn(async () => {}),
  pickFilesToAdd: vi.fn(async (): Promise<string[]> => []),
  launchPath: vi.fn(async () => {}),
}));

vi.mock("../persistence", () => ({
  loadState: vi.fn(async () => ({
    version: 1 as const,
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
  })),
  saveState: vi.fn(async () => {}),
  loadRecovery: vi.fn(async () => ({})),
  saveRecovery: vi.fn(async () => {}),
}));

import { pickFilesToAdd } from "../native";
import { Store } from "../store";
import { SectionsPane } from "./sectionsPane";

beforeEach(() => {
  disk.clear();
  vi.clearAllMocks();
});

async function newStore(): Promise<Store> {
  const store = new Store();
  await store.init();
  return store;
}

function clickAddButton(container: HTMLElement) {
  const addBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.title === "Add file",
  );
  if (!addBtn) throw new Error("Add file button not found");
  addBtn.click();
}

describe("SectionsPane add-file button", () => {
  it("activates the file when exactly one is selected", async () => {
    disk.set("/notes/a.txt", "hello");
    const store = await newStore();
    const section = store.createSection("A");
    vi.mocked(pickFilesToAdd).mockResolvedValueOnce(["/notes/a.txt"]);

    const container = document.createElement("div");
    const pane = new SectionsPane(container, store, () => {});
    pane.render();
    clickAddButton(container);

    // Flush the async click handler (pickFilesToAdd + addFileToSection are
    // both awaited/async internally).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const files = store.getSection(section.id)?.files ?? [];
    expect(files).toHaveLength(1);
    expect(store.getActiveFileId()).toBe(files[0].id);
  });

  it("does not change the active file when multiple files are selected", async () => {
    disk.set("/notes/a.txt", "hello");
    disk.set("/notes/b.txt", "world");
    disk.set("/notes/c.txt", "!");
    const store = await newStore();
    const section = store.createSection("A");
    const already = store.addFileToSection(section.id, "/notes/a.txt")!;
    vi.mocked(pickFilesToAdd).mockResolvedValueOnce(["/notes/b.txt", "/notes/c.txt"]);

    const container = document.createElement("div");
    const pane = new SectionsPane(container, store, () => {});
    pane.render();
    clickAddButton(container);

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const files = store.getSection(section.id)?.files ?? [];
    expect(files).toHaveLength(3);
    expect(store.getActiveFileId()).toBe(already.id);
  });

  it("adds no files and leaves the active file unchanged when the picker is cancelled", async () => {
    disk.set("/notes/a.txt", "hello");
    const store = await newStore();
    const section = store.createSection("A");
    const already = store.addFileToSection(section.id, "/notes/a.txt")!;
    vi.mocked(pickFilesToAdd).mockResolvedValueOnce([]);

    const container = document.createElement("div");
    const pane = new SectionsPane(container, store, () => {});
    pane.render();
    clickAddButton(container);

    await new Promise((r) => setTimeout(r, 0));

    const files = store.getSection(section.id)?.files ?? [];
    expect(files).toHaveLength(1);
    expect(store.getActiveFileId()).toBe(already.id);
  });
});
