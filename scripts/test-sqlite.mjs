import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

function walkFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...walkFiles(path))
    } else {
      files.push(path)
    }
  }
  return files
}

const sqliteTestFiles = walkFiles("src/main")
  .filter((file) => file.endsWith(".test.ts") || file.endsWith(".test.tsx"))
  .filter((file) => readFileSync(file, "utf8").includes("sqliteLoadsForTests"))
  .sort()

if (sqliteTestFiles.length === 0) {
  console.error("No SQLite-backed test files were discovered.")
  process.exit(1)
}

const reportPath = join(
  mkdtempSync(join(tmpdir(), "north-star-sqlite-tests-")),
  "vitest.json"
)
const vitest = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    ...sqliteTestFiles,
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ],
  {
    env: {
      ...process.env,
      COWORK_REQUIRE_SQLITE_TESTS: "1",
    },
    stdio: "inherit",
    shell: process.platform === "win32",
  }
)

let report
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"))
} catch {
  report = null
}

if (vitest.status !== 0) {
  if (report) {
    const failures = (report.testResults ?? []).filter(
      (result) => result.status === "failed"
    )
    for (const result of failures.slice(0, 3)) {
      if (result.status !== "failed") continue
      console.error(`${result.name}: ${result.message}`)
    }
    if (failures.length > 3) {
      console.error(`...and ${failures.length - 3} more failed SQLite suites.`)
    }
  }
  process.exit(vitest.status ?? 1)
}

if (!report) {
  console.error(
    `SQLite test run did not produce a JSON report at ${reportPath}`
  )
  process.exit(1)
}

if (report.numPendingTests !== 0 || report.numPendingTestSuites !== 0) {
  console.error(
    `SQLite test run must execute every assertion: ${report.numPendingTests} skipped tests across ${report.numPendingTestSuites} pending suites.`
  )
  process.exit(1)
}

console.log(
  `SQLite test run executed ${report.numPassedTests} assertions with zero skips.`
)
