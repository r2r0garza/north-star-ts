import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"

import { listSource, validateName, skillScaffold } from "./loader"

let dir = ""

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "skills-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Write a scaffold into <dir>/<name>/SKILL.md, exactly as skills:create does.
function scaffoldInto(name: string, description: string, body?: string): void {
  const skillDir = path.join(dir, name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    skillScaffold(name, description, body)
  )
}

describe("validateName", () => {
  it("accepts a valid name matching its dir", () => {
    expect(validateName("my-skill", "my-skill")).toBeNull()
  })
  it("rejects a name that doesn't match the directory", () => {
    expect(validateName("foo", "bar")).toMatch(/must match directory/)
  })
  it("rejects uppercase, leading/trailing/double hyphens", () => {
    expect(validateName("Foo", "Foo")).toMatch(/lowercase/)
    expect(validateName("-foo", "-foo")).toMatch(/lowercase/)
    expect(validateName("foo-", "foo-")).toMatch(/lowercase/)
    expect(validateName("foo--bar", "foo--bar")).toMatch(/lowercase/)
  })
  it("rejects an empty name and an over-long name", () => {
    expect(validateName("", "")).toMatch(/required/)
    const long = "a".repeat(65)
    expect(validateName(long, long)).toMatch(/64/)
  })
  it("accepts digits and single interior hyphens", () => {
    expect(validateName("csv-export-2", "csv-export-2")).toBeNull()
  })
})

describe("skillScaffold round-trips through the loader", () => {
  it("produces a SKILL.md that parses with the given name + description", async () => {
    scaffoldInto("csv-export", "Formats CSV exports before upload.")
    const skills = await listSource(dir)
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe("csv-export")
    expect(skills[0].description).toBe("Formats CSV exports before upload.")
    // Starter body is present (frontmatter stripped) and NO allowed-tools are
    // injected — the scaffold no longer emits a commented hint.
    expect(skills[0].body).toContain("# csv-export")
    expect(skills[0].body).toContain("## When to use")
    expect(skills[0].allowedTools).toEqual([])
  })

  it("uses the supplied body verbatim when given", async () => {
    const body = "# Custom\n\nDo the thing, then verify it."
    scaffoldInto("custom", "A skill.", body)
    const skills = await listSource(dir)
    expect(skills).toHaveLength(1)
    expect(skills[0].body.trim()).toBe(body)
    // The starter stub's headings should NOT appear when a body is supplied.
    expect(skills[0].body).not.toContain("## Steps")
  })

  it("supplies a placeholder description when none is given", async () => {
    scaffoldInto("blank", "")
    const skills = await listSource(dir)
    expect(skills).toHaveLength(1)
    expect(skills[0].description.length).toBeGreaterThan(0)
  })

  it("quotes a description with YAML-special characters so it still parses", async () => {
    // A colon + leading quote would break naive hand-concatenated frontmatter.
    const tricky = 'Handles "quoted" keys: values, and #hashes.'
    scaffoldInto("tricky", tricky)
    const skills = await listSource(dir)
    expect(skills).toHaveLength(1)
    expect(skills[0].description).toBe(tricky)
  })
})
