// Reading/writing Sectionist's own application state and recovery data.
//
// This is deliberately separate from native.ts's file commands even though
// it calls the same read/write commands under the hood: state.json and
// recovery.json live in the app config directory and are never the user's
// actual documents. Keeping the concepts apart in code mirrors the AGENTS.md
// distinction between "saving a file" and "saving Sectionist state".

import { appConfigDir, pathJoin, readTextFile, writeTextFile } from "./native";
import { defaultState, type PersistedState, type RecoveryData } from "./types";

const STATE_FILE = "state.json";
const RECOVERY_FILE = "recovery.json";

let statePath: string | null = null;
let recoveryPath: string | null = null;

async function paths(): Promise<{ state: string; recovery: string }> {
  if (!statePath || !recoveryPath) {
    const dir = await appConfigDir();
    statePath = await pathJoin(dir, STATE_FILE);
    recoveryPath = await pathJoin(dir, RECOVERY_FILE);
  }
  return { state: statePath, recovery: recoveryPath };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const text = await readTextFile(path);
    return JSON.parse(text) as T;
  } catch {
    // Missing file on first run, or corrupt JSON. Either way, fall back to
    // defaults rather than propagating an error that would block startup.
    return null;
  }
}

export async function loadState(): Promise<PersistedState> {
  const { state } = await paths();
  const loaded = await readJson<Partial<PersistedState>>(state);
  // Merge over defaultState() rather than using the loaded object as-is: a
  // state.json written by an older Sectionist version won't have keys added
  // by later features (e.g. "theme"/"editorFont" didn't exist before 1.3.0).
  // Without this merge, those fields silently come back as undefined for
  // every upgrading user until they happen to explicitly change that
  // setting — which is exactly what caused the Themes menu to show no
  // checkmark on first launch after upgrading.
  return { ...defaultState(), ...loaded };
}

export async function saveState(state: PersistedState): Promise<void> {
  const { state: path } = await paths();
  await writeTextFile(path, JSON.stringify(state, null, 2));
}

export async function loadRecovery(): Promise<RecoveryData> {
  const { recovery } = await paths();
  const loaded = await readJson<RecoveryData>(recovery);
  return loaded ?? {};
}

export async function saveRecovery(data: RecoveryData): Promise<void> {
  const { recovery: path } = await paths();
  await writeTextFile(path, JSON.stringify(data, null, 2));
}
