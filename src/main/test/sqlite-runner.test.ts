import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "../../..")
const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true })
  }
})

function runFixture(test: string, env: NodeJS.ProcessEnv = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "north-star-sqlite-runner-"))
  fixtures.push(fixture)
  mkdirSync(join(fixture, "src/main"), { recursive: true })
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({ private: true })
  )
  symlinkSync(
    join(root, "node_modules"),
    join(fixture, "node_modules"),
    "junction"
  )
  writeFileSync(
    join(fixture, "src/main/example.test.ts"),
    // Keep the discovery marker out of this non-SQLite test file itself.
    `import { it, expect } from "vitest"\n// ${"sqliteLoads" + "ForTests"}\n${test}\n`
  )
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/test-sqlite.mjs")],
    {
      cwd: fixture,
      env: { ...process.env, NO_COLOR: "1", ...env },
      encoding: "utf8",
      timeout: 20_000,
    }
  )
  expect(result.error).toBeUndefined()
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

describe("SQLite runner diagnostics", () => {
  it("prints failed assertion names, diffs, and source locations", () => {
    const result = runFixture(
      'it("reports the failing assertion", () => expect(1).toBe(2))'
    )
    expect(result.status).toBe(1)
    expect(result.output).toContain("reports the failing assertion")
    expect(result.output).toContain("expected 1 to be 2")
    expect(result.output).toContain("example.test.ts:")
  }, 30_000)

  it("still requires every assertion to run", () => {
    const result = runFixture('it.skip("must not silently skip", () => {})')
    expect(result.status).toBe(1)
    expect(result.output).toContain("must execute every assertion")
  }, 30_000)

  it("reports successful execution with zero skips", () => {
    const result = runFixture('it("passes", () => expect(1).toBe(1))')
    expect(result.status).toBe(0)
    expect(result.output).toContain("executed 1 assertions with zero skips")
  }, 30_000)

  it("prints suite loading errors", () => {
    const result = runFixture('throw new Error("suite import failed")')
    expect(result.status).toBe(1)
    expect(result.output).toContain("suite import failed")
    expect(result.output).toContain("example.test.ts:")
  }, 30_000)

  it.skipIf(process.platform === "win32")(
    "reports a failure to launch Vitest",
    () => {
      const result = runFixture('it("passes", () => {})', { PATH: "" })
      expect(result.status).toBe(1)
      expect(result.output).toContain("Failed to start SQLite tests")
      expect(result.output).toContain("ENOENT")
    },
    30_000
  )
})
