// Covers the safety-critical behaviors called out in AGENTS.md: section
// CRUD/persistence, file membership/dedup/sorting, save/save-as, unsaved
// recovery buffers, external modification, and unavailable files. All native
// (Tauri) and persistence I/O is faked in-memory so these run under plain
// Node without a webview.

import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = new Map<string, string>();
let fileEventHandler: ((payload: { path: string; kind: "modified" | "removed" }) => void) | null =
  null;
const watchedPaths = new Set<string>();

const diskEncoding = new Map<string, string>();
const undecodablePaths = new Set<string>();

vi.mock("./native", () => ({
  readTextFileWithEncoding: vi.fn(async (path: string) => {
    if (!disk.has(path)) throw new Error(`ENOENT: ${path}`);
    if (undecodablePaths.has(path)) throw new Error("Unsupported Encoding");
    return { contents: disk.get(path)!, encoding: diskEncoding.get(path) ?? "utf8" };
  }),
  writeTextFileWithEncoding: vi.fn(async (path: string, contents: string, encoding: string) => {
    disk.set(path, contents);
    diskEncoding.set(path, encoding);
  }),
  pathMetadata: vi.fn(async (path: string) => ({
    exists: disk.has(path),
    isFile: disk.has(path),
    modifiedMs: null,
    size: disk.has(path) ? disk.get(path)!.length : null,
  })),
  watchPath: vi.fn(async (path: string) => {
    watchedPaths.add(path);
  }),
  unwatchPath: vi.fn(async (path: string) => {
    watchedPaths.delete(path);
  }),
  onFileEvent: vi.fn(async (handler: typeof fileEventHandler) => {
    fileEventHandler = handler;
    return () => {
      fileEventHandler = null;
    };
  }),
  showError: vi.fn(async () => {}),
}));

vi.mock("./persistence", () => ({
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

import { writeTextFileWithEncoding } from "./native";
import * as persistence from "./persistence";
import { Store } from "./store";

function triggerFileEvent(payload: { path: string; kind: "modified" | "removed" }) {
  fileEventHandler?.(payload);
}

async function newStore(): Promise<Store> {
  const store = new Store();
  await store.init();
  return store;
}

beforeEach(() => {
  disk.clear();
  diskEncoding.clear();
  undecodablePaths.clear();
  watchedPaths.clear();
  fileEventHandler = null;
  vi.clearAllMocks();
});

describe("sections", () => {
  it("creates sections with unique ids even when names collide", async () => {
    const store = await newStore();
    const a = store.createSection("Notes");
    const b = store.createSection("Notes");
    expect(a.id).not.toBe(b.id);
    expect(store.getSections().map((s) => s.name)).toEqual(["Notes", "Notes"]);
  });

  it("renames, toggles expansion, and reorders sections", async () => {
    const store = await newStore();
    const a = store.createSection("A");
    const b = store.createSection("B");

    store.renameSection(a.id, "Renamed");
    expect(store.getSection(a.id)?.name).toBe("Renamed");

    expect(store.getSection(a.id)?.expanded).toBe(true);
    store.toggleExpanded(a.id);
    expect(store.getSection(a.id)?.expanded).toBe(false);

    store.reorderSections([b.id, a.id]);
    expect(store.getSections().map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it("expands or collapses every section at once", async () => {
    const store = await newStore();
    const a = store.createSection("A");
    const b = store.createSection("B");
    store.toggleExpanded(b.id); // b starts collapsed, a starts expanded

    store.collapseAllSections();
    expect(store.getSection(a.id)?.expanded).toBe(false);
    expect(store.getSection(b.id)?.expanded).toBe(false);

    store.expandAllSections();
    expect(store.getSection(a.id)?.expanded).toBe(true);
    expect(store.getSection(b.id)?.expanded).toBe(true);
  });

  it("closing a section removes only its own file references, never touching disk", async () => {
    disk.set("/notes/a.txt", "hello");
    const store = await newStore();
    const section = store.createSection("A");
    store.addFileToSection(section.id, "/notes/a.txt");

    store.closeSection(section.id);

    expect(store.getSections()).toHaveLength(0);
    expect(disk.get("/notes/a.txt")).toBe("hello"); // untouched
    expect(writeTextFileWithEncoding).not.toHaveBeenCalled();
  });

  it("keeps a file open, dirty, and active in a surviving section when the other section referencing it is closed", async () => {
    disk.set("/notes/shared.txt", "original");
    const store = await newStore();
    const sectionA = store.createSection("A");
    const sectionB = store.createSection("B");
    const refA = store.addFileToSection(sectionA.id, "/notes/shared.txt")!;
    store.addFileToSection(sectionB.id, "/notes/shared.txt");
    await store.setActiveFile(refA.id);
    store.updateActiveFileContent("unsaved edit");

    store.closeSection(sectionA.id);

    expect(store.getSections().map((s) => s.name)).toEqual(["B"]);
    expect(store.getActiveFileId()).toBe(refA.id); // never nulled out
    const open = store.getOpenFile(refA.id);
    expect(open?.dirty).toBe(true);
    expect(open?.content).toBe("unsaved edit"); // not reloaded from disk
  });

  it("discards an unsaved buffer's recovery entry when its section is closed", async () => {
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.createUnsavedFileInSection(section.id)!;
    store.updateActiveFileContent("some in-progress text");
    store.flushPersistence();
    expect(persistence.saveRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ [ref.id]: expect.anything() }),
    );

    store.closeSection(section.id);
    store.flushPersistence();

    const lastCall = vi.mocked(persistence.saveRecovery).mock.calls.at(-1)![0];
    expect(lastCall[ref.id]).toBeUndefined();
  });
});

describe("file membership", () => {
  it("dedups the same path within a section instead of adding a second reference", async () => {
    const store = await newStore();
    const section = store.createSection("A");
    const first = store.addFileToSection(section.id, "/notes/a.txt");
    const second = store.addFileToSection(section.id, "/notes/a.txt");
    expect(first?.id).toBe(second?.id);
    expect(store.getSection(section.id)?.files).toHaveLength(1);
  });

  it("treats paths that differ only by case/separator as the same file (Windows-safe identity)", async () => {
    const store = await newStore();
    const section = store.createSection("A");
    store.addFileToSection(section.id, "C:\\Notes\\a.txt");
    store.addFileToSection(section.id, "c:/notes/A.TXT");
    expect(store.getSection(section.id)?.files).toHaveLength(1);
  });

  it("sorts editable files alphabetically and separates launchable files", async () => {
    const store = await newStore();
    const section = store.createSection("A");
    store.addFileToSection(section.id, "/notes/zebra.txt");
    store.addFileToSection(section.id, "/notes/apple.md");
    store.addFileToSection(section.id, "/notes/mango.txt");
    store.addFileToSection(section.id, "/notes/photo.png");

    const s = store.getSection(section.id)!;
    expect(store.editableFiles(s).map((f) => f.path)).toEqual([
      "/notes/apple.md",
      "/notes/mango.txt",
      "/notes/zebra.txt",
    ]);
    expect(store.launchableFiles(s).map((f) => f.path)).toEqual(["/notes/photo.png"]);
  });

  it("removes a file from a section without deleting it from disk", async () => {
    disk.set("/notes/a.txt", "content");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;

    store.removeFileFromSection(section.id, ref.id);

    expect(store.getSection(section.id)?.files).toHaveLength(0);
    expect(disk.has("/notes/a.txt")).toBe(true);
  });

  it("adding a new editable file to a section makes it the active file", async () => {
    disk.set("/notes/a.txt", "hello");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;

    expect(store.getActiveFileId()).toBe(ref.id);
  });

  it("adding a new launchable file to a section does not change the active file", async () => {
    disk.set("/notes/a.txt", "hello");
    disk.set("/notes/photo.png", "");
    const store = await newStore();
    const section = store.createSection("A");
    const textRef = store.addFileToSection(section.id, "/notes/a.txt")!;
    store.addFileToSection(section.id, "/notes/photo.png");

    expect(store.getActiveFileId()).toBe(textRef.id);
  });

  it("flags a launchable file missing from disk at startup", async () => {
    vi.mocked(persistence.loadState).mockResolvedValueOnce({
      version: 1,
      sections: [
        {
          id: "s1",
          name: "A",
          expanded: true,
          files: [{ id: "f1", path: "/notes/missing.png", kind: "launchable" }],
        },
      ],
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
    });

    const store = await newStore();

    expect(store.isLaunchableFileUnavailable("f1")).toBe(true);
  });

  it("does not flag a launchable file that exists on disk at startup", async () => {
    disk.set("/notes/photo.png", "");
    vi.mocked(persistence.loadState).mockResolvedValueOnce({
      version: 1,
      sections: [
        {
          id: "s1",
          name: "A",
          expanded: true,
          files: [{ id: "f1", path: "/notes/photo.png", kind: "launchable" }],
        },
      ],
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
    });

    const store = await newStore();

    expect(store.isLaunchableFileUnavailable("f1")).toBe(false);
  });

  it("flags a launchable file red when it is deleted while the app is running", async () => {
    disk.set("/notes/photo.png", "");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/photo.png")!;

    expect(store.isLaunchableFileUnavailable(ref.id)).toBe(false);

    disk.delete("/notes/photo.png");
    triggerFileEvent({ path: "/notes/photo.png", kind: "removed" });

    expect(store.isLaunchableFileUnavailable(ref.id)).toBe(true);
  });

  it("stops tracking a launchable file's availability once it is removed from its only section", async () => {
    disk.set("/notes/photo.png", "");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/photo.png")!;

    disk.delete("/notes/photo.png");
    triggerFileEvent({ path: "/notes/photo.png", kind: "removed" });
    expect(store.isLaunchableFileUnavailable(ref.id)).toBe(true);

    store.removeFileFromSection(section.id, ref.id);

    expect(store.isLaunchableFileUnavailable(ref.id)).toBe(false);
  });

  it("stops tracking a launchable file's availability when its section is closed", async () => {
    disk.set("/notes/photo.png", "");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/photo.png")!;

    disk.delete("/notes/photo.png");
    triggerFileEvent({ path: "/notes/photo.png", kind: "removed" });
    expect(store.isLaunchableFileUnavailable(ref.id)).toBe(true);

    store.closeSection(section.id);

    expect(store.isLaunchableFileUnavailable(ref.id)).toBe(false);
  });

  it("keeps a launchable file's availability tracked if it is removed from only one of several sections", async () => {
    disk.set("/notes/photo.png", "");
    const store = await newStore();
    const sectionA = store.createSection("A");
    const sectionB = store.createSection("B");
    const ref = store.addFileToSection(sectionA.id, "/notes/photo.png")!;
    store.addFileToSection(sectionB.id, "/notes/photo.png");

    disk.delete("/notes/photo.png");
    triggerFileEvent({ path: "/notes/photo.png", kind: "removed" });
    expect(store.isLaunchableFileUnavailable(ref.id)).toBe(true);

    store.removeFileFromSection(sectionA.id, ref.id);

    expect(store.isLaunchableFileUnavailable(ref.id)).toBe(true);
  });

  it("closing the active file selects the next eligible file below it in the same section", async () => {
    disk.set("/notes/apple.txt", "a");
    disk.set("/notes/mango.txt", "m");
    disk.set("/notes/zebra.txt", "z");
    const store = await newStore();
    const section = store.createSection("A");
    const apple = store.addFileToSection(section.id, "/notes/apple.txt")!;
    const mango = store.addFileToSection(section.id, "/notes/mango.txt")!;
    store.addFileToSection(section.id, "/notes/zebra.txt");
    await store.setActiveFile(apple.id);

    store.removeFileFromSection(section.id, apple.id);

    expect(store.getActiveFileId()).toBe(mango.id);
  });

  it("closing the active file falls back to the next eligible file above it when nothing is below", async () => {
    disk.set("/notes/apple.txt", "a");
    disk.set("/notes/mango.txt", "m");
    disk.set("/notes/zebra.txt", "z");
    const store = await newStore();
    const section = store.createSection("A");
    store.addFileToSection(section.id, "/notes/apple.txt");
    const mango = store.addFileToSection(section.id, "/notes/mango.txt")!;
    const zebra = store.addFileToSection(section.id, "/notes/zebra.txt")!;
    await store.setActiveFile(zebra.id);

    store.removeFileFromSection(section.id, zebra.id);

    expect(store.getActiveFileId()).toBe(mango.id);
  });

  it("closing the last eligible file in a section selects the first eligible file in the next section down", async () => {
    disk.set("/notes/only.txt", "o");
    disk.set("/notes/next.txt", "n");
    const store = await newStore();
    const sectionA = store.createSection("A");
    const sectionB = store.createSection("B");
    const only = store.addFileToSection(sectionA.id, "/notes/only.txt")!;
    const next = store.addFileToSection(sectionB.id, "/notes/next.txt")!;
    await store.setActiveFile(only.id);

    store.removeFileFromSection(sectionA.id, only.id);

    expect(store.getActiveFileId()).toBe(next.id);
  });

  it("closing the last eligible file falls back to the last eligible file in a preceding section", async () => {
    disk.set("/notes/before.txt", "b");
    disk.set("/notes/only.txt", "o");
    const store = await newStore();
    const sectionA = store.createSection("A");
    const sectionB = store.createSection("B");
    const before = store.addFileToSection(sectionA.id, "/notes/before.txt")!;
    const only = store.addFileToSection(sectionB.id, "/notes/only.txt")!;
    await store.setActiveFile(only.id);

    store.removeFileFromSection(sectionB.id, only.id);

    expect(store.getActiveFileId()).toBe(before.id);
  });

  it("closing the active file never re-selects the same file even if it is still open in another section", async () => {
    disk.set("/notes/shared.txt", "s");
    const store = await newStore();
    const sectionA = store.createSection("A");
    const sectionB = store.createSection("B");
    const shared = store.addFileToSection(sectionA.id, "/notes/shared.txt")!;
    store.addFileToSection(sectionB.id, "/notes/shared.txt");
    await store.setActiveFile(shared.id);

    store.removeFileFromSection(sectionA.id, shared.id);

    expect(store.getActiveFileId()).toBeNull();
    expect(store.getSection(sectionB.id)?.files).toHaveLength(1); // still open in B
  });

  it("closing the only editable file leaves no eligible file and falls back to the empty editor", async () => {
    disk.set("/notes/photo.png", "");
    disk.set("/notes/only.txt", "o");
    const store = await newStore();
    const section = store.createSection("A");
    store.addFileToSection(section.id, "/notes/photo.png"); // launchable, never eligible
    const only = store.addFileToSection(section.id, "/notes/only.txt")!;
    await store.setActiveFile(only.id);

    store.removeFileFromSection(section.id, only.id);

    expect(store.getActiveFileId()).toBeNull();
  });

  it("moves a file reference between sections without touching disk", async () => {
    disk.set("/notes/a.txt", "content");
    const store = await newStore();
    const from = store.createSection("From");
    const to = store.createSection("To");
    const ref = store.addFileToSection(from.id, "/notes/a.txt")!;

    store.moveFileBetweenSections(ref.id, from.id, to.id);

    expect(store.getSection(from.id)?.files).toHaveLength(0);
    expect(store.getSection(to.id)?.files).toHaveLength(1);
  });
});

describe("editing, save, and save as", () => {
  it("opens a file, tracks dirty state on edit, and clears it on save", async () => {
    disk.set("/notes/a.txt", "original");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;

    const opened = await store.setActiveFile(ref.id);
    expect(opened?.status).toBe("ok");
    expect(opened?.dirty).toBe(false);

    store.updateActiveFileContent("changed");
    expect(store.getOpenFile(ref.id)?.dirty).toBe(true);

    const result = await store.saveActiveFile();
    expect(result.ok).toBe(true);
    expect(disk.get("/notes/a.txt")).toBe("changed");
    expect(store.getOpenFile(ref.id)?.dirty).toBe(false);
  });

  it("never writes the user's file until an explicit save (no autosave)", async () => {
    disk.set("/notes/a.txt", "original");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;
    await store.setActiveFile(ref.id);

    store.updateActiveFileContent("in-memory edit only");

    expect(writeTextFileWithEncoding).not.toHaveBeenCalled();
    expect(disk.get("/notes/a.txt")).toBe("original");
  });

  it("keeps an unsaved buffer in recovery data until saved", async () => {
    disk.set("/notes/a.txt", "original");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;
    await store.setActiveFile(ref.id);

    store.updateActiveFileContent("unsaved edit");
    store.flushPersistence();
    expect(persistence.saveRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        [ref.id]: { path: "/notes/a.txt", content: "unsaved edit", encoding: "utf8" },
      }),
    );

    await store.saveActiveFile();
    store.flushPersistence();
    const lastCall = vi.mocked(persistence.saveRecovery).mock.calls.at(-1)![0];
    expect(lastCall[ref.id]).toBeUndefined();
  });

  it("save as writes to the new location without touching the original file", async () => {
    disk.set("/notes/a.txt", "original");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;
    await store.setActiveFile(ref.id);
    store.updateActiveFileContent("save-as content");

    const result = await store.saveActiveFileAs("/notes/b.txt");

    expect(result.ok).toBe(true);
    expect(disk.get("/notes/b.txt")).toBe("save-as content");
    expect(disk.get("/notes/a.txt")).toBe("original");
  });

  it("save as adds the new file to the original's section, keeps the original, and activates the new file", async () => {
    disk.set("/notes/a.txt", "original");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;
    await store.setActiveFile(ref.id);
    store.updateActiveFileContent("save-as content");

    const result = await store.saveActiveFileAs("/notes/b.txt");
    expect(result.ok).toBe(true);

    const updated = store.getSection(section.id)!;
    expect(updated.files.map((f) => f.path)).toEqual(["/notes/a.txt", "/notes/b.txt"]);
    expect(store.getActiveFileId()).toBe("/notes/b.txt");
    expect(store.getOpenFile("/notes/b.txt")?.content).toBe("save-as content");
  });
});

describe("external modification and unavailable files", () => {
  it("marks the active file external-change on outside modification without discarding the buffer", async () => {
    disk.set("/notes/a.txt", "original");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;
    await store.setActiveFile(ref.id);
    store.updateActiveFileContent("my unsaved edit");

    triggerFileEvent({ path: "/notes/a.txt", kind: "modified" });

    const open = store.getOpenFile(ref.id);
    expect(open?.status).toBe("external-change");
    expect(open?.content).toBe("my unsaved edit"); // buffer preserved, not overwritten
  });

  it("marks the active file unavailable when it is removed externally", async () => {
    disk.set("/notes/a.txt", "original");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;
    await store.setActiveFile(ref.id);

    triggerFileEvent({ path: "/notes/a.txt", kind: "removed" });

    expect(store.getOpenFile(ref.id)?.status).toBe("unavailable");
  });

  it("opening a file that no longer exists fails gracefully as unavailable", async () => {
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/missing.txt")!;

    const opened = await store.setActiveFile(ref.id);

    expect(opened?.status).toBe("unavailable");
  });

  it("adding a file with an unsupported/undecodable encoding shows an error and does not add it to the section at all", async () => {
    disk.set("/notes/garbage.bin", "\x00\x01garbage");
    undecodablePaths.add("/notes/garbage.bin");
    const store = await newStore();
    const section = store.createSection("A");
    // addFileToSection fires its own internal setActiveFile; awaiting a
    // macrotask lets that fire-and-forget chain fully settle without racing
    // a second concurrent setActiveFile call for the same file.
    const ref = store.addFileToSection(section.id, "/notes/garbage.bin")!;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getActiveFileId()).toBeNull();
    expect(store.getOpenFile(ref.id)).toBeUndefined();
    expect(store.getSection(section.id)?.files).toHaveLength(0);
  });

  it("failing to add an unsupported file restores whichever file was active before the attempt", async () => {
    disk.set("/notes/a.txt", "hello");
    disk.set("/notes/garbage.bin", "\x00\x01garbage");
    undecodablePaths.add("/notes/garbage.bin");
    const store = await newStore();
    const section = store.createSection("A");
    const a = store.addFileToSection(section.id, "/notes/a.txt")!;
    await store.setActiveFile(a.id);

    store.addFileToSection(section.id, "/notes/garbage.bin");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getActiveFileId()).toBe(a.id);
    expect(store.getSection(section.id)?.files.map((f) => f.id)).toEqual([a.id]);
  });

  it("closing an unavailable/external-change file clears it, requires a fresh re-open, and removes it from its section", async () => {
    disk.set("/notes/a.txt", "original");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;
    await store.setActiveFile(ref.id);
    triggerFileEvent({ path: "/notes/a.txt", kind: "modified" });

    store.closeUnavailableFile(ref.id);

    expect(store.getOpenFile(ref.id)).toBeUndefined();
    expect(store.getActiveFileId()).toBeNull();
    expect(store.getSection(section.id)!.files).toHaveLength(0);
  });

  it("keeps a file flagged external-change across switching away and back, instead of silently reverting to ok", async () => {
    disk.set("/notes/a.txt", "original");
    disk.set("/notes/b.txt", "other");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;
    const otherRef = store.addFileToSection(section.id, "/notes/b.txt")!;
    await store.setActiveFile(ref.id);

    triggerFileEvent({ path: "/notes/a.txt", kind: "modified" });
    expect(store.getOpenFile(ref.id)?.status).toBe("external-change");

    await store.setActiveFile(otherRef.id);
    await store.setActiveFile(ref.id);

    expect(store.getOpenFile(ref.id)?.status).toBe("external-change");
  });

  it("keeps a file flagged unavailable across switching away and back, instead of silently reverting to ok", async () => {
    disk.set("/notes/a.txt", "original");
    disk.set("/notes/b.txt", "other");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;
    const otherRef = store.addFileToSection(section.id, "/notes/b.txt")!;
    await store.setActiveFile(ref.id);

    triggerFileEvent({ path: "/notes/a.txt", kind: "removed" });
    expect(store.getOpenFile(ref.id)?.status).toBe("unavailable");

    await store.setActiveFile(otherRef.id);
    await store.setActiveFile(ref.id);

    expect(store.getOpenFile(ref.id)?.status).toBe("unavailable");
  });

  it("detects an external modification of a file that isn't the active file", async () => {
    disk.set("/notes/a.txt", "original");
    disk.set("/notes/b.txt", "other");
    const store = await newStore();
    const section = store.createSection("A");
    const refA = store.addFileToSection(section.id, "/notes/a.txt")!;
    const refB = store.addFileToSection(section.id, "/notes/b.txt")!;
    await store.setActiveFile(refA.id);
    await store.setActiveFile(refB.id); // a.txt is now open in the background, not active

    triggerFileEvent({ path: "/notes/a.txt", kind: "modified" });

    expect(store.getOpenFile(refA.id)?.status).toBe("external-change");
    // Switching back to it surfaces the already-flagged status rather than
    // silently re-reading disk and losing the flag.
    await store.setActiveFile(refA.id);
    expect(store.getOpenFile(refA.id)?.status).toBe("external-change");
  });

  it("detects an external removal of a file that isn't the active file", async () => {
    disk.set("/notes/a.txt", "original");
    disk.set("/notes/b.txt", "other");
    const store = await newStore();
    const section = store.createSection("A");
    const refA = store.addFileToSection(section.id, "/notes/a.txt")!;
    const refB = store.addFileToSection(section.id, "/notes/b.txt")!;
    await store.setActiveFile(refA.id);
    await store.setActiveFile(refB.id);

    triggerFileEvent({ path: "/notes/a.txt", kind: "removed" });

    expect(store.getOpenFile(refA.id)?.status).toBe("unavailable");
    await store.setActiveFile(refA.id);
    expect(store.getOpenFile(refA.id)?.status).toBe("unavailable");
  });

  it("closing an unavailable file removes it from every section it appears in, not just one", async () => {
    disk.set("/notes/a.txt", "original");
    const store = await newStore();
    const sectionA = store.createSection("A");
    const sectionB = store.createSection("B");
    const ref = store.addFileToSection(sectionA.id, "/notes/a.txt")!;
    store.addFileToSection(sectionB.id, "/notes/a.txt");
    await store.setActiveFile(ref.id);

    triggerFileEvent({ path: "/notes/a.txt", kind: "removed" });
    store.closeUnavailableFile(ref.id);

    expect(store.getSection(sectionA.id)!.files).toHaveLength(0);
    expect(store.getSection(sectionB.id)!.files).toHaveLength(0);
  });

  it("saving an unavailable file to a new location replaces its section reference and becomes the active, editable file", async () => {
    disk.set("/notes/a.txt", "original");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;
    await store.setActiveFile(ref.id);
    store.updateActiveFileContent("recovered content");
    triggerFileEvent({ path: "/notes/a.txt", kind: "removed" });

    const result = await store.saveUnavailableFileAs(ref.id, "/notes/a-recovered.txt");

    expect(result).toEqual({ ok: true });
    expect(disk.get("/notes/a-recovered.txt")).toBe("recovered content");
    expect(store.getSection(section.id)!.files.map((f) => f.path)).toEqual(["/notes/a-recovered.txt"]);
    const newId = store.getSection(section.id)!.files[0].id;
    expect(store.getActiveFileId()).toBe(newId);
    const open = store.getOpenFile(newId);
    expect(open?.status).toBe("ok");
    expect(open?.dirty).toBe(false);
    expect(store.getOpenFile(ref.id)).toBeUndefined();
  });

  it("saving an unavailable file replaces the reference in every section it appears in", async () => {
    disk.set("/notes/a.txt", "original");
    const store = await newStore();
    const sectionA = store.createSection("A");
    const sectionB = store.createSection("B");
    const ref = store.addFileToSection(sectionA.id, "/notes/a.txt")!;
    store.addFileToSection(sectionB.id, "/notes/a.txt");
    await store.setActiveFile(ref.id);
    triggerFileEvent({ path: "/notes/a.txt", kind: "removed" });

    await store.saveUnavailableFileAs(ref.id, "/notes/a-recovered.txt");

    expect(store.getSection(sectionA.id)!.files.map((f) => f.path)).toEqual(["/notes/a-recovered.txt"]);
    expect(store.getSection(sectionB.id)!.files.map((f) => f.path)).toEqual(["/notes/a-recovered.txt"]);
  });

  it("reload discards the buffer and re-reads the file fresh from disk", async () => {
    disk.set("/notes/a.txt", "original");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;
    await store.setActiveFile(ref.id);
    store.updateActiveFileContent("my unsaved edit");
    triggerFileEvent({ path: "/notes/a.txt", kind: "modified" });
    disk.set("/notes/a.txt", "edited by another editor");

    const result = await store.reloadActiveFileFromDisk(ref.id);

    expect(result).toEqual({ ok: true });
    const open = store.getOpenFile(ref.id);
    expect(open?.status).toBe("ok");
    expect(open?.content).toBe("edited by another editor");
    expect(open?.dirty).toBe(false);
  });

  it("reload falls back to unavailable if the file is gone by the time it runs", async () => {
    disk.set("/notes/a.txt", "original");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;
    await store.setActiveFile(ref.id);
    triggerFileEvent({ path: "/notes/a.txt", kind: "modified" });
    disk.delete("/notes/a.txt");

    const result = await store.reloadActiveFileFromDisk(ref.id);

    expect(result.ok).toBe(false);
    expect(store.getOpenFile(ref.id)?.status).toBe("unavailable");
  });

  it("overwrite writes the in-memory buffer over an externally changed file, discarding the other program's changes", async () => {
    disk.set("/notes/a.txt", "original");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;
    await store.setActiveFile(ref.id);
    store.updateActiveFileContent("my unsaved edit");
    triggerFileEvent({ path: "/notes/a.txt", kind: "modified" });
    disk.set("/notes/a.txt", "edited by another editor");

    const result = await store.overwriteExternalChangeFile(ref.id);

    expect(result).toEqual({ ok: true });
    expect(disk.get("/notes/a.txt")).toBe("my unsaved edit");
    const open = store.getOpenFile(ref.id);
    expect(open?.status).toBe("ok");
    expect(open?.dirty).toBe(false);
  });

  it("saves an unavailable file back to its original location, recreating it in place", async () => {
    disk.set("/notes/a.txt", "original");
    const store = await newStore();
    const section = store.createSection("A");
    const ref = store.addFileToSection(section.id, "/notes/a.txt")!;
    await store.setActiveFile(ref.id);
    store.updateActiveFileContent("recovered content");
    triggerFileEvent({ path: "/notes/a.txt", kind: "removed" });

    const result = await store.saveUnavailableFileToOriginalLocation(ref.id);

    expect(result).toEqual({ ok: true });
    expect(disk.get("/notes/a.txt")).toBe("recovered content");
    const open = store.getOpenFile(ref.id);
    expect(open?.status).toBe("ok");
    expect(open?.dirty).toBe(false);
    // Unlike Save As, the path/identity doesn't change, so the section
    // reference stays exactly as it was.
    expect(store.getSection(section.id)!.files.map((f) => f.path)).toEqual(["/notes/a.txt"]);
  });
});

describe("view settings persistence", () => {
  it("persists word wrap, zoom, and pane visibility/width via saveState", async () => {
    const store = await newStore();
    store.setWordWrap(false);
    store.setZoom(1.5);
    store.setSectionsPaneVisible(false);
    store.setSectionsPaneWidth(340);
    store.flushPersistence();

    const lastCall = vi.mocked(persistence.saveState).mock.calls.at(-1)![0];
    expect(lastCall.wordWrap).toBe(false);
    expect(lastCall.zoom).toBe(1.5);
    expect(lastCall.sectionsPaneVisible).toBe(false);
    expect(lastCall.sectionsPaneWidth).toBe(340);
  });

  it("defaults theme to light and editorFont to default", async () => {
    const store = await newStore();
    expect(store.getTheme()).toBe("light");
    expect(store.getEditorFont()).toBe("default");
  });

  it("persists theme and editorFont via saveState, and restores them on next load", async () => {
    const store = await newStore();
    store.setTheme("programmer");
    store.setEditorFont("consolas");
    store.flushPersistence();

    expect(store.getTheme()).toBe("programmer");
    expect(store.getEditorFont()).toBe("consolas");

    const lastCall = vi.mocked(persistence.saveState).mock.calls.at(-1)![0];
    expect(lastCall.theme).toBe("programmer");
    expect(lastCall.editorFont).toBe("consolas");

    vi.mocked(persistence.loadState).mockResolvedValueOnce(lastCall);
    const restored = await newStore();
    expect(restored.getTheme()).toBe("programmer");
    expect(restored.getEditorFont()).toBe("consolas");
  });
});
