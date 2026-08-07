import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

// Unit tests for pure main-process logic (the approval pipeline today). The
// Electron app itself is built/run via electron-vite; this config only drives
// node-environment unit tests so they run without an Electron context.
export default defineConfig({
  resolve: {
    alias: {
      // Mirror electron-vite's renderer alias so a few renderer component tests
      // can import via "@/…" the same way the app does.
      "@": fileURLToPath(new URL("./src/renderer/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Node by default (pure main-process logic). A few renderer component tests
    // opt into a DOM via a per-file `@vitest-environment happy-dom` docblock, so
    // .test.tsx is matched too.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
})
