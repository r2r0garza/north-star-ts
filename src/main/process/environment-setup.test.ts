import { describe, it, expect, afterEach, vi } from "vitest"
import { EventEmitter } from "events"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

// Ask AI's model call is captured, never made.
const { completions } = vi.hoisted(() => ({
  completions: [] as Array<{
    messages: Array<{ role: string; content: string }>
  }>,
}))
vi.mock("../agent/providers", () => ({
  resolveLlm: () => ({ client: {}, model: "m", apiMode: "completions" }),
  createCompletion: async (
    _client: unknown,
    _model: string,
    _max: number,
    body: { messages: Array<{ role: string; content: string }> }
  ) => {
    completions.push(body)
    return {
      choices: [
        {
          message: {
            content:
              '{"command": ".venv/bin/python -m pytest", "cwd": null, "rationale": "Use the project venv."}',
          },
        },
      ],
    }
  },
}))
vi.mock("../db/repositories/workspaces", () => ({
  getWorkspace: () => undefined,
  getWorkspaceByPath: () => undefined,
}))
vi.mock("../db/repositories/processes", () => ({
  getPhase: () => undefined,
  getProcessDefinition: () => undefined,
  listPhases: () => [],
  listProcessRuns: () => [],
}))

import { environmentFacts } from "../mission-control/workspace-analysis/analyze"
import { setFakeToolsForTests } from "../mission-control/workspace-analysis/exec"
import { CommandTrialService } from "./try-command"
import { EnvironmentSetupService } from "./environment-setup"
import { draftCommand, SYSTEM_PROMPT } from "./command-draft"

// A project's environment, as a command check sees it (plan 104): Ask AI and
// the check form learn whether the venv exists and which interpreter to call,
// and setup runs the analysis recipe's own steps.

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
  completions.length = 0
})

async function pythonProject(opts: { venv: boolean }) {
  dir = await mkdtemp(join(tmpdir(), "env-facts-"))
  await writeFile(
    join(dir, "pyproject.toml"),
    '[project]\nname = "demo"\nversion = "0.1.0"\n\n[project.optional-dependencies]\ndev = ["pytest"]\n'
  )
  if (opts.venv) {
    await writeFile(join(dir, ".gitignore"), ".venv\n")
    await mkdir(join(dir, ".venv/lib/python3.12/site-packages/pytest"), {
      recursive: true,
    })
    await writeFile(join(dir, ".venv/pyvenv.cfg"), "version = 3.12.4\n")
  }
  return dir
}

describe.skipIf(process.platform === "win32")("environmentFacts", () => {
  it("reports a missing venv with the recipe's setup steps", async () => {
    const root = await pythonProject({ venv: false })
    const [fact] = await environmentFacts(root)
    expect(fact).toMatchObject({
      root: "",
      ecosystem: "pip",
      noun: "Python environment",
      status: "missing",
      interpreter: null,
    })
    const commands = fact.setup.map((s) => s.command)
    expect(commands[0]).toMatch(/-m venv \.venv$/)
    expect(commands.at(-1)).toBe(".venv/bin/python -m pip install -e '.[dev]'")
  })

  it("names the venv's interpreter and installed test runner once it exists", async () => {
    const root = await pythonProject({ venv: true })
    const [fact] = await environmentFacts(root)
    expect(fact).toMatchObject({
      status: "ready",
      interpreter: ".venv/bin/python",
      tools: ["pytest"],
    })
  })
})

describe.skipIf(process.platform === "win32")(
  "Ask AI with environment facts",
  () => {
    it("tells the model that nothing is activated and which interpreter exists", async () => {
      const root = await pythonProject({ venv: true })
      const draft = await draftCommand({ check: "test", workspacePath: root })
      expect(draft.command).toBe(".venv/bin/python -m pytest")
      const [{ messages }] = completions
      expect(SYSTEM_PROMPT).toMatch(/no virtual environment is activated/)
      expect(messages[0].content).toBe(SYSTEM_PROMPT)
      expect(messages[1].content).toContain("Top-level entries:")
      expect(messages[1].content).toContain(".venv/")
      expect(messages[1].content).toContain(
        "Python environment (pip + venv): ready; interpreter .venv/bin/python; installed: pytest"
      )
    })

    it("passes the setup steps when the environment is missing", async () => {
      const root = await pythonProject({ venv: false })
      await draftCommand({ check: "test", workspacePath: root })
      expect(completions[0].messages[1].content).toMatch(
        /Python environment \(pip \+ venv\): missing; setup \(the user runs it separately\): .*-m venv \.venv/
      )
    })
  }
)

class FakeTerminals extends EventEmitter {
  started: Array<{ command: string; cwd: string }> = []
  killed: string[] = []
  runCommand(input: { command: string; cwd: string }) {
    this.started.push({ command: input.command, cwd: input.cwd })
    return { id: `s${this.started.length}` }
  }
  kill(id: string) {
    this.killed.push(id)
  }
  exit(id: string, exitCode: number) {
    this.emit("exit", { id, exitCode })
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function fact(setup: Array<{ label: string; command: string; cwd: string }>) {
  return {
    root: "",
    ecosystem: "pip" as const,
    manager: "pip",
    noun: "Python environment",
    status: "missing" as const,
    evidence: "No .venv/pyvenv.cfg",
    interpreter: null,
    runner: null,
    tools: [],
    setup,
  }
}

describe("EnvironmentSetupService", () => {
  const steps = [
    {
      label: "Create a virtual environment",
      command: "python3 -m venv .venv",
      cwd: "",
    },
    {
      label: "Install Python dependencies (pip)",
      command: ".venv/bin/python -m pip install -e '.[dev]'",
      cwd: "",
    },
  ]

  it("runs the recipe's steps one at a time in the terminal", async () => {
    const terminals = new FakeTerminals()
    const service = new EnvironmentSetupService(terminals, async () => [
      fact(steps),
    ])
    const run = await service.start("/work/app")
    expect(run.steps.map((s) => s.command)).toEqual(steps.map((s) => s.command))
    await tick()
    expect(terminals.started).toEqual([
      { command: "python3 -m venv .venv", cwd: "/work/app" },
    ])
    terminals.exit("s1", 0)
    await tick()
    expect(terminals.started).toHaveLength(2)
    terminals.exit("s2", 0)
    await tick()
    expect(service.status(run.id)).toMatchObject({
      status: "completed",
      steps: [{ status: "ok" }, { status: "ok" }],
    })
  })

  it("stops at the first failing step", async () => {
    const terminals = new FakeTerminals()
    const service = new EnvironmentSetupService(terminals, async () => [
      fact(steps),
    ])
    const run = await service.start("/work/app")
    await tick()
    terminals.exit("s1", 1)
    await tick()
    expect(terminals.started).toHaveLength(1)
    expect(service.status(run.id)).toMatchObject({
      status: "failed",
      steps: [{ status: "failed", exitCode: 1 }, { status: "skipped" }],
    })
  })

  it("refuses a step the setup policy rejects, before running anything", async () => {
    const terminals = new FakeTerminals()
    const service = new EnvironmentSetupService(terminals, async () => [
      fact([
        { label: "Chained", command: "pip install x && rm -rf build", cwd: "" },
      ]),
    ])
    await expect(service.start("/work/app")).rejects.toThrow(/can't run/)
    expect(terminals.started).toEqual([])
  })

  it("says so when there is nothing to set up", async () => {
    const service = new EnvironmentSetupService(
      new FakeTerminals(),
      async () => [{ ...fact(steps), status: "ready" as const }]
    )
    await expect(service.start("/work/app")).rejects.toThrow(/already set up/)
  })
})

describe.skipIf(process.platform === "win32")(
  "environmentFacts for Python managers",
  () => {
    afterEach(() => setFakeToolsForTests(null))

    async function project(files: Record<string, string>) {
      dir = await mkdtemp(join(tmpdir(), "env-managers-"))
      for (const [name, text] of Object.entries(files)) {
        await mkdir(join(dir, name, ".."), { recursive: true })
        await writeFile(join(dir, name), text)
      }
      return dir
    }

    const ok = (stdout: string) => ({
      ok: true,
      exitCode: 0,
      stdout,
      stderr: "",
      missing: false,
      timedOut: false,
    })
    const notInstalled = {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      missing: true,
      timedOut: false,
    }

    it("uses uv's own setup and runner", async () => {
      const root = await project({
        "pyproject.toml": '[project]\nname = "demo"\nversion = "0.1.0"\n',
        "uv.lock": "version = 1\n",
      })
      const [missing] = await environmentFacts(root)
      expect(missing).toMatchObject({
        ecosystem: "uv",
        status: "missing",
        runner: "uv run",
        setup: [{ command: "uv sync", cwd: "" }],
      })
      await mkdir(join(root, ".venv"), { recursive: true })
      await writeFile(join(root, ".venv/pyvenv.cfg"), "version = 3.12.4\n")
      const [ready] = await environmentFacts(root)
      expect(ready).toMatchObject({
        status: "ready",
        interpreter: ".venv/bin/python",
        runner: "uv run",
      })
    })

    it("finds Poetry's environment outside the project", async () => {
      const root = await project({
        "pyproject.toml": '[tool.poetry]\nname = "demo"\nversion = "0.1.0"\n',
        "poetry.lock": "# lock\n",
      })
      const external = await mkdtemp(join(tmpdir(), "poetry-venv-"))
      await mkdir(join(external, "lib/python3.12/site-packages/pytest"), {
        recursive: true,
      })
      setFakeToolsForTests({
        run: (file, args) =>
          file === "poetry" && args.join(" ") === "env info --path"
            ? ok(`${external}\n`)
            : null,
      })
      try {
        const [fact] = await environmentFacts(root)
        expect(fact).toMatchObject({
          ecosystem: "poetry",
          status: "ready",
          interpreter: null,
          runner: "poetry run",
          tools: ["pytest"],
        })
        expect(fact.evidence).toContain(external)
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    })

    it("reports Poetry missing, with its setup, when it isn't installed", async () => {
      const root = await project({
        "pyproject.toml": '[tool.poetry]\nname = "demo"\nversion = "0.1.0"\n',
        "poetry.lock": "# lock\n",
      })
      setFakeToolsForTests({
        run: (file) => (file === "poetry" ? notInstalled : null),
      })
      const [fact] = await environmentFacts(root)
      expect(fact).toMatchObject({
        status: "missing",
        evidence: "Poetry isn't installed",
      })
      expect(fact.setup.map((s) => s.command)).toContain("poetry install")
    })

    it("asks Pipenv where its environment is, and offers setup when there is none", async () => {
      const root = await project({
        Pipfile: "[packages]\n",
        "Pipfile.lock": "{}\n",
      })
      setFakeToolsForTests({
        run: (file) =>
          file === "pipenv"
            ? { ...ok(""), ok: false, exitCode: 1, stderr: "No virtualenv" }
            : null,
      })
      const [fact] = await environmentFacts(root)
      expect(fact).toMatchObject({
        ecosystem: "pipenv",
        status: "missing",
        runner: "pipenv run",
      })
      expect(fact.setup[0].command).toMatch(/^pipenv sync --dev/)
    })
  }
)

describe("CommandTrialService", () => {
  function deps(exit: number, onSpawn?: (signal: AbortSignal) => void) {
    return () => ({
      getExecutionConfig: () => ({
        kind: "local" as const,
        profile: "host-access" as const,
      }),
      createEnvironment: async () =>
        ({
          resolve: async (p: string) => (p ? `/ws/${p}` : "/ws"),
          stat: async () => ({
            size: 0,
            isFile: () => false,
            isDirectory: () => true,
          }),
          spawnCommand: async (_c: string, o: { signal?: AbortSignal }) => {
            let exitCb: (e: unknown) => void = () => {}
            let dataCb: (c: unknown) => void = () => {}
            onSpawn?.(o.signal!)
            if (!onSpawn)
              setTimeout(() => {
                dataCb({ stream: "stdout", data: Buffer.from("3 passed\n") })
                exitCb({ exitCode: exit, signal: null })
              }, 0)
            return {
              onData: (cb: (c: unknown) => void) => (dataCb = cb),
              onExit: (cb: (e: unknown) => void) => (exitCb = cb),
              write() {},
              closeStdin() {},
              interrupt: () => exitCb({ exitCode: null, signal: "SIGINT" }),
              kill() {},
            }
          },
          dispose: async () => {},
        }) as never,
      decide: () => ({ level: "allow" as const }),
      repositoryBlocker: async () => undefined,
    })
  }
  const settle = () => new Promise((r) => setTimeout(r, 10))

  it("runs the typed command once and reports a pass with its output", async () => {
    const service = new CommandTrialService(deps(0))
    const trial = service.start({
      workspacePath: tmpdir(),
      check: { command: ".venv/bin/python -m pytest", cwd: null },
    })
    expect(trial.status).toBe("running")
    await settle()
    expect(service.status(trial.id)).toMatchObject({
      status: "passed",
      receipt: {
        command: ".venv/bin/python -m pytest",
        exitCode: 0,
        stdout: "3 passed\n",
      },
    })
  })

  it("reports a failing command as failed", async () => {
    const service = new CommandTrialService(deps(1))
    const trial = service.start({
      workspacePath: tmpdir(),
      check: { command: "python -m pytest", cwd: null },
    })
    await settle()
    expect(service.status(trial.id)).toMatchObject({
      status: "failed",
      receipt: { exitCode: 1 },
    })
  })

  it("stops on request", async () => {
    const service = new CommandTrialService(deps(0, () => {}))
    const trial = service.start({
      workspacePath: tmpdir(),
      check: { command: "sleep 60", cwd: null },
    })
    await settle()
    service.cancel(trial.id)
    await settle()
    expect(service.status(trial.id)?.status).toBe("cancelled")
  })

  it("refuses an invalid check before running anything", () => {
    const service = new CommandTrialService(deps(0))
    expect(() =>
      service.start({
        workspacePath: tmpdir(),
        check: { command: "pytest", cwd: "../elsewhere" },
      })
    ).toThrow(/inside the workspace/)
  })
})
