import { beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import { getWorkspace, updateWorkspace, upsertWorkspace } from "./workspaces"

describe.skipIf(!sqliteLoads)("workspace generated files", () => {
  beforeEach(() => {
    db = new Database(":memory:")
    runMigrations(db)
  })

  it("defaults to none and keeps only well-formed rules", () => {
    const ws = upsertWorkspace("/repo")
    expect(ws.generatedFiles).toEqual([])
    updateWorkspace(ws.id, {
      generatedFiles: [
        {
          paths: ["./.code-index/**", " "],
          command: "  codex-agentic-os index pre-commit ",
        },
        { paths: [], command: "npm install" },
        { paths: ["**/package-lock.json"], command: "" },
      ],
    })
    expect(getWorkspace(ws.id)!.generatedFiles).toEqual([
      {
        paths: [".code-index/**"],
        command: "codex-agentic-os index pre-commit",
      },
    ])
  })
})

describe.skipIf(!sqliteLoads)("workspace worktree setup", () => {
  beforeEach(() => {
    db = new Database(":memory:")
    runMigrations(db)
  })

  it("reads a legacy single command as one user step", () => {
    const ws = upsertWorkspace("/repo")
    db.prepare("UPDATE workspaces SET worktree_setup = ? WHERE id = ?").run(
      JSON.stringify({ linkPaths: [".venv/"], command: " uv sync " }),
      ws.id
    )
    expect(getWorkspace(ws.id)!.worktreeSetup).toEqual({
      linkPaths: [".venv"],
      steps: [
        {
          id: "legacy-command",
          label: "Setup command",
          command: "uv sync",
          cwd: "",
          source: "user",
        },
      ],
    })
  })

  it("keeps ordered, well-formed steps confined to the workspace", () => {
    const ws = upsertWorkspace("/repo")
    updateWorkspace(ws.id, {
      worktreeSetup: {
        linkPaths: ["../outside", "node_modules"],
        steps: [
          {
            id: "api",
            label: "Install API",
            command: "uv sync",
            cwd: "./api/",
            source: "analysis",
            findingKey: "main-env:api:uv",
          },
          {
            id: "bad",
            label: "x",
            command: "rm -rf /",
            cwd: "../..",
            source: "user",
          },
          { id: "empty", label: "x", command: " ", cwd: "", source: "user" },
          {
            id: "api",
            label: "",
            command: "pnpm install",
            cwd: "",
            source: "user",
          },
        ],
      },
    })
    expect(getWorkspace(ws.id)!.worktreeSetup).toEqual({
      linkPaths: ["node_modules"],
      steps: [
        {
          id: "api",
          label: "Install API",
          command: "uv sync",
          cwd: "api",
          source: "analysis",
          findingKey: "main-env:api:uv",
        },
        {
          id: "api-2",
          label: "pnpm install",
          command: "pnpm install",
          cwd: "",
          source: "user",
        },
      ],
    })
  })
})

describe.skipIf(!sqliteLoads)(
  "workspace app launch recipe (plan 112.1)",
  () => {
    beforeEach(() => {
      db = new Database(":memory:")
      runMigrations(db)
    })

    it("defaults to no services and round-trips a valid recipe", () => {
      const ws = upsertWorkspace("/repo")
      expect(ws.appLaunch).toEqual({ services: [] })
      updateWorkspace(ws.id, {
        appLaunch: {
          services: [
            {
              key: "api",
              label: "API",
              command: "node api.js",
              cwd: "./api/",
              port: "auto",
              ready: { http: "/health" },
              source: "user",
            },
            {
              key: "web",
              label: "Web",
              command: "node web.js",
              cwd: "",
              port: "auto",
              env: { API_URL: "http://localhost:{port:api}" },
              ready: { http: "/" },
              source: "user",
            },
          ],
        },
      })
      const saved = getWorkspace(ws.id)!.appLaunch
      expect(saved.services.map((s) => [s.key, s.cwd])).toEqual([
        ["api", "api"],
        ["web", ""],
      ])
      expect(saved.services[1].env).toEqual({
        API_URL: "http://localhost:{port:api}",
      })
    })

    it("refuses an invalid recipe with the validator's messages", () => {
      const ws = upsertWorkspace("/repo")
      expect(() =>
        updateWorkspace(ws.id, {
          appLaunch: {
            services: [
              {
                key: "web",
                label: "Web",
                command: "node web.js",
                cwd: "",
                port: "auto",
                env: { API_URL: "http://localhost:{port:api}" },
                ready: { http: "/" },
                source: "user",
              },
            ],
          },
        })
      ).toThrow(/isn't valid: .*no service "api"/)
      expect(getWorkspace(ws.id)!.appLaunch).toEqual({ services: [] })
    })

    it("reads a malformed stored value leniently", () => {
      const ws = upsertWorkspace("/repo")
      db.prepare("UPDATE workspaces SET app_launch = ? WHERE id = ?").run(
        "{not json",
        ws.id
      )
      expect(getWorkspace(ws.id)!.appLaunch).toEqual({ services: [] })
    })
  }
)
