import { describe, expect, it } from "vitest"
import { discoverGenerated } from "./generated"
import type { ProjectRoot } from "./inventory"

const root: ProjectRoot = {
  dir: "",
  ecosystems: ["pip"],
  flags: {
    typescript: false,
    kotlin: false,
    android: false,
    flutter: false,
    workspaces: false,
    cSources: false,
    cppSources: false,
    javaSources: false,
    yarnBerry: false,
    yarnPnp: false,
  },
  members: [],
  files: ["pyproject.toml", ".pre-commit-config.yaml"],
}

const preCommit = `repos:
  - repo: https://github.com/psf/black
    rev: 24.1.0
    hooks:
      - id: black
  - repo: local
    hooks:
      - id: pytest
        name: run tests
        entry: pytest
        language: system
        pass_filenames: false
      - id: deterministic-repository-index
        name: refresh deterministic repository index
        entry: codex-agentic-os index pre-commit
        language: python
        pass_filenames: false
        always_run: true
`

function history(): string[][] {
  const commits: string[][] = []
  for (let i = 0; i < 20; i++) {
    const index = [
      ".code-index/manifest.json",
      ".code-index/symbols.jsonl",
      ".code-index/dependencies.jsonl",
    ]
    // Half the commits change code and refresh the index; plans change alone.
    commits.push(
      i % 2 === 0 ? [`src/app/m${i}.py`, ...index] : [`.plan/${i}.md`]
    )
  }
  return commits
}

const tracked = [
  ".pre-commit-config.yaml",
  "pyproject.toml",
  ".code-index/manifest.json",
  ".code-index/symbols.jsonl",
  ".code-index/dependencies.jsonl",
  ".code-index/schema.json",
  ...Array.from({ length: 20 }, (_, i) => `.plan/${i}.md`),
  "src/app/main.py",
]

const files: Record<string, string> = {
  ".pre-commit-config.yaml": preCommit,
  ".code-index/manifest.json":
    '{"aggregate_content_hash":"x","generator_version":"1.1.1"}',
}

describe("generated files from history and hooks", () => {
  it("finds a lock-step index and pairs it with the always-run pre-commit hook", async () => {
    const groups = await discoverGenerated({
      tracked,
      roots: [root],
      read: async (f) => files[f] ?? null,
      history: history(),
      contexts: new Map(),
    })
    const index = groups.find((g) => g.key === "generated:churn:.code-index")
    expect(index).toMatchObject({
      paths: [".code-index/**"],
      command: "codex-agentic-os index pre-commit",
      confidence: "likely",
    })
    // Hand-written plans that change on their own are never "generated".
    expect(groups.some((g) => g.paths.some((p) => p.startsWith(".plan")))).toBe(
      false
    )
  })

  it("works for any folder and any single generator, not just one repo's names", async () => {
    const out = ["data/api-schema/openapi.json", "data/api-schema/types.json"]
    const commits: string[][] = []
    for (let i = 0; i < 16; i++)
      commits.push(
        i % 3 === 0 ? [`lib/handler${i}.rb`, ...out] : [`docs/${i}.md`]
      )
    const groups = await discoverGenerated({
      tracked: ["Makefile", "Gemfile", ...out, "lib/handler.rb", "docs/0.md"],
      roots: [
        { ...root, ecosystems: ["bundler"], files: ["Makefile", "Gemfile"] },
      ],
      read: async (f) =>
        f === "Makefile"
          ? "gen:\n\tbin/export-schema\n\ntest:\n\tbundle exec rspec\n"
          : null,
      history: commits,
      contexts: new Map(),
    })
    expect(
      groups.find((g) => g.key === "generated:churn:data/api-schema")
    ).toMatchObject({
      paths: ["data/api-schema/**"],
      command: "make gen",
    })
  })
})
