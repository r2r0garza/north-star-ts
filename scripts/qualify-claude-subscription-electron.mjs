// Transport-only package; never loads the application, database, or real login.
// These build-time substitutions exist only in the disposable qualification bundle:
// synthetic account eligibility, synthetic key/config and loopback admission upstream.
import { build } from "vite"
import { mkdir, writeFile, readFile, rm, mkdtemp } from "node:fs/promises"
import { spawn } from "node:child_process"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import assert from "node:assert/strict"

assert.equal(process.platform, "win32")
const project = resolve("out/claude-subscription-qualification")
await mkdir(project, { recursive: true })
await writeFile(
  join(project, "package.json"),
  JSON.stringify({
    name: "ns-transport-qualification",
    version: "0.0.1",
    main: "main.cjs",
  })
)
await writeFile(
  join(project, "descendant.cjs"),
  `const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000)`
)
await build({
  configFile: false,
  plugins: [
    {
      name: "synthetic-loopback-only",
      enforce: "pre",
      transform(source, id) {
        const file = id.replaceAll("\\", "/")
        if (file.endsWith("/claude-subscription/windows-state.ts"))
          return source.replace(
            "if (signal.aborted || result.aborted) throw aborted()",
            `if (signal.aborted || result.aborted) throw aborted(); console.log(JSON.stringify({securityProbe:{exitCode:result.exitCode,timedOut:result.timedOut,truncated:result.outputTruncated,spawnFailed:!!result.spawnError}}))`
          )
        if (file.endsWith("/claude-subscription/auth-policy.ts"))
          return "export async function verifyPersonalSubscription() {}"
        if (file.endsWith("/claude-subscription/setup.ts"))
          return (
            source.replace(
              "export function guardEnvironment(",
              "function productionGuardEnvironment("
            ) +
            `\nexport function guardEnvironment(env: NodeJS.ProcessEnv) { return {...productionGuardEnvironment(env), ANTHROPIC_API_KEY:'synthetic-not-a-real-key', CLAUDE_CONFIG_DIR:process.env.HOME+'/.claude'} }`
          )
        if (file.endsWith("/claude-subscription/admission.ts"))
          return (
            source.replace(
              "export function startAdmission(",
              "function productionStartAdmission("
            ) +
            `\nexport async function startAdmission(options: RelayOptions) { const relay = await startTestAdmission({...options, upstream:(globalThis as any).__qualification.origin}); (globalThis as any).__qualification.relay=relay; return relay }`
          )
      },
    },
  ],
  ssr: { noExternal: true, external: ["electron"] },
  build: {
    ssr: resolve("scripts/qualify-claude-subscription-electron-main.ts"),
    outDir: project,
    emptyOutDir: false,
    minify: false,
    rollupOptions: { output: { format: "cjs", entryFileNames: "main.cjs" } },
  },
})
const config = {
  appId: "local.northstar.transportqualification",
  productName: "NS Transport Qualification",
  electronVersion: JSON.parse(
    await readFile("node_modules/electron/package.json", "utf8")
  ).version,
  electronDist: resolve("node_modules/electron/dist"),
  directories: {
    output: resolve("out/claude-subscription-qualification-package"),
  },
  files: ["main.cjs", "package.json"],
  extraResources: [
    {
      from: join(project, "descendant.cjs"),
      to: "qualification-descendant.cjs",
    },
  ],
  win: { target: "dir", signAndEditExecutable: false },
  npmRebuild: false,
}
await writeFile(join(project, "builder.json"), JSON.stringify(config))
async function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options })
    child.once("error", reject)
    child.once("exit", (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`qualification process exit ${code}`))
    )
  })
}
const { createRequire } = await import("node:module")
const require = createRequire(import.meta.url)
await run(process.execPath, [
  require.resolve("electron-builder/cli.js"),
  "--dir",
  `--${process.arch}`,
  "--projectDir",
  project,
  "--config",
  join(project, "builder.json"),
])
const root = await mkdtemp(join(tmpdir(), "ns-packaged space-é-"))
try {
  const exe = join(
    config.directories.output,
    `win-${process.arch}-unpacked`,
    "NS Transport Qualification.exe"
  )
  const env = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: root,
    TMP: root,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    APPDATA: join(root, "home", "AppData", "Roaming"),
    LOCALAPPDATA: join(root, "home", "AppData", "Local"),
    Path: join(process.env.SystemRoot, "System32"),
    NS_QUALIFICATION_ROOT: root,
    NS_QUALIFICATION_CLI: join(
      process.env.USERPROFILE || process.env.HOME,
      ".local",
      "bin",
      "claude.exe"
    ),
  }
  // Copy only the public executable, never account/configuration state.
  const { copyFile } = await import("node:fs/promises")
  await mkdir(join(env.HOME, ".local", "bin"), { recursive: true })
  await copyFile(
    env.NS_QUALIFICATION_CLI,
    join(env.HOME, ".local", "bin", "claude.exe")
  )
  delete env.NS_QUALIFICATION_CLI
  await run(exe, [], { env, cwd: root })
  console.log(await readFile(join(root, "result.json"), "utf8"))
} finally {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
}
