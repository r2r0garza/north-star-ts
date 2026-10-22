// @vitest-environment happy-dom
import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, afterEach, expect, it, vi } from "vitest"
import App, { type AppHandle, type WorkflowConversationContext } from "./App"
import { TooltipProvider } from "./components/ui/tooltip"
import { formatWorkflowResult } from "../../shared/workflow-result"
vi.mock("@/lib/notify", () => ({ maybeNotify: vi.fn() }))
vi.mock("@/components/transcript", () => ({
  LiveTranscriptTurn: () => null,
  SettledTranscript: () => null,
}))
let root: Root
let container: HTMLDivElement
let context: WorkflowConversationContext | null
const ref = createRef<AppHandle>()
const projectGet = vi.fn()
const chat = vi.fn()
const onContext = (next: WorkflowConversationContext) => {
  context = next
}
let id: string | null
function render(view: "North Star" | "Interactive" | "Chat" = "North Star") {
  return act(async () => {
    root.render(
      <TooltipProvider>
        <App
          ref={ref}
          view={view}
          conversationId={id}
          pendingProjectId={null}
          searchOpen={null}
          onSearchOpenComplete={() => {}}
          onConversationCreated={() => {}}
          onConversationChanged={() => {}}
          onOpenSettings={() => {}}
          settingsOpen={false}
          rightPanelOpen={true}
          onWorkflowContextChange={onContext}
          workflowDraftKey="draft"
        />
      </TooltipProvider>
    )
  })
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  )
  id = "conversation"
  context = null
  projectGet
    .mockReset()
    .mockResolvedValue({ id: "project", workspaceId: "project-workspace" })
  chat.mockReset()
  const noop = () => () => {}
  window.cowork = {
    platform: "darwin",
    system: () => ({ mainAgentName: "North Star", displayName: "North Star" }),
    providers: {
      effortLevels: async () => [],
      listWithModels: async () => [],
      getDefault: async () => ({}),
      onModelsChanged: noop,
    },
    settings: {
      getConversations: async () => ({ showRunInBackgroundButton: false }),
    },
    onCompletionReportStream: noop,
    onCompletionReport: noop,
    onBrowserElementPicked: noop,
    skills: { list: async () => [] },
    agents: { list: async () => [] },
    files: { list: async () => [] },
    db: {
      tasks: { list: async () => [] },
      projects: { get: projectGet },
      messages: { list: async () => [] },
      conversations: {
        get: async (key: string) => ({
          id: key,
          projectId: key === "conversation" ? "project" : null,
          workspaceId: "fallback-workspace",
          workingDirectory: "/worktree",
        }),
      },
      workspaces: {
        list: async () => [
          { id: "project-workspace", path: "/project" },
          { id: "fallback-workspace", path: "/fallback" },
        ],
      },
    },
    chat,
  } as unknown as typeof window.cowork
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
it("waits for project context, uses project workspace precedence, and rejects stale insertion destinations", async () => {
  let resolve!: (value: { id: string; workspaceId: string }) => void
  projectGet.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  await render()
  expect(context?.ready).toBe(false)
  projectGet.mockResolvedValue({
    id: "project",
    workspaceId: "project-workspace",
  })
  await act(async () => {
    resolve({ id: "project", workspaceId: "project-workspace" })
  })
  // Resolve both independent readers after the delayed project lookup.
  await render()
  expect(context?.workspace).toBe("/project")
  expect(context?.projectId).toBe("project")
  const previous = context!
  id = "another"
  await render()
  expect(context?.workspace).toBe("/worktree")
  await act(async () => {
    expect(
      ref.current?.appendWorkflowResult("Wrong destination", previous)
    ).toBe(false)
  })
  expect(container.querySelector("textarea")?.value).not.toContain(
    "Wrong destination"
  )
})
it("appends attributed final output into the real editable composer without submitting", async () => {
  await render()
  expect(context?.ready).toBe(true)
  const text = formatWorkflowResult({
    id: "run",
    workflow: { name: "Review" },
    status: "Completed",
    steps: [{ result: "Final output" }],
  } as import("../../shared/workflow-runs").WorkflowRun)
  await act(async () => {
    ref.current?.appendTerminalSelection("Existing draft")
    expect(ref.current?.appendWorkflowResult(text, context!)).toBe(true)
  })
  const textarea = container.querySelector("textarea")!
  expect(textarea.value).toContain("Existing draft")
  expect(textarea.value).toContain("DATA: Final output")
  expect(textarea.value).toContain('"runId":"run"')
  expect(textarea.disabled).toBe(false)
  expect(chat).not.toHaveBeenCalled()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )!.set!
    setter.call(textarea, `${textarea.value}Please summarize.`)
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
  expect(textarea.value).toContain("Please summarize.")
  expect(chat).not.toHaveBeenCalled()
})
it("follows a folder picked in an unlocked worktree conversation", async () => {
  id = "another"
  const update = vi.fn(async () => {})
  Object.assign(window.cowork, {
    pickWorkspace: async () => ({ path: "/picked" }),
  })
  Object.assign(window.cowork.db.conversations, { update })
  Object.assign(window.cowork.db.workspaces, {
    upsert: async () => ({ id: "picked", path: "/picked" }),
  })
  await render()
  expect(context?.workspace).toBe("/worktree")
  const picker = container
    .querySelector("svg.lucide-folder-open")
    ?.closest("button")
  await act(async () => picker!.click())
  expect(update).toHaveBeenCalledWith("another", { workspaceId: "picked" })
  expect(context?.ready).toBe(true)
  expect(context?.workspace).toBe("/picked")
})

for (const view of ["Chat", "Interactive", "North Star"] as const) {
  it(`stages picker and conversation drops with deduplication in ${view}`, async () => {
    Object.assign(window.cowork, {
      pickFiles: vi.fn(async () => ({ paths: ["/outside/screenshot.png"] })),
      getPathForFile: (file: File) => `/outside/${file.name}`,
    })
    await render(view)
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Attach files"]')!
        .click()
    )
    const zone = container.querySelector("[data-conversation-drop-zone]")!
    function drag(type: string, target: Element = zone, types = ["Files"]) {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, "dataTransfer", {
        value: {
          types,
          files: [
            new File(["image"], "screenshot.png"),
            new File(["text"], "notes.txt"),
          ],
          dropEffect: "none",
        },
      })
      target.dispatchEvent(event)
      return event
    }
    await act(async () => {
      drag("dragenter")
      drag("dragenter", container.querySelector("textarea")!)
    })
    expect(container.textContent).toContain("Drop files to attach")
    await act(async () => {
      drag("dragleave", container.querySelector("textarea")!)
    })
    expect(container.textContent).toContain("Drop files to attach")
    await act(async () => {
      expect(
        drag("drop", container.querySelector("textarea")!).defaultPrevented
      ).toBe(true)
    })
    expect(container.textContent).not.toContain("Drop files to attach")
    expect(
      container.querySelectorAll('[aria-label="Remove screenshot.png"]')
    ).toHaveLength(1)
    expect(
      container.querySelector('[aria-label="Remove notes.txt"]')
    ).not.toBeNull()
    await act(async () => {
      expect(drag("drop", zone, ["text/plain"]).defaultPrevented).toBe(false)
    })
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Remove notes.txt"]')!
        .click()
    )
    expect(
      container.querySelector('[aria-label="Remove notes.txt"]')
    ).toBeNull()
    expect(chat).not.toHaveBeenCalled()
    id = "another"
    await render(view)
    expect(
      container.querySelector('[aria-label="Remove screenshot.png"]')
    ).toBeNull()
  })
}

it("ignores picker results after changing conversations", async () => {
  let finish!: (value: { paths: string[] }) => void
  Object.assign(window.cowork, {
    pickFiles: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  })
  await render()
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Attach files"]')!
      .click()
  )
  id = "another"
  await render()
  await act(async () => finish({ paths: ["/outside/stale.png"] }))
  expect(container.querySelector('[aria-label="Remove stale.png"]')).toBeNull()
})

for (const view of ["Chat", "Interactive", "North Star"] as const) {
  it(`sends attachments with the foreground message in ${view}`, async () => {
    Object.assign(window.cowork.providers, {
      effortLevels: async () => [],
      listWithModels: async () => [
        {
          account: {
            id: "account",
            provider: "openai",
            enabled: true,
            name: "Test",
          },
          models: [{ modelId: "model", name: "Test model" }],
        },
      ],
      getDefault: async () => ({
        activeAccountId: "account",
        activeModelId: "model",
      }),
    })
    Object.assign(window.cowork.settings, {
      getConversations: async () => ({ showRunInBackgroundButton: true }),
    })
    Object.assign(window.cowork, {
      pickFiles: async () => ({ paths: ["/outside/screenshot.png"] }),
    })
    chat.mockResolvedValue({ error: "Test finished" })
    await render(view)
    await act(async () => {
      ref.current?.appendTerminalSelection("Please inspect this screenshot")
      container
        .querySelector<HTMLButtonElement>('[aria-label="Attach files"]')!
        .click()
    })
    if (view !== "Chat")
      expect(
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="Run in background"]'
        )!.disabled
      ).toBe(true)
    const send = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send"]'
    )!
    expect(send.disabled).toBe(false)
    await act(async () => send.click())
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Please inspect this screenshot"),
        attachments: ["/outside/screenshot.png"],
        workspace: view === "Chat" ? undefined : "/project",
      }),
      expect.any(Function)
    )
    expect(
      container.querySelector('[aria-label="Remove screenshot.png"]')
    ).toBeNull()
  })
}

it("prevents silently dropping files with a CLI provider", async () => {
  Object.assign(window.cowork.providers, {
    effortLevels: async () => [],
    listWithModels: async () => [
      {
        account: {
          id: "account",
          provider: "codex_cli",
          enabled: true,
          name: "Codex",
        },
        models: [{ modelId: "model", name: "Test model" }],
      },
    ],
    getDefault: async () => ({
      activeAccountId: "account",
      activeModelId: "model",
    }),
  })
  Object.assign(window.cowork, {
    pickFiles: async () => ({ paths: ["/outside/screenshot.png"] }),
  })
  await render()
  await act(async () => {
    ref.current?.appendTerminalSelection("Please inspect this screenshot")
    container
      .querySelector<HTMLButtonElement>('[aria-label="Attach files"]')!
      .click()
  })
  expect(
    container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
      .disabled
  ).toBe(true)
  expect(chat).not.toHaveBeenCalled()
})

for (const view of ["Chat", "Interactive", "North Star"] as const) {
  it(`queues steering and cancels it with Escape or X in ${view}`, async () => {
    Object.assign(window.cowork.providers, {
      effortLevels: async () => [],
      listWithModels: async () => [
        {
          account: {
            id: "account",
            provider: "openai",
            enabled: true,
            name: "Test",
          },
          models: [{ modelId: "model", name: "Test" }],
        },
      ],
      getDefault: async () => ({
        activeAccountId: "account",
        activeModelId: "model",
      }),
    })
    let state: import("../../shared/steering").SteeringState = {
      runId: null,
      messages: [],
    }
    let emit!: (event: import("../../preload").ChatEvent) => void
    const steer = vi.fn(async (conversationId, runId, input) => {
      state = {
        runId,
        messages: [
          ...state.messages,
          {
            ...input,
            conversationId,
            runId,
            createdAt: Date.now(),
            status: "queued",
          },
        ],
      }
      emit({ type: "steering_state", state })
      return state
    })
    const cancel = vi.fn(async (_conversationId, key) => {
      state = {
        ...state,
        messages: state.messages.filter((message) => message.id !== key),
      }
      emit({ type: "steering_state", state })
      return state
    })
    Object.assign(window.cowork, {
      chatSteeringState: async () => state,
      chatSteer: steer,
      chatCancelSteering: cancel,
    })
    chat.mockImplementation((_request, callback) => {
      emit = callback
      state = { runId: "active-run", messages: [] }
      emit({ type: "steering_state", state })
      return new Promise(() => {})
    })
    await render(view)
    await act(async () => ref.current?.appendTerminalSelection("Start work"))
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
        .click()
    )
    expect(container.querySelector('button[aria-label="Stop"]')).not.toBeNull()
    await act(async () =>
      ref.current?.appendTerminalSelection("Focus on tests")
    )
    expect(container.querySelector('button[aria-label="Stop"]')).toBeNull()
    const textarea = container.querySelector("textarea")!
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
        })
      )
    )
    expect(steer).not.toHaveBeenCalled()
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      )
    )
    expect(steer).toHaveBeenCalledTimes(1)
    expect(chat).toHaveBeenCalledTimes(1)
    expect(textarea.value).toBe("")
    expect(container.textContent).toContain("Queued")
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    )
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(
      container.querySelector('[aria-label="Cancel queued message"]')
    ).toBeNull()
    await act(async () =>
      ref.current?.appendTerminalSelection("Try another direction")
    )
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
        .click()
    )
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Cancel queued message"]'
        )!
        .click()
    )
    expect(cancel).toHaveBeenCalledTimes(2)
  })
}
