import { defineConfig } from "vite";

// Fixed dev server port required by src-tauri/tauri.conf.json's `devUrl`.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
