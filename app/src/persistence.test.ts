import { describe, expect, it, vi } from "vitest";
import { defaultState } from "./types";

const files = new Map<string, string>();

vi.mock("./native", () => ({
  appConfigDir: vi.fn(async () => "/config"),
  pathJoin: vi.fn(async (dir: string, name: string) => `${dir}/${name}`),
  readTextFile: vi.fn(async (path: string) => {
    const contents = files.get(path);
    if (contents === undefined) throw new Error("not found");
    return contents;
  }),
  writeTextFile: vi.fn(async (path: string, contents: string) => {
    files.set(path, contents);
  }),
}));

import { loadState } from "./persistence";

describe("loadState", () => {
  it("returns defaultState() when no state.json exists yet (first run)", async () => {
    files.clear();
    expect(await loadState()).toEqual(defaultState());
  });

  it("backfills missing fields with defaults for a state.json from an older version", async () => {
    files.clear();
    // Simulates a file saved before "theme"/"editorFont" existed.
    files.set(
      "/config/state.json",
      JSON.stringify({
        version: 1,
        sections: [],
        activeFileId: null,
        sectionsPaneVisible: true,
        sectionsPaneWidth: 280,
        wordWrap: true,
        zoom: 1,
      }),
    );
    const state = await loadState();
    expect(state.theme).toBe("light");
    expect(state.editorFont).toBe("default");
  });

  it("preserves every field already present in a fully up-to-date state.json", async () => {
    files.clear();
    const saved = { ...defaultState(), theme: "dark", editorFont: "consolas", zoom: 1.5 };
    files.set("/config/state.json", JSON.stringify(saved));
    expect(await loadState()).toEqual(saved);
  });
});
