// Custom, in-app spell checker — independent of the webview's native spell
// check. WebKitGTK's own continuous spellchecker only evaluates text as it is
// typed and has no script-level way to retroactively check text already
// sitting in the editor when a file is opened (confirmed empirically across
// many approaches: cursor traversal, silent document replacement, bulk and
// per-character execCommand replays, and probing for a native "check document
// now" command — none of it works). This module replaces that mechanism
// entirely, the same way editors like Notepad++ do it: a bundled Hunspell-
// compatible dictionary (nspell + a vendored `dictionary-en` word list) plus
// our own tokenizer, checked directly against the document text regardless of
// how that text got there.
import nspell from "nspell";
// Vendored from the `dictionary-en` npm package (MIT AND BSD, see en.LICENSE)
// rather than imported from the package itself: the package's own entry point
// is Node-`fs`-based (reads these same two files at runtime via
// `fs.readFile(new URL(...))`), which doesn't work in a Vite-bundled webview,
// and its package.json `exports` field blocks importing the raw files by
// subpath specifier. Re-vendor by copying index.aff/index.dic/license from a
// newer `dictionary-en` release into this directory if the dictionary ever
// needs updating.
import enAff from "./en.aff?raw";
import enDic from "./en.dic?raw";

export interface WordRange {
  word: string;
  from: number;
  to: number;
}

interface NSpellChecker {
  correct(word: string): boolean;
  suggest(word: string): string[];
  add(word: string): NSpellChecker;
}

const PERSONAL_DICTIONARY_STORAGE_KEY = "sectionist.spellcheck.personalDictionary";

// Matches runs of letters (Unicode-aware) that may contain internal
// apostrophes (so contractions like "don't" are checked as one word, which
// is how Hunspell dictionaries expect them). Hyphens are deliberately NOT
// included here: unlike contractions, hyphenated compounds (e.g.
// "well-known", "state-of-the-art") are essentially never present as literal
// dictionary entries, so treating them as one token produced constant false
// positives in testing. Splitting on hyphens instead checks each side
// independently, which both avoids that and gives more precise underlines.
const WORD_PATTERN = /\p{L}+(?:['‘’]\p{L}+)*/gu;

export function tokenize(text: string): WordRange[] {
  const results: WordRange[] = [];
  WORD_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_PATTERN.exec(text)) !== null) {
    results.push({ word: match[0], from: match.index, to: match.index + match[0].length });
  }
  return results;
}

/** All-uppercase tokens (acronyms like "GTK", "HTML") are skipped by
 * default — a common spellchecker convention (e.g. Microsoft Word's "Ignore
 * words in UPPERCASE") since these are almost never genuine typos and would
 * otherwise dominate the flagged list in technical writing. Single letters
 * don't count (would otherwise also suppress a genuinely-misspelled
 * standalone capital, though those are rare either way). */
function isIgnoredAcronym(word: string): boolean {
  return word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase();
}

function loadPersonalDictionary(): string[] {
  try {
    const raw = localStorage.getItem(PERSONAL_DICTIONARY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === "string") : [];
  } catch {
    return [];
  }
}

function savePersonalDictionary(words: string[]): void {
  try {
    localStorage.setItem(PERSONAL_DICTIONARY_STORAGE_KEY, JSON.stringify(words));
  } catch {
    // Best-effort only; localStorage may be unavailable (e.g. private mode)
    // or full. Losing a persistent add-to-dictionary entry isn't fatal.
  }
}

// Session-only ignore list (Notepad++'s "Ignore" vs. its persistent "Add to
// Dictionary" — this is the former). Deliberately not persisted and reset
// whenever the page/app reloads.
const sessionIgnored = new Set<string>();

let checkerPromise: Promise<NSpellChecker> | null = null;

/** Lazily constructs (and caches) the shared nspell instance. Loading the
 * ~550KB dictionary and building nspell's internal word index has a real but
 * one-time cost, so this only happens the first time spell check is actually
 * needed (e.g. a file is opened with it enabled) rather than on every app
 * launch. */
function getChecker(): Promise<NSpellChecker> {
  if (!checkerPromise) {
    checkerPromise = Promise.resolve().then(() => {
      const checker = nspell(enAff, enDic) as NSpellChecker;
      for (const word of loadPersonalDictionary()) checker.add(word);
      return checker;
    });
  }
  return checkerPromise;
}

/** Preloads the dictionary without waiting on the result — call as soon as
 * spell check is known to be enabled (e.g. app startup) so the first real
 * check (see findMisspellings) doesn't pay the load cost on top of the
 * user's first edit/open. */
export function preloadDictionary(): void {
  void getChecker();
}

export async function findMisspellings(text: string): Promise<WordRange[]> {
  const checker = await getChecker();
  const misspelled: WordRange[] = [];
  for (const token of tokenize(text)) {
    if (sessionIgnored.has(token.word)) continue;
    if (isIgnoredAcronym(token.word)) continue;
    if (!checker.correct(token.word)) misspelled.push(token);
  }
  return misspelled;
}

export async function suggest(word: string): Promise<string[]> {
  const checker = await getChecker();
  return checker.suggest(word);
}

/** Ignores this exact word for the rest of the session (not persisted). */
export function ignoreWord(word: string): void {
  sessionIgnored.add(word);
}

/** Adds this word to the user's persistent personal dictionary, effective
 * immediately for the live checker and surviving app restarts. */
export async function addToDictionary(word: string): Promise<void> {
  const checker = await getChecker();
  checker.add(word);
  const words = loadPersonalDictionary();
  if (!words.includes(word)) {
    words.push(word);
    savePersonalDictionary(words);
  }
}

/** Test-only: clears session ignore state so tests don't leak between runs. */
export function _resetSessionStateForTests(): void {
  sessionIgnored.clear();
}
