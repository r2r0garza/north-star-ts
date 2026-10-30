// Plan 119 Phase D qualification: runs every layer of the Electron app
// capability against real Electron and prints a qualification record.
//   1. Raw test-instance contract (scripts/qualify-electron-test-instance.mjs)
//   2. Manager, window control and electron_run against fixtures and this
//      repo's North Star build (ELECTRON_APPS_NORTH_STAR=1)
//   3. Tool, approval and validator contract tests
// Run `pnpm build` first. Exits non-zero if anything fails.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs"
import { arch, platform, release, tmpdir } from "node:os"
import { join } from "node:path"

if (!existsSync("out/main/index.js")) {
  console.error("out/main/index.js missing — run `pnpm build` first.")
  process.exit(1)
}

const temp = mkdtempSync(join(tmpdir(), "electron-apps-qualify-"))
const run = (label, command, args, env = {}) => {
  const started = Date.now()
  const result = spawnSync(command, args, {
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  return { label, ok: result.status === 0, ms: Date.now() - started, output: `${result.stdout}${result.stderr}` }
}

const contract = run("test-instance contract", "node", ["scripts/qualify-electron-test-instance.mjs"])
const report = join(temp, "vitest.json")
const suites = run(
  "electron-apps + tools",
  // Not via with-node-sqlite.mjs: that swaps better-sqlite3 to the Node ABI,
  // and the real North Star launched under Electron then cannot open its DB.
  // These suites need no SQLite.
  "pnpm",
  [
    "vitest",
    "run",
    "src/main/electron-apps",
    "src/main/agent/tools/electron",
    "src/main/agent/approval/approval.test.ts",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { ELECTRON_APPS_NORTH_STAR: "1" }
)

let tests = []
try {
  tests = JSON.parse(readFileSync(report, "utf8")).testResults.flatMap((file) =>
    file.assertionResults.map((t) => ({
      file: file.name.replace(`${process.cwd()}/`, ""),
      name: t.fullName,
      status: t.status,
      ms: Math.round(t.duration ?? 0),
    }))
  )
} catch {
  // The suite failed before writing a report; its output is printed below.
}
rmSync(temp, { recursive: true, force: true })

const count = (status) => tests.filter((t) => t.status === status).length
const record = {
  date: new Date().toISOString(),
  os: `${platform()} ${release()} ${arch()}`,
  node: process.version,
  electron: JSON.parse(readFileSync("node_modules/electron/package.json", "utf8")).version,
  backend: "North Star CDP client over --remote-debugging-pipe (no Playwright, no TCP port)",
  launchMode: "development (workspace node_modules/electron + app entry); packaged targets unsupported",
  inputMethod: "CDP Input.* (mouse/keys/insertText); native <select> dom-assisted; native OS input not qualified",
  contract: { ok: contract.ok, ms: contract.ms, checks: contract.output.split("\n").filter((l) => /^(PASS|FAIL) /.test(l)) },
  suites: { ok: suites.ok, ms: suites.ms, passed: count("passed"), failed: count("failed"), skipped: count("pending") + count("skipped") },
  failures: tests.filter((t) => t.status === "failed").map((t) => `${t.file}: ${t.name}`),
  liveTimings: tests
    .filter((t) => /live\.test/.test(t.file) && t.status === "passed")
    .map((t) => `${t.ms} ms  ${t.name}`),
}
console.log(JSON.stringify(record, null, 2))
if (!contract.ok) console.log(contract.output.slice(-3000))
if (!suites.ok && tests.length === 0) console.log(suites.output.slice(-3000))
process.exitCode = contract.ok && suites.ok ? 0 : 1
