import { build } from "vite"
import react from "@vitejs/plugin-react"
import { mkdir, writeFile, readdir, stat } from "node:fs/promises"
import { resolve, join } from "node:path"
import assert from "node:assert/strict"

const output = resolve(".cowork/.tmp/openui-phase-b")
await mkdir(output, { recursive: true })
const result = await build({
  configFile: false,
  root: resolve("scripts/fixtures"),
  base: "./",
  mode: "production",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [react()],
  resolve: { alias: { "@": resolve("src/renderer/src") } },
  build: {
    outDir: join(output, "renderer"),
    emptyOutDir: true,
    rollupOptions: { input: resolve("scripts/fixtures/openui.html") },
  },
})
for (const chunk of result.output ?? []) {
  if (chunk.type !== "chunk") continue
  assert.ok(
    !/cdn\.jsdelivr\.net|openui\.devtools\.autoMount|devtools\.browser\.js/.test(
      chunk.code
    ),
    "CDN bootstrap must not ship"
  )
  assert.ok(
    !Object.keys(chunk.modules).some((name) =>
      name.includes("@openuidev/devtools")
    ),
    "Devtools must not enter build graph"
  )
}
await writeFile(
  join(output, "main.cjs"),
  `
const { app, BrowserWindow, session } = require("electron");
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith("file://");
    if (!allowed) console.error("Blocked fixture request:", details.url);
    callback({ cancel: !allowed });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const window = new BrowserWindow({ width: 1050, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.loadFile(require("node:path").join(__dirname, "renderer/openui.html"));
});
app.on("window-all-closed", () => app.quit());
`
)
let bytes = 0
for (const name of await readdir(join(output, "renderer/assets")))
  bytes += (await stat(join(output, "renderer/assets", name))).size
console.log(
  JSON.stringify({ output, assetsBytes: bytes, noCdnBootstrap: true })
)
