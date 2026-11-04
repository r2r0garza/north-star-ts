import { build } from "vite"
import react from "@vitejs/plugin-react"
import { resolve, join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import assert from "node:assert/strict"
const output = resolve(".cowork/.tmp/openui-phase-c")
await mkdir(output, { recursive: true })
await build({
  configFile: false,
  build: {
    ssr: resolve("scripts/fixtures/openui-durable-main.ts"),
    outDir: output,
    emptyOutDir: false,
    rollupOptions: {
      external: ["electron", "better-sqlite3"],
      output: { format: "cjs", entryFileNames: "main.cjs" },
    },
  },
})
await writeFile(
  join(output, "preload.cjs"),
  `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixture',{reference:()=>ipcRenderer.invoke('fixture:reference')});contextBridge.exposeInMainWorld('cowork',{db:{artifacts:{read:(...args)=>ipcRenderer.invoke('fixture:read',...args)}}});`
)
const result = await build({
  configFile: false,
  root: resolve("scripts/fixtures"),
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@": resolve("src/renderer/src") } },
  build: {
    outDir: join(output, "renderer"),
    emptyOutDir: true,
    rollupOptions: { input: resolve("scripts/fixtures/openui-durable.html") },
  },
})
for (const chunk of result.output ?? [])
  if (chunk.type === "chunk") {
    assert.ok(
      !Object.keys(chunk.modules).some(
        (name) =>
          name.includes("@openuidev/react-lang") ||
          name.includes("@openuidev/devtools")
      )
    )
    assert.ok(!chunk.code.includes("cdn.jsdelivr.net"))
  }
console.log("Durable replay fixture built without React-lang or CDN devtools")
