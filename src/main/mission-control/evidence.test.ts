import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  evidenceDir,
  locateEvidence,
  readEvidence,
  savedEvidence,
  setEvidenceRoot,
} from "./evidence"

// Proof evidence (plan 109.05): only files in the phase run's own evidence
// directory count, and the proof view reads nothing outside the root.

const base = mkdtempSync(join(tmpdir(), "evidence-test-"))
const root = join(base, "evidence")
const outside = join(base, "outside.jpg")

beforeAll(() => {
  setEvidenceRoot(root)
  mkdirSync(join(root, "pr1"), { recursive: true })
  mkdirSync(join(root, "pr2"), { recursive: true })
  writeFileSync(join(root, "pr1", "shot.jpg"), "jpeg")
  writeFileSync(join(root, "pr1", "console.json"), "[]")
  writeFileSync(join(root, "pr2", "other.jpg"), "jpeg")
  writeFileSync(outside, "jpeg")
  symlinkSync(outside, join(root, "pr1", "link.jpg"))
})

afterAll(() => {
  setEvidenceRoot(null)
  rmSync(base, { recursive: true, force: true })
})

describe("savedEvidence", () => {
  it("keeps files in the phase run's directory, absolute or relative", async () => {
    const shot = join(root, "pr1", "shot.jpg")
    const found = await savedEvidence("pr1", [
      shot,
      "console.json",
      "missing.jpg",
      join(root, "pr2", "other.jpg"),
      "../pr2/other.jpg",
      outside,
      "link.jpg",
      join(root, "pr1"),
    ])
    expect([...found].sort()).toEqual(["console.json", shot].sort())
  })

  it("finds nothing without a root", async () => {
    setEvidenceRoot(null)
    expect(evidenceDir("pr1")).toBeNull()
    expect(await savedEvidence("pr1", ["shot.jpg"])).toEqual(new Set())
    setEvidenceRoot(root)
  })
})

describe("readEvidence", () => {
  it("returns images as data URLs and other files as paths, inside the root only", async () => {
    const shot = await readEvidence(join(root, "pr1", "shot.jpg"))
    expect(shot?.dataUrl).toBe(
      `data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}`
    )
    expect(
      (await readEvidence(join(root, "pr1", "console.json")))?.dataUrl
    ).toBeNull()
    expect(await readEvidence(outside)).toBeNull()
    expect(await readEvidence(join(root, "pr1", "link.jpg"))).toBeNull()
    expect(await readEvidence("pr1/shot.jpg")).toBeNull()
    expect(
      await locateEvidence(join(root, "pr1", "..", "..", "outside.jpg"))
    ).toBeNull()
  })
})
