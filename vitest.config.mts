import { defineConfig } from "vitest/config"

// Unit tests for pure main-process logic (the approval pipeline today). The
// Electron app itself is built/run via electron-vite; this config only drives
// node-environment unit tests so they run without an Electron context.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
