// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetSessionStateForTests,
  addToDictionary,
  findMisspellings,
  ignoreWord,
  suggest,
  tokenize,
} from "./engine";

beforeEach(() => {
  _resetSessionStateForTests();
  localStorage.clear();
});

describe("tokenize", () => {
  it("splits plain words with offsets", () => {
    expect(tokenize("hello world")).toEqual([
      { word: "hello", from: 0, to: 5 },
      { word: "world", from: 6, to: 11 },
    ]);
  });

  it("keeps contractions as a single token", () => {
    expect(tokenize("don't stop")).toEqual([
      { word: "don't", from: 0, to: 5 },
      { word: "stop", from: 6, to: 10 },
    ]);
  });

  it("splits hyphenated compounds into separate tokens", () => {
    expect(tokenize("well-known co-worker")).toEqual([
      { word: "well", from: 0, to: 4 },
      { word: "known", from: 5, to: 10 },
      { word: "co", from: 11, to: 13 },
      { word: "worker", from: 14, to: 20 },
    ]);
  });

  it("ignores digits and punctuation", () => {
    expect(tokenize("v1.4.0 released!")).toEqual([
      { word: "v", from: 0, to: 1 },
      { word: "released", from: 7, to: 15 },
    ]);
  });
});

describe("findMisspellings", () => {
  it("flags pre-existing misspelled words in text that was never typed", async () => {
    const text = "This is a tset of the speling checker.";
    const misspelled = await findMisspellings(text);
    expect(misspelled.map((m) => m.word)).toEqual(["tset", "speling"]);
  });

  it("does not flag correctly spelled words", async () => {
    const misspelled = await findMisspellings("The quick brown fox jumps over the lazy dog.");
    expect(misspelled).toEqual([]);
  });

  it("does not flag hyphenated compounds whose parts are all valid", async () => {
    const misspelled = await findMisspellings("a well-known state-of-the-art co-worker");
    expect(misspelled).toEqual([]);
  });

  it("skips all-uppercase acronyms", async () => {
    const misspelled = await findMisspellings("Sectionist uses GTK and HTML.");
    expect(misspelled.map((m) => m.word)).toEqual(["Sectionist"]);
  });

  it("respects session-ignored words", async () => {
    expect((await findMisspellings("speling")).map((m) => m.word)).toEqual(["speling"]);
    ignoreWord("speling");
    expect((await findMisspellings("speling")).map((m) => m.word)).toEqual([]);
  });

  it("persists added words across the personal dictionary", async () => {
    expect((await findMisspellings("Sectionist")).map((m) => m.word)).toEqual(["Sectionist"]);
    await addToDictionary("Sectionist");
    expect((await findMisspellings("Sectionist")).map((m) => m.word)).toEqual([]);
    expect(JSON.parse(localStorage.getItem("sectionist.spellcheck.personalDictionary")!)).toContain(
      "Sectionist",
    );
  });
});

describe("suggest", () => {
  it("offers the correct spelling as a suggestion", async () => {
    expect(await suggest("speling")).toContain("spelling");
  });
});
