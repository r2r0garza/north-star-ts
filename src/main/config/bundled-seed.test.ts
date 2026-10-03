import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs"
import { createHash } from "crypto"
import { tmpdir } from "os"
import path from "path"

vi.mock("electron", () => ({ app: { getPath: () => tmpdir() } }))

import { seedBundledEntries } from "./bundled-seed"

let root = ""
let bundledDir = ""
let userDir = ""
let manifestPath = ""

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "bundled-seed-"))
  bundledDir = path.join(root, "bundled")
  userDir = path.join(root, "home", "agents")
  manifestPath = path.join(root, "home", "bundled-seed.json")
  mkdirSync(bundledDir)
  writeFileSync(path.join(bundledDir, "qa.agent.md"), "bundled qa")
  writeFileSync(path.join(bundledDir, "coding.agent.md"), "bundled coding")
  writeFileSync(path.join(bundledDir, ".DS_Store"), "")
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const seed = () =>
  seedBundledEntries({ kind: "agents", bundledDir, userDir, manifestPath })
const manifest = () => JSON.parse(readFileSync(manifestPath, "utf8"))

describe("seedBundledEntries", () => {
  it("copies bundled entries on first run and records them", () => {
    seed()
    expect(readFileSync(path.join(userDir, "qa.agent.md"), "utf8")).toBe(
      "bundled qa"
    )
    expect(existsSync(path.join(userDir, ".DS_Store"))).toBe(false)
    expect(manifest().agents).toEqual(["coding.agent.md", "qa.agent.md"])
    expect(Object.keys(manifest().hashes)).toEqual([
      "agents/coding.agent.md",
      "agents/qa.agent.md",
    ])
  })

  it("does not resurrect an entry the user deleted", () => {
    seed()
    rmSync(path.join(userDir, "qa.agent.md"))
    seed()
    expect(existsSync(path.join(userDir, "qa.agent.md"))).toBe(false)
  })

  it("does not overwrite an entry the user edited", () => {
    seed()
    writeFileSync(path.join(userDir, "qa.agent.md"), "mine")
    writeFileSync(path.join(bundledDir, "qa.agent.md"), "bundled qa v2")
    seed()
    expect(readFileSync(path.join(userDir, "qa.agent.md"), "utf8")).toBe("mine")
  })

  it("delivers entries added to the bundle later", () => {
    seed()
    writeFileSync(path.join(bundledDir, "new.agent.md"), "new")
    seed()
    expect(readFileSync(path.join(userDir, "new.agent.md"), "utf8")).toBe("new")
    expect(manifest().agents).toContain("new.agent.md")
  })

  it("never overwrites a pre-existing unrecorded entry, but records it", () => {
    mkdirSync(userDir, { recursive: true })
    writeFileSync(path.join(userDir, "qa.agent.md"), "pre-existing")
    seed()
    expect(readFileSync(path.join(userDir, "qa.agent.md"), "utf8")).toBe(
      "pre-existing"
    )
    expect(manifest().agents).toEqual(["coding.agent.md", "qa.agent.md"])
  })

  it("keeps other kinds' records in the shared manifest", () => {
    mkdirSync(path.dirname(manifestPath), { recursive: true })
    writeFileSync(manifestPath, JSON.stringify({ skills: ["git-commit"] }))
    seed()
    expect(manifest().skills).toEqual(["git-commit"])
    expect(manifest().agents).toHaveLength(2)
  })

  it("copies directory entries recursively (skills)", () => {
    mkdirSync(path.join(bundledDir, "my-skill", "scripts"), { recursive: true })
    writeFileSync(path.join(bundledDir, "my-skill", "scripts", "a.sh"), "x")
    seed()
    expect(
      readFileSync(path.join(userDir, "my-skill", "scripts", "a.sh"), "utf8")
    ).toBe("x")
  })

  it("refreshes an unedited copy when the bundled version changes", () => {
    seed()
    writeFileSync(path.join(bundledDir, "qa.agent.md"), "bundled qa v2")
    seed()
    expect(readFileSync(path.join(userDir, "qa.agent.md"), "utf8")).toBe(
      "bundled qa v2"
    )
    // And again for the next release: the recorded hash moved with it.
    writeFileSync(path.join(bundledDir, "qa.agent.md"), "bundled qa v3")
    seed()
    expect(readFileSync(path.join(userDir, "qa.agent.md"), "utf8")).toBe(
      "bundled qa v3"
    )
  })

  it("recognizes a copy seeded before hashes were recorded by its previous hash", () => {
    mkdirSync(userDir, { recursive: true })
    writeFileSync(path.join(userDir, "qa.agent.md"), "bundled qa v1")
    writeFileSync(path.join(userDir, "coding.agent.md"), "my coding edits")
    writeFileSync(
      manifestPath,
      JSON.stringify({ agents: ["coding.agent.md", "qa.agent.md"] })
    )
    const sha = (text: string) =>
      createHash("sha256").update(text).digest("hex")
    seedBundledEntries({
      kind: "agents",
      bundledDir,
      userDir,
      manifestPath,
      previousHashes: {
        "qa.agent.md": [sha("bundled qa v1")],
        "coding.agent.md": [sha("bundled coding v1")],
      },
    })
    expect(readFileSync(path.join(userDir, "qa.agent.md"), "utf8")).toBe(
      "bundled qa"
    )
    expect(readFileSync(path.join(userDir, "coding.agent.md"), "utf8")).toBe(
      "my coding edits"
    )
  })
})
