// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { ProcessBuilder, RunMonitor } from "./process-screen"
import {
  CheckNameInput,
  CommandReceiptView,
  RunChecksPanel,
  WorkspaceCheckForm,
  WorkspaceChecksEditor,
  projectInterpreterFix,
  configFromDraft,
  discardedBySwitch,
} from "./process-command-phase"
import { TooltipProvider } from "@/components/ui/tooltip"
import type {
  EnvironmentFact,
  ProcessCommandReceipt,
  ProcessPhase,
  Workspace,
} from "@/types"

// Command phases in the builder and monitor (plan 104).

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { cowork?: unknown }).cowork
  vi.restoreAllMocks()
})

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

function buttonByText(text: string, scope: ParentNode = document) {
  return Array.from(scope.querySelectorAll("button")).find(
    (el) => el.textContent?.trim() === text || el.textContent?.includes(text)
  )
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el),
    "value"
  )!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function chooseKind(label: string) {
  const trigger = container.querySelector(
    '[aria-label="Phase execution type"]'
  ) as HTMLElement
  expect(trigger).toBeTruthy()
  click(trigger)
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (el) => el.textContent === label
  )
  expect(option).toBeTruthy()
  click(option!)
  await flush()
}

const definition = {
  id: "process",
  name: "Ship",
  description: null,
  requireFlagApproval: true,
  createdAt: 1,
  updatedAt: 1,
}

const agentPhase: ProcessPhase = {
  id: "phase",
  processId: "process",
  key: "test",
  name: "Test",
  routing: "single",
  gatePolicy: "auto",
  fanOut: false,
  maxReworkRounds: 0,
  dotFolder: false,
  validator: true,
  validatorMaxIterations: 3,
  validatorAgent: null,
  subprocessId: null,
  kind: "agent",
  commandConfig: null,
  position: 0,
}

const commandConfig = {
  source: "literal" as const,
  command: "pnpm test",
  cwd: null,
  timeoutMs: 600_000,
  maxOutputBytes: 262_144,
}

async function renderBuilder(input: {
  phase: ProcessPhase
  agents?: unknown[]
  update?: ReturnType<typeof vi.fn>
  draftCommand?: ReturnType<typeof vi.fn>
}) {
  const update = input.update ?? vi.fn().mockResolvedValue(input.phase)
  ;(window as unknown as { cowork: unknown }).cowork = {
    db: {
      processes: {
        get: vi.fn().mockResolvedValue({
          definition,
          phases: [input.phase],
          agents: input.agents ?? [],
          edges: [],
        }),
        phases: { update },
      },
    },
    process: { draftCommand: input.draftCommand ?? vi.fn() },
  }
  act(() => {
    root.render(
      <TooltipProvider>
        <ProcessBuilder
          definition={definition}
          agents={[]}
          definitions={[definition]}
          onDefinitionChanged={() => {}}
        />
      </TooltipProvider>
    )
  })
  await flush()
  click(buttonByText("Test", container)!)
  await flush()
  return { update }
}

describe("command phases in the builder", () => {
  it("drafts a command phase without saving until the command is saved, then confirms the discard", async () => {
    const { update } = await renderBuilder({
      phase: agentPhase,
      agents: [
        {
          id: "a1",
          phaseId: "phase",
          agentName: "tester",
          skills: null,
          tools: null,
          position: 0,
        },
      ],
    })
    expect(container.textContent).toContain("Agent pool")

    await chooseKind("Command")

    // The editor opens; nothing is stored yet, and agent-only controls hide.
    expect(update).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain("Agent pool")
    expect(container.textContent).not.toContain("Completion policy")
    expect(container.textContent).not.toContain("Validator")
    expect(container.textContent).not.toContain("Fan-out")
    expect(container.textContent).not.toContain("Routing")
    expect(container.textContent).toContain("Gate")

    // A new command phase names a workspace check, with no default.
    expect(
      container.querySelector('[role="radio"][aria-checked="true"]')
        ?.textContent
    ).toBe("Workspace check")
    expect(container.querySelector('[aria-label="Command"]')).toBeNull()
    const save = buttonByText("Save as command phase", container)!
    expect(save.disabled).toBe(true)
    type(
      container.querySelector('[aria-label="Check name"]') as HTMLInputElement,
      "test"
    )
    expect(save.disabled).toBe(false)
    click(save)
    await flush()

    // Switching discards the pool and validator: confirm first.
    expect(document.body.textContent).toContain("Make “Test” a command phase?")
    expect(document.body.textContent).toContain("its agent pool (1 entry)")
    expect(document.body.textContent).toContain("its validator")
    expect(update).not.toHaveBeenCalled()
    click(buttonByText("Switch")!)
    await flush()
    await flush()
    expect(update).toHaveBeenCalledWith("phase", {
      kind: "command",
      commandConfig: {
        source: "check",
        check: "test",
        timeoutMs: 600_000,
        maxOutputBytes: 262_144,
      },
    })
  })

  it("rejects an invalid check name, and saves a literal command when chosen", async () => {
    const { update } = await renderBuilder({
      phase: {
        ...agentPhase,
        validator: false,
        kind: "command",
        commandConfig: {
          source: "check",
          check: "test",
          timeoutMs: 600_000,
          maxOutputBytes: 262_144,
        },
      },
    })
    type(
      container.querySelector('[aria-label="Check name"]') as HTMLInputElement,
      "Run Tests!"
    )
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "lowercase letters"
    )
    click(
      Array.from(container.querySelectorAll('[role="radio"]')).find(
        (el) => el.textContent === "Literal command"
      )!
    )
    type(
      container.querySelector('[aria-label="Command"]') as HTMLTextAreaElement,
      "git diff --check"
    )
    click(buttonByText("Save command", container)!)
    await flush()
    expect(update).toHaveBeenCalledWith("phase", {
      commandConfig: {
        source: "literal",
        command: "git diff --check",
        cwd: null,
        timeoutMs: 600_000,
        maxOutputBytes: 262_144,
      },
    })
  })

  it("edits a saved command and validates it before saving", async () => {
    const { update } = await renderBuilder({
      phase: {
        ...agentPhase,
        validator: false,
        kind: "command",
        commandConfig,
      },
    })
    const textarea = container.querySelector(
      '[aria-label="Command"]'
    ) as HTMLTextAreaElement
    expect(textarea.value).toBe("pnpm test")
    expect(container.textContent).not.toContain("Agent pool")

    type(
      container.querySelector(
        '[aria-label="Working directory"]'
      ) as HTMLInputElement,
      "../outside"
    )
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "inside the workspace"
    )
    const save = buttonByText("Save command", container)!
    expect(save.disabled).toBe(true)

    type(
      container.querySelector(
        '[aria-label="Working directory"]'
      ) as HTMLInputElement,
      "packages/app"
    )
    type(textarea, "pnpm test --run")
    click(buttonByText("Save command", container)!)
    await flush()
    expect(update).toHaveBeenCalledWith("phase", {
      commandConfig: {
        ...commandConfig,
        command: "pnpm test --run",
        cwd: "packages/app",
      },
    })
  })

  it("keeps an Ask AI proposal inert until the user saves it", async () => {
    const draftCommand = vi.fn().mockResolvedValue({
      command: "pnpm vitest run",
      cwd: null,
      rationale: "The project tests with vitest.",
    })
    const { update } = await renderBuilder({
      phase: {
        ...agentPhase,
        validator: false,
        kind: "command",
        commandConfig,
      },
      draftCommand,
    })
    type(
      container.querySelector(
        '[aria-label="Ask AI instruction"]'
      ) as HTMLInputElement,
      "only unit tests"
    )
    click(buttonByText("Ask AI", container)!)
    await flush()
    await flush()
    expect(draftCommand).toHaveBeenCalledWith({
      phaseId: "phase",
      instruction: "only unit tests",
    })
    expect(container.textContent).toContain("Proposed command (not saved)")
    expect(container.textContent).toContain("pnpm vitest run")
    // Still the saved command in the editor, and nothing saved or switched.
    const textarea = container.querySelector(
      '[aria-label="Command"]'
    ) as HTMLTextAreaElement
    expect(textarea.value).toBe("pnpm test")
    click(buttonByText("Use in editor", container)!)
    expect(textarea.value).toBe("pnpm vitest run")
    expect(update).not.toHaveBeenCalled()
  })

  it("confirms before switching a command phase back to an agent", async () => {
    const { update } = await renderBuilder({
      phase: {
        ...agentPhase,
        validator: false,
        kind: "command",
        commandConfig,
      },
    })
    await chooseKind("Agent")
    expect(document.body.textContent).toContain("the saved command")
    click(buttonByText("Switch")!)
    await flush()
    await flush()
    expect(update).toHaveBeenCalledWith("phase", { kind: "agent" })
  })
})

describe("discardedBySwitch", () => {
  it("lists nothing for a bare agent phase becoming a command", () => {
    expect(
      discardedBySwitch({ ...agentPhase, validator: false }, 0, "command")
    ).toEqual([])
  })
})

describe("configFromDraft", () => {
  it("converts minutes and KiB and rejects nonsense", () => {
    expect(
      configFromDraft({
        source: "literal",
        check: "",
        command: " make check ",
        cwd: "./",
        timeoutMinutes: "2",
        outputKiB: "64",
      })
    ).toEqual({
      config: {
        source: "literal",
        command: "make check",
        cwd: null,
        timeoutMs: 120_000,
        maxOutputBytes: 65_536,
      },
    })
    expect(
      configFromDraft({
        source: "check",
        check: "test",
        command: "",
        cwd: "",
        timeoutMinutes: "0",
        outputKiB: "64",
      })
    ).toHaveProperty("error")
  })
})

function receipt(
  patch: Partial<ProcessCommandReceipt> = {}
): ProcessCommandReceipt {
  return {
    version: 1,
    command: "pnpm test",
    cwd: "app",
    environment: "local",
    status: "failed",
    exitCode: 1,
    signal: null,
    startedAt: 0,
    finishedAt: 65_000,
    stdout: "running 4 tests",
    stderr: "1 failed",
    outputTruncated: true,
    capturedOutputBytes: 100,
    observedOutputBytes: 5000,
    error: null,
    ...patch,
  }
}

describe("CommandReceiptView", () => {
  it("shows the command before it runs", () => {
    act(() => {
      root.render(
        <CommandReceiptView
          config={commandConfig}
          receipt={null}
          status="pending"
        />
      )
    })
    expect(container.textContent).toContain("$ pnpm test")
    expect(container.textContent).toContain("not started")
  })

  it("renders exit status, duration, truncation, and both streams", () => {
    act(() => {
      root.render(
        <CommandReceiptView
          config={commandConfig}
          receipt={receipt()}
          status="failed"
        />
      )
    })
    const text = container.textContent ?? ""
    expect(text).toContain("in app")
    expect(text).toContain("exited with code 1 after 1 min 5 s")
    expect(text).toContain("kept 100 of 5000 bytes")
    expect(text).toContain("stdout")
    expect(text).toContain("running 4 tests")
    expect(text).toContain("stderr")
    expect(text).toContain("1 failed")
    // A failed command shows its output open.
    expect(container.querySelector("details")?.open).toBe(true)
  })
})

describe("RunChecksPanel", () => {
  it("asks for a missing check, saves it to the workspace, and reports ready", async () => {
    let checks: Record<string, { command: string; cwd: string | null }> = {
      lint: { command: "pnpm lint", cwd: null },
    }
    const checkStatus = vi.fn(async () => ({
      required: ["lint", "test"],
      missing: ["lint", "test"].filter((n) => !checks[n]),
      checks,
    }))
    const setWorkspaceCheck = vi.fn(
      async (input: {
        name: string
        check: { command: string; cwd: string | null }
      }) => {
        checks = { ...checks, [input.name]: input.check }
        return {}
      }
    )
    ;(window as unknown as { cowork: unknown }).cowork = {
      process: { checkStatus, setWorkspaceCheck, draftCommand: vi.fn() },
    }
    const ready = vi.fn()
    act(() => {
      root.render(
        <RunChecksPanel
          processId="process"
          workspacePath="/work/engine"
          onReadyChange={ready}
        />
      )
    })
    await flush()
    await flush()
    expect(checkStatus).toHaveBeenCalledWith({
      processId: "process",
      workspacePath: "/work/engine",
    })
    expect(container.textContent).toContain("$ pnpm lint")
    expect(container.textContent).toContain(
      "not defined for this workspace yet"
    )
    expect(ready).toHaveBeenLastCalledWith(false)

    const form = container.querySelector('[data-testid="check-form-test"]')!
    type(
      form.querySelector('[aria-label="Command"]') as HTMLTextAreaElement,
      "cargo test"
    )
    click(buttonByText("Save check", form)!)
    await flush()
    await flush()
    expect(setWorkspaceCheck).toHaveBeenCalledWith({
      workspacePath: "/work/engine",
      name: "test",
      check: { command: "cargo test", cwd: null },
    })
    expect(container.textContent).toContain("$ cargo test")
    expect(ready).toHaveBeenLastCalledWith(true)
  })

  it("renders nothing and is ready when the process runs no checks", async () => {
    ;(window as unknown as { cowork: unknown }).cowork = {
      process: {
        checkStatus: vi.fn(async () => ({
          required: [],
          missing: [],
          checks: {},
        })),
      },
    }
    const ready = vi.fn()
    act(() => {
      root.render(
        <RunChecksPanel
          processId="p"
          workspacePath="/w"
          onReadyChange={ready}
        />
      )
    })
    await flush()
    await flush()
    expect(container.textContent).toBe("")
    expect(ready).toHaveBeenLastCalledWith(true)
  })
})

describe("WorkspaceChecksEditor", () => {
  const workspace = {
    id: "ws",
    path: "/work/web",
    name: "web",
    generatedFiles: [],
    worktreeSetup: { linkPaths: [], steps: [] },
    commandChecks: { test: { command: "pnpm test", cwd: null } },
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Workspace

  it("adds, and removes, a named check", async () => {
    const setWorkspaceCheck = vi.fn(async () => workspace)
    ;(window as unknown as { cowork: unknown }).cowork = {
      process: { setWorkspaceCheck, draftCommand: vi.fn() },
    }
    const onSaved = vi.fn()
    act(() => {
      root.render(
        <WorkspaceChecksEditor workspace={workspace} onSaved={onSaved} />
      )
    })
    expect(container.textContent).toContain("$ pnpm test")

    type(
      container.querySelector(
        '[aria-label="New check name"]'
      ) as HTMLInputElement,
      "test"
    )
    expect(container.textContent).toContain("already defined")
    type(
      container.querySelector(
        '[aria-label="New check name"]'
      ) as HTMLInputElement,
      "e2e"
    )
    click(buttonByText("Add check", container)!)
    const form = container.querySelector('[data-testid="check-form-e2e"]')!
    type(
      form.querySelector('[aria-label="Command"]') as HTMLTextAreaElement,
      "pnpm exec playwright test"
    )
    click(buttonByText("Save check", form)!)
    await flush()
    expect(setWorkspaceCheck).toHaveBeenCalledWith({
      workspacePath: "/work/web",
      name: "e2e",
      check: { command: "pnpm exec playwright test", cwd: null },
    })

    click(container.querySelector('[aria-label="Remove check test"]')!)
    await flush()
    expect(setWorkspaceCheck).toHaveBeenLastCalledWith({
      workspacePath: "/work/web",
      name: "test",
      check: null,
    })
    expect(onSaved).toHaveBeenCalledTimes(2)
  })
})

describe("CommandReceiptView for a check", () => {
  it("names the check before the run resolves it, then shows the frozen command", () => {
    const config = {
      source: "check" as const,
      check: "test",
      timeoutMs: 60_000,
      maxOutputBytes: 4096,
    }
    act(() => {
      root.render(
        <CommandReceiptView config={config} receipt={null} status="pending" />
      )
    })
    expect(container.textContent).toContain("Runs the workspace's “test” check")
    act(() => {
      root.render(
        <CommandReceiptView
          config={config}
          resolved={{
            ...config,
            check: "test",
            command: "cargo test",
            cwd: null,
          }}
          receipt={null}
          status="pending"
        />
      )
    })
    expect(container.textContent).toContain("$ cargo test")
    expect(container.textContent).toContain("check test")
  })
})

const venvFact = {
  root: "",
  ecosystem: "pip",
  manager: "pip + venv",
  noun: "Python environment",
  status: "ready",
  evidence: ".venv/pyvenv.cfg exists",
  interpreter: ".venv/bin/python",
  runner: null,
  tools: ["pytest"],
  setup: [],
} as unknown as EnvironmentFact

describe("projectInterpreterFix", () => {
  it("routes a bare python or pytest through the project's venv", () => {
    expect(
      projectInterpreterFix("python -m pytest -q", "", [venvFact])
    ).toEqual({
      command: ".venv/bin/python -m pytest -q",
      interpreter: ".venv/bin/python",
      bare: "python",
    })
    expect(projectInterpreterFix("pytest", "", [venvFact])?.command).toBe(
      ".venv/bin/python -m pytest"
    )
    expect(
      projectInterpreterFix("python3 -m pytest", "api", [
        { ...venvFact, root: "api", interpreter: "api/.venv/bin/python" },
      ])?.command
    ).toBe(".venv/bin/python -m pytest")
  })

  it("leaves other commands, and projects without a venv, alone", () => {
    expect(
      projectInterpreterFix(".venv/bin/python -m pytest", "", [venvFact])
    ).toBeNull()
    expect(projectInterpreterFix("pnpm test", "", [venvFact])).toBeNull()
    expect(projectInterpreterFix("pythonic", "", [venvFact])).toBeNull()
    expect(
      projectInterpreterFix("python -m pytest", "", [
        { ...venvFact, status: "missing", interpreter: null },
      ])
    ).toBeNull()
  })
})

describe("WorkspaceCheckForm environment help", () => {
  function mount(
    facts: EnvironmentFact[],
    extra: Record<string, unknown> = {}
  ) {
    ;(window as unknown as { cowork: unknown }).cowork = {
      process: {
        workspaceEnvironment: vi.fn(async () => facts),
        draftCommand: vi.fn(),
        ...extra,
      },
      terminal: { onData: vi.fn(() => () => {}) },
    }
    act(() => {
      root.render(
        <WorkspaceCheckForm
          name="test"
          workspacePath="/work/app"
          onSave={async () => {}}
        />
      )
    })
  }

  it("offers the project's Python when the command calls a bare python", async () => {
    mount([venvFact])
    await flush()
    await flush()
    expect(container.textContent).toContain("Python environment is ready")
    expect(container.textContent).toContain("pytest installed")
    const command = container.querySelector(
      '[aria-label="Command"]'
    ) as HTMLTextAreaElement
    type(command, "python -m pytest")
    expect(
      container.querySelector('[data-testid="interpreter-fix"]')
    ).toBeTruthy()
    click(buttonByText("Use the project's Python", container)!)
    expect(command.value).toBe(".venv/bin/python -m pytest")
    expect(
      container.querySelector('[data-testid="interpreter-fix"]')
    ).toBeNull()
  })

  it("explains a missing environment and sets it up on request", async () => {
    const startEnvironmentSetup = vi.fn(async () => ({
      id: "run-1",
      workspacePath: "/work/app",
      status: "running",
      steps: [
        {
          label: "Create a virtual environment",
          command: "python3 -m venv .venv",
          cwd: "",
          status: "running",
          exitCode: null,
          sessionId: null,
        },
      ],
    }))
    mount(
      [
        {
          ...venvFact,
          status: "missing",
          interpreter: null,
          tools: [],
          setup: [
            {
              label: "Create a virtual environment",
              command: "python3 -m venv .venv",
              cwd: "",
            },
          ],
        } as unknown as EnvironmentFact,
      ],
      { startEnvironmentSetup, environmentSetupStatus: vi.fn(async () => null) }
    )
    await flush()
    await flush()
    expect(container.textContent).toContain(
      "Python environment isn't set up yet"
    )
    expect(container.textContent).toContain("python3 -m venv .venv")
    click(buttonByText("Set up environment", container)!)
    await flush()
    // The renderer names only the workspace; main picks the commands.
    expect(startEnvironmentSetup).toHaveBeenCalledWith({
      workspacePath: "/work/app",
    })
    expect(container.textContent).toContain("Create a virtual environment")
  })
})

describe("Try it", () => {
  it("runs the typed (unsaved) command once and shows that it works", async () => {
    const running = {
      id: "t1",
      status: "running",
      receipt: null,
      error: null,
    }
    const tryCheck = vi.fn(async () => running)
    const checkTrialStatus = vi.fn(async () => ({
      ...running,
      status: "passed",
      receipt: {
        version: 1,
        check: null,
        command: ".venv/bin/python -m pytest",
        cwd: null,
        environment: "local",
        status: "completed",
        exitCode: 0,
        signal: null,
        startedAt: 0,
        finishedAt: 1200,
        stdout: "3 passed",
        stderr: "",
        outputTruncated: false,
        capturedOutputBytes: 8,
        observedOutputBytes: 8,
        error: null,
      },
    }))
    const onSave = vi.fn()
    ;(window as unknown as { cowork: unknown }).cowork = {
      process: {
        workspaceEnvironment: vi.fn(async () => []),
        draftCommand: vi.fn(),
        tryCheck,
        checkTrialStatus,
      },
    }
    vi.useFakeTimers()
    try {
      act(() => {
        root.render(
          <WorkspaceCheckForm
            name="test"
            workspacePath="/work/app"
            onSave={onSave}
          />
        )
      })
      type(
        container.querySelector(
          '[aria-label="Command"]'
        ) as HTMLTextAreaElement,
        ".venv/bin/python -m pytest"
      )
      click(buttonByText("Try it", container)!)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(tryCheck).toHaveBeenCalledWith({
        workspacePath: "/work/app",
        check: { command: ".venv/bin/python -m pytest", cwd: null },
      })
      expect(container.textContent).toContain("Running the command once")
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      expect(container.textContent).toContain(
        "It works: the command exited with code 0."
      )
      expect(container.textContent).toContain("3 passed")
      // Trying never saves.
      expect(onSave).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("projectInterpreterFix with a manager runner", () => {
  it("runs through Poetry when its environment lives outside the project", () => {
    const poetry = {
      ...venvFact,
      ecosystem: "poetry",
      interpreter: null,
      runner: "poetry run",
    } as unknown as EnvironmentFact
    expect(projectInterpreterFix("pytest -q", "", [poetry])).toEqual({
      command: "poetry run pytest -q",
      interpreter: "poetry run",
      bare: "pytest",
    })
  })
})

describe("dialog scrolling", () => {
  it("keeps the New Run header and footer pinned and scrolls the body", async () => {
    ;(window as unknown as { cowork: unknown }).cowork = {
      db: {
        processes: {
          runs: { list: vi.fn(async () => []) },
          get: vi.fn(async () => ({
            definition,
            phases: [agentPhase],
            agents: [],
            edges: [],
          })),
        },
      },
      tasks: { onEvent: vi.fn(() => () => {}) },
    }
    act(() => {
      root.render(
        <TooltipProvider>
          <RunMonitor
            definition={definition}
            activeRunId={null}
            providerModels={[]}
            onSelectRun={() => {}}
          />
        </TooltipProvider>
      )
    })
    await flush()
    const newRun = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("New Run")
    )
    expect(newRun).toBeTruthy()
    click(newRun!)
    await flush()
    const body = document.querySelector('[data-testid="new-run-body"]')!
    expect(body.className).toContain("overflow-y-auto")
    expect(body.className).toContain("min-h-0")
    const content = body.closest('[data-slot="dialog-content"]')!
    expect(content.className).toContain("overflow-hidden")
    // The footer (with Run) sits outside the scrolling body.
    const run = Array.from(content.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Run"
    )!
    expect(body.contains(run)).toBe(false)
  })
})

describe("CheckNameInput", () => {
  it("suggests common names in the app's own list, and accepts any name", async () => {
    const changes: string[] = []
    function Harness() {
      const [value, setValue] = useState("")
      return (
        <CheckNameInput
          value={value}
          onChange={(next) => {
            changes.push(next)
            setValue(next)
          }}
          label="Check name"
        />
      )
    }
    act(() => {
      root.render(<Harness />)
    })
    expect(container.querySelector("datalist")).toBeNull()
    const input = container.querySelector(
      '[aria-label="Check name"]'
    ) as HTMLInputElement
    act(() => {
      input.focus()
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      )
    })
    await flush()
    const options = Array.from(document.querySelectorAll('[role="option"]'))
    expect(options.map((o) => o.textContent)).toEqual([
      "test",
      "build",
      "lint",
      "typecheck",
      "e2e",
    ])
    click(options.find((o) => o.textContent === "lint")!)
    await flush()
    expect(input.value).toBe("lint")

    type(input, "smoke")
    await flush()
    expect(input.value).toBe("smoke")
    expect(changes.at(-1)).toBe("smoke")
  })

  it("opens its suggestions on a mouse click", async () => {
    act(() => {
      root.render(
        <CheckNameInput value="" onChange={() => {}} label="Check name" />
      )
    })
    const input = container.querySelector(
      '[aria-label="Check name"]'
    ) as HTMLInputElement
    act(() => {
      for (const type of [
        "pointerdown",
        "mousedown",
        "pointerup",
        "mouseup",
        "click",
      ])
        input.dispatchEvent(
          new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, {
            bubbles: true,
            button: 0,
            ...(type.startsWith("pointer") ? { pointerType: "mouse" } : {}),
          })
        )
    })
    await flush()
    expect(document.querySelectorAll('[role="option"]').length).toBe(5)
  })
})
