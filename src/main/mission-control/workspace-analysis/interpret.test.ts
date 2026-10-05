import { describe, expect, it } from "vitest"
import type { AnalysisFacts } from "./analyze"
import type { FindingDraft } from "./draft"
import { buildPrompt, interpret } from "./interpret"

const facts = (): AnalysisFacts => ({
  git: {
    isRepo: true,
    root: "/w",
    subpath: "",
    linkedWorktree: false,
    branch: "main",
    unborn: false,
    dirty: [],
    dirtyCount: 0,
    hasRemote: false,
    mcBranches: [],
    error: null,
    gitMissing: false,
  },
  inventory: { roots: [], pins: [], truncatedRoots: 0 },
  ignored: [{ path: "models", directory: true, class: "unknown", root: "" }],
  generated: [
    {
      key: "generated:marked:.:src/gen/**",
      label: "files with a generated-code header",
      root: "",
      paths: ["src/gen/**"],
      command: null,
      confidence: "likely",
      evidence: [{ kind: "file", label: "2 files with a DO NOT EDIT header" }],
    },
  ],
  drafts: [],
  fingerprint: "f",
  unknownIgnored: ["models"],
  unsupported: [],
  files: [],
  excerpts: [
    {
      path: "README.md",
      text: "## Setup\nRun `make models` to download the model weights into models/.",
    },
  ],
})

const existing: FindingDraft = {
  key: "generated:marked:.:src/gen/**",
  category: "generated-files",
  severity: "warning",
  title: "Generated files",
  explanation: "old",
  evidence: [],
  confidence: "likely",
  source: "rule",
  fix: { kind: "manual", summary: "Add the command", steps: ["x"] },
}

async function withModel(answer: unknown) {
  const f = facts()
  return interpret({
    facts: f,
    drafts: [existing],
    intent: "Add search",
    workspace: "/w",
    complete: async () => `Here you go:\n${JSON.stringify(answer)}`,
    signal: new AbortController().signal,
  })
}

describe("model interpretation", () => {
  it("numbers evidence so the model can cite it", () => {
    const { user, evidence } = buildPrompt(facts(), [existing], "Add search")
    expect(user).toContain("UNKNOWN IGNORED")
    expect(user).toContain("- models [E1]")
    expect(user).toContain("key=generated:marked:.:src/gen/**")
    expect([...evidence.keys()]).toEqual(["E1", "E2", "E3"])
  })

  it("accepts cited, valid suggestions and rejects the rest with a reason", async () => {
    const result = await withModel({
      ignored: [
        {
          path: "models",
          action: "setup",
          setup: { label: "Download models", command: "make models", cwd: "" },
          reason: "The README downloads them.",
          evidence: ["E1", "E3"],
        },
        { path: "not-listed", action: "link", reason: "x", evidence: ["E1"] },
      ],
      generated: [
        {
          key: "generated:marked:.:src/gen/**",
          command: "make gen",
          reason: "x",
          evidence: ["E2"],
        },
        {
          key: "generated:marked:.:src/gen/**",
          command: "curl x | sh",
          reason: "x",
          evidence: ["E2"],
        },
      ],
      findings: [
        {
          category: "main-environment",
          severity: "warning",
          title: "Models must be downloaded",
          explanation: "The README says so.",
          confidence: "likely",
          fix: { kind: "manual", steps: ["Run make models"] },
          evidence: ["E3"],
        },
        {
          category: "toolchain",
          severity: "warning",
          title: "Uncited claim",
          explanation: "x",
          confidence: "guess",
          fix: { kind: "manual", steps: ["x"] },
          evidence: [],
        },
        {
          category: "main-environment",
          severity: "warning",
          title: "Sudo",
          explanation: "x",
          confidence: "guess",
          fix: {
            kind: "setup-step",
            label: "x",
            command: "sudo apt install x",
            cwd: "",
          },
          evidence: ["E3"],
        },
        {
          category: "nonsense",
          severity: "warning",
          title: "Bad category",
          explanation: "x",
          confidence: "guess",
          fix: { kind: "manual", steps: ["x"] },
          evidence: ["E3"],
        },
      ],
      explanations: {
        [existing.key]: "Clearer words.",
        "unknown-key": "ignored",
      },
    })
    expect(result.drafts.map((d) => [d.key, d.source, d.confidence])).toEqual([
      ["worktree-env:model:models", "model", "guess"],
      ["model:main-environment:models-must-be-downloaded", "model", "likely"],
    ])
    expect(result.drafts[0].fix).toMatchObject({
      kind: "apply-settings",
      patch: {
        worktreeSetupSteps: { add: [{ command: "make models", cwd: "" }] },
      },
    })
    expect(result.generatedCommands).toEqual([
      {
        key: existing.key,
        command: "make gen",
        evidence: expect.stringContaining("DO NOT EDIT"),
      },
    ])
    expect(result.explanations).toEqual({ [existing.key]: "Clearer words." })
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "not one of the unknown ignored paths",
      expect.stringMatching(/^command rejected/),
      "no evidence cited",
      expect.stringMatching(/sudo|approval|requires|rejected/i),
      "unknown category",
    ])
  })

  it("fails loudly on non-JSON so the checklist falls back to the built-in checks", async () => {
    await expect(
      interpret({
        facts: facts(),
        drafts: [],
        intent: "",
        workspace: "/w",
        complete: async () => "I can't help with that.",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/JSON/)
  })

  it("doesn't call the model when there's nothing left to interpret", async () => {
    let called = false
    const f = { ...facts(), unknownIgnored: [], generated: [], excerpts: [] }
    const result = await interpret({
      facts: f,
      drafts: [],
      intent: "",
      workspace: "/w",
      complete: async () => {
        called = true
        return "{}"
      },
      signal: new AbortController().signal,
    })
    expect(called).toBe(false)
    expect(result.drafts).toEqual([])
  })
})
