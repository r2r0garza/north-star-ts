import { execFileSync } from "child_process"
import { EventEmitter } from "events"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runMigrations } from "../../db/migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"
import type { SetupRunView } from "../../../shared/mission-control/workspace-analysis"

const sqliteLoads = sqliteLoadsForTests()
let db: Database.Database
vi.mock("../../db/connection", () => ({ getDb: () => db }))

import * as features from "../../db/repositories/features"
import {
  getWorkspace,
  updateWorkspace,
  upsertWorkspace,
} from "../../db/repositories/workspaces"
import { setFakeToolsForTests } from "./exec"
import { WorkspaceAnalysisService, ownerIdFor } from "./index"
import type { Complete } from "./interpret"

const dirs: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

function repo(
  files: Record<string, string>,
  ignored: Record<string, string> = {}
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wa-service-")))
  dirs.push(root)
  const write = (all: Record<string, string>) => {
    for (const [rel, content] of Object.entries(all)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      writeFileSync(path.join(root, rel), content)
    }
  }
  write(files)
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.email", "t@example.com")
  git(root, "config", "user.name", "T")
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "base")
  write(ignored)
  return root
}

// The integrated terminal, faked: each command "runs" by calling a script
// that may touch the workspace, then exits with its code.
class FakeTerminal extends EventEmitter {
  commands: Array<{ ownerId: string; cwd: string; command: string }> = []
  scripts = new Map<
    string,
    { exit: number; effect?: (cwd: string) => void; output?: string }
  >()
  runCommand(input: {
    ownerId: string
    cwd: string
    command: string
    title: string
  }) {
    this.commands.push({
      ownerId: input.ownerId,
      cwd: input.cwd,
      command: input.command,
    })
    const id = `s${this.commands.length}`
    const script = this.scripts.get(input.command) ?? { exit: 0 }
    setTimeout(() => {
      script.effect?.(input.cwd)
      this.emit("data", {
        id,
        data: script.output ?? `ran ${input.command}\r\n`,
      })
      this.emit("exit", { id, exitCode: script.exit, signal: null })
    }, 5)
    return { id }
  }
  kill() {}
}

let terminal: FakeTerminal
let changes: string[]
let runs: SetupRunView[]
let model: Complete | null

function service() {
  return new WorkspaceAnalysisService({
    terminals: terminal,
    getFeature: (id) => features.getFeature(id) ?? undefined,
    getWorkspace,
    updateWorkspace: (id, patch) => updateWorkspace(id, patch),
    setOverlapPolicy: (featureId, value) =>
      features.setFeatureDrive(featureId, { overlapPolicy: value }),
    complete: () => model,
    onChanged: (id) => changes.push(id),
    onRunChanged: (run) => runs.push(run),
  })
}

function featureFor(root: string) {
  const workspace = upsertWorkspace(root)
  const graph = features.createFeature({
    key: "shop",
    name: "Shop",
    intent: "Build a shop",
    definitionOfDone: "",
    workspaceId: workspace.id,
  })
  return { feature: graph.feature, workspace }
}

async function settled(svc: WorkspaceAnalysisService, featureId: string) {
  for (let i = 0; i < 200; i++) {
    const run = svc.getRun(featureId)
    if (!run || run.status !== "running") {
      await new Promise((r) => setTimeout(r, 20))
      if (!svc.getRun(featureId) || svc.getRun(featureId)!.status !== "running")
        return svc.getRun(featureId)
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("run didn't settle")
}

const python = {
  ".gitignore": ".venv/\n.env.local\nnotes/\n",
  "requirements.txt": "flask\n",
  "app.py": "",
}

beforeEach(() => {
  db = new Database(":memory:")
  runMigrations(db)
  terminal = new FakeTerminal()
  changes = []
  runs = []
  model = null
  setFakeToolsForTests({
    run: (file) =>
      [
        "mise",
        "asdf",
        "pyenv",
        "fnm",
        "volta",
        "rbenv",
        "rustup",
        "fvm",
        "corepack",
      ].includes(file)
        ? {
            ok: false,
            exitCode: null,
            stdout: "",
            stderr: "",
            missing: true,
            timedOut: false,
          }
        : {
            ok: true,
            exitCode: 0,
            stdout: `${file} 3.12.4`,
            stderr: "",
            missing: false,
            timedOut: false,
          },
    shell: () => ({
      ok: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      missing: false,
      timedOut: false,
    }),
  })
})

afterEach(() => {
  setFakeToolsForTests(null)
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!sqliteLoads)("WorkspaceAnalysisService", () => {
  it("defaults new features to Autopilot with planning applied and overlap on wait", () => {
    const { feature } = featureFor(repo(python))
    expect(feature.driveMode).toBe("autopilot")
    expect(feature.drive).toMatchObject({
      autoApplyPlan: true,
      overlapPolicy: "wait",
    })
    expect(features.listMilestones(feature.id)[0].mergePolicy.mode).toBe(
      "manual"
    )
  })

  it("analyzes, stores, and forgets the result when the workspace changes", async () => {
    const root = repo(python, { ".env.local": "SECRET=1" })
    const { feature } = featureFor(root)
    const svc = service()
    expect(svc.get(feature.id)).toBeNull()
    const analysis = await svc.analyze(feature.id)
    expect(analysis.status).toBe("ready")
    expect(analysis.modelStatus).toBe("unavailable")
    const keys = analysis.findings.map((f) => f.key)
    expect(keys).toEqual(
      expect.arrayContaining([
        "main-env:.:pip",
        "local-config:.env.local",
        "git-isolation:parallel",
      ])
    )
    expect(svc.get(feature.id)?.fingerprint).toBe(analysis.fingerprint)
    const other = upsertWorkspace(repo(python))
    features.updateFeature(feature.id, { workspaceId: other.id })
    expect(svc.get(feature.id)).toBeNull()
  })

  it("shows a failure instead of nothing when the result can't be stored", async () => {
    const { feature } = featureFor(repo(python))
    const svc = service()
    db.exec(
      "DROP TABLE workspace_analyses; CREATE TABLE workspace_analyses (feature_id TEXT PRIMARY KEY);"
    )
    await expect(svc.analyze(feature.id)).rejects.toThrow(/no column/)
    expect(svc.get(feature.id)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/no column/),
    })
  })

  it("shares one in-flight analysis between concurrent calls", async () => {
    const { feature } = featureFor(repo(python))
    const svc = service()
    const [a, b] = [svc.analyze(feature.id), svc.analyze(feature.id)]
    expect(a).toBe(b)
    await a
  })

  it("applies a settings fix and resolves the finding against the saved settings", async () => {
    const root = repo(python, { ".env.local": "SECRET=1" })
    const { feature, workspace } = featureFor(root)
    const svc = service()
    await svc.analyze(feature.id)
    const result = await svc.applyFix(feature.id, "local-config:.env.local")
    expect(result.run).toBeNull()
    expect(getWorkspace(workspace.id)!.worktreeSetup.linkPaths).toEqual([
      ".env.local",
    ])
    expect(
      result.analysis?.findings.find((f) => f.key === "local-config:.env.local")
    ).toMatchObject({
      status: "resolved",
      resolution: "Already configured",
    })
    await expect(svc.applyFix(feature.id, "no-such-finding")).rejects.toThrow(
      /no longer current/
    )
  })

  it("proposes an app launch recipe from a dev script and saves it only on Apply", async () => {
    const root = repo({
      "package.json": JSON.stringify({
        name: "shop",
        scripts: { dev: "vite", build: "vite build" },
        devDependencies: { vite: "^5.0.0" },
      }),
      "package-lock.json": "{}",
    })
    const { feature, workspace } = featureFor(root)
    const svc = service()
    const analysis = await svc.analyze(feature.id)
    const finding = analysis.findings.find((f) => f.key === "app-launch:recipe")
    expect(finding).toMatchObject({
      status: "open",
      category: "app-launch",
      fix: {
        kind: "apply-settings",
        patch: {
          appLaunch: {
            add: [
              {
                key: "web",
                command: "npm run dev -- --port {port} --strictPort",
                port: "auto",
                ready: { http: "/" },
              },
            ],
          },
        },
      },
    })
    // It persists a command: never applied by Start on its own.
    await svc.preflight(feature.id)
    expect(getWorkspace(workspace.id)!.appLaunch.services).toEqual([])
    const result = await svc.applyFix(feature.id, "app-launch:recipe")
    expect(getWorkspace(workspace.id)!.appLaunch.services).toEqual([
      expect.objectContaining({
        key: "web",
        command: "npm run dev -- --port {port} --strictPort",
        source: "analysis",
        findingKey: "app-launch:recipe",
      }),
    ])
    expect(
      result.analysis?.findings.find((f) => f.key === "app-launch:recipe")
    ).toMatchObject({ status: "resolved", resolution: "Already configured" })
  })

  it("dismisses and restores a finding", async () => {
    const { feature } = featureFor(repo(python, { ".env.local": "x" }))
    const svc = service()
    await svc.analyze(feature.id)
    expect(
      svc
        .dismiss(feature.id, "local-config:.env.local")
        ?.findings.find((f) => f.key === "local-config:.env.local")?.status
    ).toBe("dismissed")
    await svc.analyze(feature.id, { model: false })
    expect(
      svc
        .get(feature.id)
        ?.findings.find((f) => f.key === "local-config:.env.local")?.status
    ).toBe("dismissed")
    expect(
      svc
        .dismiss(feature.id, "local-config:.env.local", false)
        ?.findings.find((f) => f.key === "local-config:.env.local")?.status
    ).toBe("open")
  })

  it("runs a fix in the integrated terminal and marks it fixed only when re-analysis agrees", async () => {
    const root = repo(python)
    const { feature } = featureFor(root)
    const svc = service()
    await svc.analyze(feature.id)
    terminal.scripts.set(
      ".venv/bin/python -m pip install -r requirements.txt",
      {
        exit: 0,
        effect: (cwd) => {
          mkdirSync(path.join(cwd, ".venv"), { recursive: true })
          writeFileSync(
            path.join(cwd, ".venv", "pyvenv.cfg"),
            "home=/usr/bin\n"
          )
        },
      }
    )
    const { run } = await svc.applyFix(feature.id, "main-env:.:pip")
    expect(run?.steps.map((s) => s.command)).toEqual([
      "python3 -m venv .venv",
      ".venv/bin/python -m pip install --upgrade pip",
      ".venv/bin/python -m pip install -r requirements.txt",
    ])
    const done = await settled(svc, feature.id)
    expect(done?.status).toBe("succeeded")
    expect(
      terminal.commands.every(
        (c) => c.ownerId === ownerIdFor(feature.id) && c.cwd === root
      )
    ).toBe(true)
    const after = svc.get(feature.id)!
    expect(after.findings.find((f) => f.key === "main-env:.:pip")?.status).toBe(
      "resolved"
    )
    expect(existsSync(path.join(root, ".venv", "pyvenv.cfg"))).toBe(true)
  })

  it("stops Apply all at the first failed command and says what still fails", async () => {
    const root = repo({
      ".gitignore": "node_modules/\n.venv/\n",
      "api/requirements.txt": "flask\n",
      "web/package.json": '{"name":"web","dependencies":{"vite":"5"}}',
      "web/package-lock.json": "{}",
    })
    const { feature, workspace } = featureFor(root)
    const svc = service()
    await svc.analyze(feature.id)
    const items = svc.previewApplyAll(feature.id)
    expect(items.map((i) => [i.findingKey, i.kind])).toEqual(
      expect.arrayContaining([
        ["main-env:api:pip", "command"],
        ["main-env:web:npm", "command"],
        ["worktree-env:setup:api:pip", "settings"],
      ])
    )
    terminal.scripts.set("python3 -m venv .venv", {
      exit: 1,
      output: "Error: no ensurepip\r\n",
    })
    const { run } = await svc.applyAll(
      feature.id,
      items.map((i) => i.id)
    )
    expect(run).not.toBeNull()
    const done = await settled(svc, feature.id)
    expect(done?.status).toBe("failed")
    expect(done?.steps.map((s) => s.status)).toEqual([
      "failed",
      "skipped",
      "skipped",
      "skipped",
    ])
    // Settings applied before the commands ran.
    expect(
      getWorkspace(workspace.id)!.worktreeSetup.steps.map(
        (s) => `${s.cwd}|${s.command}`
      )
    ).toEqual(
      expect.arrayContaining(["api|python3 -m venv .venv", "web|npm ci"])
    )
    const finding = svc
      .get(feature.id)!
      .findings.find((f) => f.key === "main-env:api:pip")!
    expect(finding.status).toBe("open")
    expect(finding.lastRun).toMatchObject({ ok: false, exitCode: 1 })
  })

  it("preflights Start: applies safe settings, reports blockers, and passes once they're fixed", async () => {
    const root = repo(python, { ".env.local": "x" })
    const { feature, workspace } = featureFor(root)
    const svc = service()
    const first = await svc.preflight(feature.id)
    expect(first.ok).toBe(false)
    expect(first.blockers).toEqual(["main-env:.:pip"])
    expect(first.applied).toEqual(["New worktrees won't have .env.local"])
    expect(getWorkspace(workspace.id)!.worktreeSetup.linkPaths).toEqual([
      ".env.local",
    ])
    // Parallel waits while the worktree setup finding is open.
    expect(features.getFeature(feature.id)!.drive.overlapPolicy).toBe("wait")
    mkdirSync(path.join(root, ".venv"))
    writeFileSync(path.join(root, ".venv", "pyvenv.cfg"), "home=/usr/bin\n")
    const second = await svc.preflight(feature.id)
    expect(second.ok).toBe(true)
    // Nothing here saves a command, so there's nothing to ask about.
    expect(second.review).toEqual([])
  })

  it("asks before saving setup that runs commands, instead of starting without it", async () => {
    const root = repo({
      ...python,
      ".gitattributes": "gen/** linguist-generated\n",
      "gen/schema.json": "{}",
      Makefile: "gen:\n\tpython tools/export.py\n",
    })
    mkdirSync(path.join(root, ".venv"))
    writeFileSync(path.join(root, ".venv", "pyvenv.cfg"), "home=/usr/bin\n")
    const { feature } = featureFor(root)
    const svc = service()
    const result = await svc.preflight(feature.id)
    expect(result.ok).toBe(true)
    expect(result.review).toEqual(["generated:attributes:gen/**"])
    // Applying it clears the review.
    await svc.applyFix(feature.id, "generated:attributes:gen/**")
    expect((await svc.preflight(feature.id)).review).toEqual([])
  })

  it("adds cited model findings, and keeps the built-in checklist when the model fails", async () => {
    const root = repo(python, { "notes/todo.md": "x" })
    const { feature } = featureFor(root)
    // Git collapses the ignored notes/ folder; analysis looks inside it.
    model = async (_system, user) => {
      const [, p, id] = /- (notes\/\S+) \[(E\d+)\]/.exec(user) ?? []
      return JSON.stringify({
        ignored: [
          {
            path: p,
            action: "link",
            reason: "Local notes the agents read.",
            evidence: [id],
          },
        ],
        generated: [],
        findings: [],
        explanations: {},
      })
    }
    const svc = service()
    const analysis = await svc.analyze(feature.id)
    expect(analysis.modelStatus).toBe("used")
    expect(
      analysis.findings.find(
        (f) => f.key === "worktree-env:model:notes/todo.md"
      )
    ).toMatchObject({ source: "model", confidence: "guess" })

    model = async () => {
      throw new Error("rate limited")
    }
    const failed = await svc.analyze(feature.id)
    expect(failed.modelStatus).toBe("failed")
    expect(failed.modelNote).toMatch(/rate limited/)
    expect(failed.findings.some((f) => f.key === "main-env:.:pip")).toBe(true)
  })

  it("carries model findings over when re-checking after a fix without calling the model", async () => {
    const root = repo(python, { "notes/todo.md": "x" })
    const { feature } = featureFor(root)
    let calls = 0
    model = async (_s, user) => {
      calls++
      const [, p, id] = /- (notes\/\S+) \[(E\d+)\]/.exec(user) ?? []
      return JSON.stringify({
        ignored: [{ path: p, action: "link", reason: "x", evidence: [id] }],
      })
    }
    const svc = service()
    await svc.analyze(feature.id)
    const again = await svc.analyze(feature.id, { model: false })
    expect(calls).toBe(1)
    expect(
      again.findings.some((f) => f.key === "worktree-env:model:notes/todo.md")
    ).toBe(true)
  })
})
