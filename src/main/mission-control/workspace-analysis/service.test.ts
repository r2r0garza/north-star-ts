import { execFileSync } from "child_process"
import { EventEmitter } from "events"
import {
  chmodSync,
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
import {
  WorkspaceAnalysisService,
  ownerIdFor,
  type TestBrowserDeps,
} from "./index"
import type { Complete } from "./interpret"
import { TEST_BROWSER_FINDING, type WorkspaceBrowser } from "./test-browser"
import type { TestBrowserState } from "../playwright-install"

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

function service(
  options: {
    testBrowser?: TestBrowserDeps
    qaSeat?: boolean
    // A draft: a live rig with a QA seat, no snapshot yet.
    liveRigQaSeat?: boolean
  } = {}
) {
  return new WorkspaceAnalysisService({
    terminals: terminal,
    getFeature: (id) => {
      const feature = features.getFeature(id) ?? undefined
      if (feature && options.liveRigQaSeat)
        return { ...feature, rigId: "rig1", rigSnapshot: null }
      return feature && options.qaSeat
        ? {
            ...feature,
            rigSnapshot: { seats: [{ role: "qa" }] } as never,
          }
        : feature
    },
    getRig: (id) =>
      id === "rig1" ? ({ seats: [{ role: "qa" }] } as never) : null,
    testBrowser: options.testBrowser,
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

  it("proposes an app launch recipe from a dev script and saves it at Start without asking", async () => {
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
    // Seats need it to start the app: Start saves it, with no review step.
    const started = await svc.preflight(feature.id)
    expect(started.review).not.toContain("app-launch:recipe")
    expect(started.applied).toContain(finding!.title)
    expect(getWorkspace(workspace.id)!.appLaunch.services).toEqual([
      expect.objectContaining({
        key: "web",
        command: "npm run dev -- --port {port} --strictPort",
        source: "analysis",
        findingKey: "app-launch:recipe",
      }),
    ])
    expect(
      svc.get(feature.id)?.findings.find((f) => f.key === "app-launch:recipe")
    ).toMatchObject({ status: "resolved", resolution: "Already configured" })
  })

  // The recipe model's answer for any stack, beside the interpret step's.
  function recipeModel(answer: Record<string, unknown>) {
    const asked: string[] = []
    model = async (system, user) => {
      if (system.includes("app launch recipe")) {
        asked.push(user)
        return JSON.stringify(answer)
      }
      return JSON.stringify({ ignored: [], generated: [], findings: [], explanations: {} })
    }
    return asked
  }

  it("has the model write the recipe for a stack the rules don't know, starts it, and applies it at Start", async () => {
    const root = repo({
      Gemfile: "source 'https://rubygems.org'\ngem 'rails'\n",
      // Stands in for Rails: serves HTTP on the port after -p.
      "bin/rails": `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e "require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.argv[1]),'127.0.0.1')" "$5"\n`,
      "config.ru": "run Rails.application\n",
    })
    chmodSync(path.join(root, "bin/rails"), 0o755)
    const { feature, workspace } = featureFor(root)
    const asked = recipeModel({
      basis: "code",
      services: [
        {
          key: "web",
          label: "Rails server",
          command: "bin/rails server -b 127.0.0.1 -p {port}",
          cwd: "",
          port: "auto",
          ready: { http: "/up" },
          readyTimeoutMs: 15_000,
        },
      ],
      reason: "A Rails app.",
      evidence: ["Gemfile", "bin/rails"],
    })
    const svc = service({ qaSeat: true })
    const started = await svc.preflight(feature.id)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain("bin/rails")
    expect(started.applied).toContain("How seats start the app")
    expect(getWorkspace(workspace.id)!.appLaunch.services).toEqual([
      expect.objectContaining({
        command: "bin/rails server -b 127.0.0.1 -p {port}",
        source: "analysis",
      }),
    ])
    expect(getWorkspace(workspace.id)!.appLaunch.services[0].provisional).toBeUndefined()
    expect(svc.get(feature.id)?.findings.find((f) => f.key === "app-launch:recipe")?.confidence).toBe("verified")
  })

  it("doesn't write the recipe while the environment isn't set up", async () => {
    const root = repo(python)
    const { feature, workspace } = featureFor(root)
    const asked = recipeModel({ basis: "code", services: [], reason: "", evidence: [] })
    const svc = service({ qaSeat: true })
    const started = await svc.preflight(feature.id)
    expect(started.blockers).toContain("main-env:.:pip")
    expect(asked).toEqual([])
    expect(getWorkspace(workspace.id)!.appLaunch.services).toEqual([])
  })

  it("plans a provisional recipe from the intent for a workspace with no app yet", async () => {
    const root = repo({ "README.md": "# Shop\n" })
    const { feature, workspace } = featureFor(root)
    const asked = recipeModel({
      basis: "intent",
      services: [
        {
          key: "web",
          label: "Phoenix server",
          command: "mix phx.server",
          cwd: "",
          port: "auto",
          ready: { http: "/" },
        },
      ],
      reason: "The intent asks for a web shop; Phoenix fits.",
      evidence: [],
    })
    const svc = service({ qaSeat: true })
    await svc.preflight(feature.id)
    expect(asked[0]).toContain("Build a shop")
    expect(getWorkspace(workspace.id)!.appLaunch.services).toEqual([
      expect.objectContaining({ command: "mix phx.server", provisional: true }),
    ])
  })

  it("keeps the rules' recipe when the model's fails its checks, saying what it may miss", async () => {
    const root = repo({
      "package.json": JSON.stringify({
        name: "shop",
        scripts: { dev: "vite" },
        devDependencies: { vite: "^5.0.0" },
      }),
      "package-lock.json": "{}",
    })
    const { feature } = featureFor(root)
    const asked = recipeModel({
      basis: "code",
      services: [
        { key: "api", label: "Python API", command: "cd api && uvicorn main:app", cwd: "", port: "auto", ready: { http: "/" } },
      ],
      reason: "",
      evidence: [],
    })
    const analysis = await service().analyze(feature.id)
    expect(asked).toHaveLength(3)
    expect(analysis.findings.find((f) => f.key === "app-launch:recipe")).toMatchObject({
      source: "recipe",
      confidence: "guess",
      explanation: expect.stringMatching(/found more to start \(Python API\).*may not start all of it/),
    })
  })

  it("leaves a recipe the user wrote alone, and doesn't ask the model for one", async () => {
    const root = repo(python)
    const { feature, workspace } = featureFor(root)
    const mine = {
      key: "web",
      label: "Mine",
      command: "flask run --port {port}",
      cwd: "",
      port: "auto" as const,
      ready: { http: "/" },
      source: "user" as const,
    }
    updateWorkspace(workspace.id, { appLaunch: { services: [mine] } })
    const asked = recipeModel({ basis: "code", services: [], reason: "", evidence: [] })
    const svc = service({ qaSeat: true })
    await svc.analyze(feature.id)
    await svc.preflight(feature.id)
    expect(asked).toEqual([])
    expect(getWorkspace(workspace.id)!.appLaunch.services).toEqual([mine])
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
    model = async (system, user) => {
      if (system.includes("app launch recipe"))
        return JSON.stringify({ basis: "none", services: [], reason: "", evidence: [] })
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

// QA's test browser (plan 109.06): a live finding about the machine.
class FakeTestBrowser extends EventEmitter implements TestBrowserDeps {
  current: TestBrowserState = {
    status: "missing",
    requested: false,
    consent: false,
    progress: null,
    sizeMb: 92,
    error: null,
  }
  own: WorkspaceBrowser | null = null
  installs = 0
  state() {
    return this.current
  }
  async refresh() {
    return this.current
  }
  async install() {
    this.installs++
    this.set({ status: "downloading" })
    return true
  }
  onChanged(listener: (state: TestBrowserState) => void) {
    this.on("changed", listener)
    return () => this.off("changed", listener)
  }
  async workspace() {
    return this.own
  }
  set(patch: Partial<TestBrowserState>) {
    this.current = { ...this.current, ...patch }
    this.emit("changed", this.current)
  }
}

describe.skipIf(!sqliteLoads)("WorkspaceAnalysisService test browser", () => {
  function readyRepo() {
    const root = repo(python, { ".env.local": "x" })
    mkdirSync(path.join(root, ".venv"))
    writeFileSync(path.join(root, ".venv", "pyvenv.cfg"), "home=/usr/bin\n")
    return root
  }

  it("blocks Start when a QA seat has no browser, until one is there", async () => {
    const browser = new FakeTestBrowser()
    const { feature } = featureFor(readyRepo())
    const svc = service({ testBrowser: browser, qaSeat: true })
    const first = await svc.preflight(feature.id)
    expect(first.ok).toBe(false)
    expect(first.blockers).toEqual([TEST_BROWSER_FINDING])
    const finding = svc
      .get(feature.id)!
      .findings.find((f) => f.key === TEST_BROWSER_FINDING)!
    expect(finding.fix).toMatchObject({
      kind: "download-test-browser",
      sizeMb: 92,
    })
    expect(finding.alternatives[0]).toMatchObject({ kind: "manual" })

    // Live: the browser's own state resolves it, without re-analysis.
    changes = []
    browser.set({ status: "installed" })
    expect(changes).toContain(feature.id)
    const resolved = svc
      .get(feature.id)!
      .findings.find((f) => f.key === TEST_BROWSER_FINDING)!
    expect(resolved.status).toBe("resolved")
    expect(resolved.resolution).toBe("Test browser installed")
    expect((await svc.preflight(feature.id)).ok).toBe(true)
  })

  it("downloads it when the fix is applied, from the finding or Apply all", async () => {
    const browser = new FakeTestBrowser()
    const { feature } = featureFor(readyRepo())
    const svc = service({ testBrowser: browser, qaSeat: true })
    await svc.analyze(feature.id, { model: false })
    const result = await svc.applyFix(feature.id, TEST_BROWSER_FINDING)
    expect(result.run).toBeNull()
    expect(browser.installs).toBe(1)
    browser.set({ status: "missing" })
    const item = svc
      .previewApplyAll(feature.id)
      .find((i) => i.findingKey === TEST_BROWSER_FINDING)!
    expect(item.kind).toBe("download")
    await svc.applyAll(feature.id, [item.id])
    expect(browser.installs).toBe(2)
  })

  it("uses Chrome when it's installed", async () => {
    const browser = new FakeTestBrowser()
    browser.current = { ...browser.current, status: "chrome" }
    const { feature } = featureFor(readyRepo())
    const svc = service({ testBrowser: browser, qaSeat: true })
    expect((await svc.preflight(feature.id)).ok).toBe(true)
    const finding = svc
      .get(feature.id)!
      .findings.find((f) => f.key === TEST_BROWSER_FINDING)!
    expect(finding.resolution).toBe("Uses your Google Chrome")
  })

  it("checks the project's own Playwright browser instead, and installs it with a command", async () => {
    const browser = new FakeTestBrowser()
    browser.own = { version: "1.63.0", installed: false, location: "/cache/x" }
    const { feature } = featureFor(readyRepo())
    const svc = service({ testBrowser: browser, qaSeat: true })
    const first = await svc.preflight(feature.id)
    expect(first.blockers).toEqual([TEST_BROWSER_FINDING])
    const finding = svc
      .get(feature.id)!
      .findings.find((f) => f.key === TEST_BROWSER_FINDING)!
    expect(finding.fix).toMatchObject({
      kind: "run-command",
      commands: [{ command: "npx playwright install chromium", cwd: "" }],
    })
    terminal.scripts.set("npx playwright install chromium", {
      exit: 0,
      effect: () => {
        browser.own = { ...browser.own!, installed: true }
      },
    })
    await svc.applyFix(feature.id, TEST_BROWSER_FINDING)
    const run = await settled(svc, feature.id)
    expect(run?.status).toBe("succeeded")
    const after = svc
      .get(feature.id)!
      .findings.find((f) => f.key === TEST_BROWSER_FINDING)!
    expect(after.status).toBe("resolved")
    expect(after.lastRun).toMatchObject({ ok: true })
  })

  it("uses the live rig for a draft that has no rig snapshot yet", async () => {
    const browser = new FakeTestBrowser()
    const { feature } = featureFor(readyRepo())
    const svc = service({ testBrowser: browser, liveRigQaSeat: true })
    const analysis = await svc.analyze(feature.id, { model: false })
    expect(
      analysis.findings.find((f) => f.key === TEST_BROWSER_FINDING)?.status
    ).toBe("open")
  })

  it("makes no finding for a rig without a QA seat", async () => {
    const browser = new FakeTestBrowser()
    const { feature } = featureFor(readyRepo())
    const svc = service({ testBrowser: browser, qaSeat: false })
    expect((await svc.preflight(feature.id)).ok).toBe(true)
    expect(
      svc.get(feature.id)!.findings.some((f) => f.key === TEST_BROWSER_FINDING)
    ).toBe(false)
  })
})
