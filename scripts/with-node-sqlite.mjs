import { spawnSync } from "node:child_process"

const [command, ...args] = process.argv.slice(2)

if (!command) {
  console.error("Usage: node scripts/with-node-sqlite.mjs <command> [args...]")
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

let testStatus = 1
try {
  console.log("Rebuilding better-sqlite3 for the current Node runtime...")
  const rebuildStatus = run("npm", ["rebuild", "better-sqlite3"])
  if (rebuildStatus !== 0) {
    testStatus = rebuildStatus
  } else {
    testStatus = run(command, args)
  }
} catch (error) {
  console.error(error)
} finally {
  console.log("Restoring native modules for Electron...")
  try {
    const restoreStatus = run("pnpm", [
      "exec",
      "electron-rebuild",
      "-f",
      "-w",
      "better-sqlite3,node-pty",
    ])
    if (restoreStatus !== 0 && testStatus === 0) testStatus = restoreStatus
  } catch (error) {
    console.error(error)
  }
}

process.exit(testStatus)
