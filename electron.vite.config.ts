import { resolve } from "path"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  main: {
    // Keep node_modules (portkey-ai, electron) external to the main bundle.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          // Preload for the agent-browser chrome window (URL bar + reload).
          "browser-chrome": resolve(
            __dirname,
            "src/preload/browser-chrome.ts"
          ),
          // Preload injected into the agent-browser page for element-pick mode.
          "browser-pick": resolve(__dirname, "src/preload/browser-pick.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          // The agent-browser chrome page loaded by the secondary window.
          browser: resolve(__dirname, "src/renderer/browser.html"),
        },
      },
    },
  },
})
