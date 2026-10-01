import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The spellcheck engine tests mount a real CodeMirror view and load the
    // ~550KB bundled dictionary; under full-suite worker contention (5
    // parallel workers) that occasionally exceeds the 5s default.
    testTimeout: 10000,
  },
});
