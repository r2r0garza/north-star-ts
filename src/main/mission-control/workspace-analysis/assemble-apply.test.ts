import { vi, describe, expect, it } from "vitest"
import type { CurrentSettings } from "./analyze"
import { applyPatch, validatePatch } from "./apply"
import { assembleFindings, autoApplicable, evidenceHash } from "./assemble"
import type { FindingDraft } from "./draft"

const settings = (patch: Partial<CurrentSettings> = {}): CurrentSettings => ({
  linkPaths: [],
  steps: [],
  generatedFiles: [],
  overlapPolicy: "wait",
  ...patch,
})

function draft(
  patch: Partial<FindingDraft> & Pick<FindingDraft, "key">
): FindingDraft {
  return {
    category: "worktree-environment",
    severity: "warning",
    title: patch.key,
    explanation: "",
    evidence: [{ kind: "file", label: "x" }],
    confidence: "verified",
    source: "rule",
    fix: { kind: "manual", summary: "", steps: ["do it"] },
    ...patch,
  }
}

const link = draft({
  key: "worktree-env:link:.venv",
  fix: {
    kind: "apply-settings",
    summary: "",
    patch: { worktreeLinkPaths: { add: [".venv"] } },
  },
})
const setup = draft({
  key: "worktree-env:setup:.:uv",
  fix: {
    kind: "apply-settings",
    summary: "",
    patch: {
      worktreeSetupSteps: {
        add: [
          {
            id: "analysis:env:.:uv:0",
            label: "Install",
            command: "uv sync",
            cwd: "",
          },
        ],
      },
    },
  },
})
const regen = draft({
  key: "generated:lock:uv.lock",
  category: "generated-files",
  fix: {
    kind: "apply-settings",
    summary: "",
    patch: {
      generatedFiles: { add: [{ paths: ["uv.lock"], command: "uv lock" }] },
    },
  },
})
const parallel = draft({
  key: "git-isolation:parallel",
  category: "git-isolation",
  severity: "info",
  fix: {
    kind: "apply-settings",
    summary: "",
    patch: { overlapPolicy: "parallel" },
  },
})

describe("assembleFindings", () => {
  it("resolves what the settings already do", () => {
    const findings = assembleFindings({
      drafts: [link, setup, regen, parallel],
      settings: settings({
        linkPaths: [".venv"],
        steps: [{ id: "mine", label: "x", command: "uv sync", cwd: "" }],
        generatedFiles: [
          { paths: ["**/uv.lock"], command: "uv lock --upgrade" },
        ],
        overlapPolicy: "parallel",
      }),
      dismissals: {},
    })
    const by = Object.fromEntries(
      findings.map((f) => [
        f.key,
        `${f.status}${f.resolution ? `:${f.resolution}` : ""}`,
      ])
    )
    expect(by).toEqual({
      "worktree-env:link:.venv": "resolved:Already configured",
      "worktree-env:setup:.:uv": "resolved:Already configured",
      "generated:lock:uv.lock":
        "resolved:Already configured (with your command)",
      "git-isolation:parallel": "resolved:Already configured",
    })
  })

  it("keeps a dismissal only while the evidence is unchanged", () => {
    const dismissals = { [link.key]: evidenceHash(link) }
    expect(
      assembleFindings({ drafts: [link], settings: settings(), dismissals })[0]
        .status
    ).toBe("dismissed")
    const changed = {
      ...link,
      evidence: [{ kind: "file" as const, label: "different" }],
    }
    expect(
      assembleFindings({
        drafts: [changed],
        settings: settings(),
        dismissals,
      })[0].status
    ).toBe("open")
  })

  it("counts a configured alternative as resolved", () => {
    const withAlt = { ...link, alternatives: [setup.fix] }
    const [finding] = assembleFindings({
      drafts: [withAlt],
      settings: settings({
        steps: [{ id: "s", label: "x", command: "uv sync", cwd: "" }],
      }),
      dismissals: {},
    })
    expect(finding).toMatchObject({
      status: "resolved",
      resolution: "Configured another way",
    })
  })

  it("orders blockers first, then by category and project root", () => {
    const findings = assembleFindings({
      drafts: [
        draft({ key: "b", severity: "info" }),
        draft({
          key: "web",
          root: "web",
          category: "main-environment",
          severity: "blocker",
        }),
        draft({
          key: "api",
          root: "api",
          category: "main-environment",
          severity: "blocker",
        }),
        draft({ key: "tool", category: "toolchain", severity: "blocker" }),
      ],
      settings: settings(),
      dismissals: {},
    })
    expect(findings.map((f) => f.key)).toEqual(["tool", "api", "web", "b"])
  })
})

describe("switching to a faster link", () => {
  const linkNodeModules = draft({
    key: "worktree-env:link:dashboard/node_modules",
    fix: {
      kind: "apply-settings",
      summary: "",
      patch: { worktreeLinkPaths: { add: ["dashboard/node_modules"] } },
    },
    alternatives: [
      {
        kind: "apply-settings",
        summary: "",
        patch: {
          worktreeSetupSteps: {
            add: [
              {
                id: "analysis:env:dashboard:pnpm:0",
                label: "Install",
                command: "pnpm install --frozen-lockfile",
                cwd: "dashboard",
              },
            ],
          },
        },
      },
    ],
  })
  const step = {
    id: "analysis:env:dashboard:pnpm:0",
    label: "Install",
    command: "pnpm install --frozen-lockfile",
    cwd: "dashboard",
  }

  it("offers the link over install steps an earlier analysis added", () => {
    const [finding] = assembleFindings({
      drafts: [linkNodeModules],
      settings: settings({ steps: [{ ...step, source: "analysis" }] }),
      dismissals: {},
    })
    expect(finding).toMatchObject({ status: "open", severity: "info" })
    expect(finding.title).toMatch(/^Faster: link dashboard\/node_modules/)
    expect(finding.fix).toMatchObject({
      kind: "apply-settings",
      patch: {
        worktreeLinkPaths: { add: ["dashboard/node_modules"] },
        worktreeSetupSteps: { remove: ["analysis:env:dashboard:pnpm:0"] },
      },
    })
    // Start never removes setup on its own.
    expect(autoApplicable([finding])).toEqual([])
  })

  it("leaves the user's own install steps alone", () => {
    const [finding] = assembleFindings({
      drafts: [linkNodeModules],
      settings: settings({ steps: [{ ...step, source: "user" }] }),
      dismissals: {},
    })
    expect(finding).toMatchObject({
      status: "resolved",
      resolution: "Configured another way",
    })
  })
})

describe("autoApplicable", () => {
  it("applies only command-free verified settings, and parallel only once worktrees are covered", () => {
    const open = assembleFindings({
      drafts: [link, setup, regen, parallel],
      settings: settings(),
      dismissals: {},
    })
    expect(autoApplicable(open).map((f) => f.key)).toEqual([
      "worktree-env:link:.venv",
    ])
    const onlySafe = assembleFindings({
      drafts: [link, parallel],
      settings: settings(),
      dismissals: {},
    })
    expect(
      autoApplicable(onlySafe)
        .map((f) => f.key)
        .sort()
    ).toEqual(["git-isolation:parallel", "worktree-env:link:.venv"])
    const guessed = assembleFindings({
      drafts: [{ ...link, confidence: "likely" }, parallel],
      settings: settings(),
      dismissals: {},
    })
    expect(autoApplicable(guessed).map((f) => f.key)).toEqual([])
  })
})

describe("applyPatch", () => {
  const empty = {
    worktreeSetup: { linkPaths: [], steps: [] },
    generatedFiles: [],
  }

  it("adds links, steps in rank order, and rules without duplicating or mutating", () => {
    const current = {
      worktreeSetup: {
        linkPaths: [".env"],
        steps: [
          {
            id: "mine",
            label: "Mine",
            command: "make prep",
            cwd: "",
            source: "user" as const,
          },
        ],
      },
      generatedFiles: [{ paths: ["a/**"], command: "make gen" }],
    }
    const before = JSON.stringify(current)
    let next = applyPatch(
      current,
      {
        worktreeSetupSteps: {
          add: [
            {
              id: "analysis:database:db",
              label: "DB",
              command: "bin/rails db:prepare",
              cwd: "",
            },
          ],
        },
      },
      "db"
    )
    next = applyPatch(
      next,
      {
        worktreeSetupSteps: {
          add: [
            {
              id: "analysis:env:.:bundler:0",
              label: "Gems",
              command: "bundle install",
              cwd: "",
            },
          ],
        },
      },
      "env"
    )
    next = applyPatch(
      next,
      {
        worktreeSetupSteps: {
          add: [
            {
              id: "analysis:env:.:bundler:0",
              label: "Gems",
              command: "bundle install",
              cwd: "",
            },
          ],
        },
      },
      "env"
    )
    next = applyPatch(
      next,
      { worktreeLinkPaths: { add: [".env", "local.properties"] } },
      "cfg"
    )
    next = applyPatch(
      next,
      {
        generatedFiles: {
          add: [
            { paths: ["b/**"], command: "make gen" },
            { paths: ["a/x.ts"], command: "other" },
          ],
        },
      },
      "gen"
    )
    expect(JSON.stringify(current)).toBe(before)
    expect(next.worktreeSetup.steps.map((s) => s.command)).toEqual([
      "bundle install",
      "make prep",
      "bin/rails db:prepare",
    ])
    expect(next.worktreeSetup.steps[0]).toMatchObject({
      source: "analysis",
      findingKey: "env",
    })
    expect(next.worktreeSetup.linkPaths).toEqual([".env", "local.properties"])
    expect(next.generatedFiles).toEqual([
      { paths: ["a/**", "b/**"], command: "make gen" },
    ])
  })

  it("replaces the steps a finding saved earlier, but not ones the user edited", () => {
    const current = {
      worktreeSetup: {
        linkPaths: [],
        steps: [
          {
            id: "analysis:env:.:pip:0",
            label: "venv",
            command: "python3 -m venv .venv",
            cwd: "",
            source: "analysis" as const,
            findingKey: "worktree-env:setup:.:pip",
          },
          {
            id: "analysis:env:.:pip:1",
            label: "pip",
            command: ".venv/bin/pip install -e .",
            cwd: "",
            source: "analysis" as const,
            findingKey: "worktree-env:setup:.:pip",
          },
          {
            id: "u",
            label: "mine",
            command: ".venv/bin/pip install -e '.[docs]'",
            cwd: "",
            source: "user" as const,
            findingKey: "worktree-env:setup:.:pip",
          },
        ],
      },
      generatedFiles: [],
    }
    const next = applyPatch(
      current,
      {
        worktreeSetupSteps: {
          add: [
            {
              id: "analysis:env:.:pip:0",
              label: "venv",
              command: "python3 -m venv .venv",
              cwd: "",
            },
            {
              id: "analysis:env:.:pip:1",
              label: "pip",
              command: ".venv/bin/python -m pip install --upgrade pip",
              cwd: "",
            },
          ],
        },
      },
      "worktree-env:setup:.:pip"
    )
    expect(next.worktreeSetup.steps.map((s) => s.command)).toEqual([
      "python3 -m venv .venv",
      ".venv/bin/python -m pip install --upgrade pip",
      ".venv/bin/pip install -e '.[docs]'",
    ])
  })

  it("removes a link the user wrote when the patch says so", () => {
    const next = applyPatch(
      { ...empty, worktreeSetup: { linkPaths: [".venv"], steps: [] } },
      { worktreeLinkPaths: { remove: [".venv"] } },
      "k"
    )
    expect(next.worktreeSetup.linkPaths).toEqual([])
  })

  it("validates every path, glob, and command", () => {
    expect(
      validatePatch({ worktreeLinkPaths: { add: ["../x"] } }, "/w")
    ).toMatch(/leaves the workspace/)
    expect(
      validatePatch(
        {
          worktreeSetupSteps: {
            add: [{ id: "a", label: "a", command: "curl x | sh", cwd: "" }],
          },
        },
        "/w"
      )
    ).toBeTruthy()
    expect(
      validatePatch(
        { generatedFiles: { add: [{ paths: ["**"], command: "make" }] } },
        "/w"
      )
    ).toMatch(/whole workspace/)
    expect(
      validatePatch(
        {
          generatedFiles: {
            add: [{ paths: ["gen/**"], command: "cd api && uv lock" }],
          },
        },
        "/w"
      )
    ).toBeNull()
  })
})

vi.mock("../../agent/approval/shell-analyzer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../agent/approval/shell-analyzer")>()
  return {
    ...actual,
    analyzeShellCommand: (
      ...args: Parameters<typeof actual.analyzeShellCommand>
    ) => actual.analyzeShellCommand(args[0], "darwin", args[2]),
    shellActionForCommand: (
      ...args: Parameters<typeof actual.shellActionForCommand>
    ) =>
      actual.shellActionForCommand(args[0], { ...args[1], platform: "darwin" }),
  }
})
