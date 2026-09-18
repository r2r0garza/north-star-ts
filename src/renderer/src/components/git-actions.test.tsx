// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { GitActions } from "./git-actions"

let container: HTMLDivElement
let root: Root

function renderGitActions() {
  root.render(
    <TooltipProvider>
      <GitActions workspace="/workspace" rightOffset={0} />
    </TooltipProvider>
  )
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        ctrlKey: false,
      })
    )
    element.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        ctrlKey: false,
      })
    )
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  Object.defineProperty(window, "cowork", {
    configurable: true,
    value: {
      git: {
        status: vi.fn().mockResolvedValue({ isRepo: true, entries: [] }),
        delegationLease: vi.fn().mockResolvedValue(null),
      },
      subagents: {
        artifacts: vi.fn().mockResolvedValue([]),
        resolveArtifact: vi.fn(),
      },
    },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.replaceChildren(
    ...Array.from(document.body.children).filter((child) => child !== container)
  )
  vi.restoreAllMocks()
})

describe("GitActions title-bar controls", () => {
  it("renders the current branch immediately before Git actions", async () => {
    window.cowork.git.status = vi.fn().mockResolvedValue({
      isRepo: true,
      branch: "feature/title-bar-branch",
      entries: [],
      truncated: false,
    })

    await act(async () => {
      renderGitActions()
    })

    const branch = document.querySelector(
      'button[aria-label="Current Git branch: feature/title-bar-branch. Choose branch"]'
    )
    const actions = document.querySelector('button[aria-label*="Git actions"]')

    expect(branch).not.toBeNull()
    expect(actions).not.toBeNull()
    expect(branch?.nextElementSibling).toBe(actions)
  })

  it("hides the branch selector when the workspace is not a Git repository", async () => {
    window.cowork.git.status = vi.fn().mockResolvedValue({
      isRepo: false,
      entries: [],
      truncated: false,
    })

    await act(async () => {
      renderGitActions()
    })

    expect(
      document.querySelector('button[aria-label^="Current Git branch:"]')
    ).toBeNull()
    const actions = document.querySelector(
      'button[aria-label="Not a Git repository. Git actions"]'
    )
    expect(actions).not.toBeNull()
    expect(actions).toHaveProperty("disabled", true)

    click(actions!)

    expect(document.querySelector('[role="menuitem"]')).toBeNull()
  })
})

describe("GitActions commit dialog", () => {
  it("surfaces unresolved subagent artifacts outside the Git dropdown", async () => {
    window.cowork.subagents.artifacts = vi.fn().mockResolvedValue([
      {
        id: "artifact-1",
        repositoryId: "/repo/.git",
        sessionId: "session-1",
        assignmentId: "add-notes",
        backend: "local",
        branch: "subagent/session/add-notes",
        worktreePath: "/tmp/worktree",
        markerPath: "/tmp/worktree.owner.json",
        status: "quarantined_cleanup_required",
        detail: null,
        createdAt: 1,
        updatedAt: 1,
        resolvedAt: null,
      },
    ])

    await act(async () => {
      renderGitActions()
    })

    const cleanup = document.querySelector(
      'button[aria-label="Writer subagents blocked: 1 cleanup item"]'
    )
    expect(cleanup?.textContent).toContain("Subagent cleanup (1)")

    click(cleanup!)
    expect(document.body.textContent).toContain("Review writer artifacts")
    expect(document.body.textContent).toContain("add-notes")
  })

  it("clears the commit message when reopened", async () => {
    await act(async () => {
      renderGitActions()
    })

    click(document.querySelector('button[aria-label*="Git actions"]')!)
    click(
      Array.from(document.querySelectorAll('[role="menuitem"]')).find(
        (item) => item.textContent === "Commit…"
      )!
    )

    const message = document.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="Commit message"]'
    )!
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set?.call(message, "stale commit message")
      message.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(message.value).toBe("stale commit message")

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    })

    click(document.querySelector('button[aria-label*="Git actions"]')!)
    click(
      Array.from(document.querySelectorAll('[role="menuitem"]')).find(
        (item) => item.textContent === "Commit…"
      )!
    )

    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder="Commit message"]'
      )?.value
    ).toBe("")
  })

  it("shows filenames with abbreviated directories and full paths on hover", async () => {
    window.cowork.git.status = vi.fn().mockResolvedValue({
      isRepo: true,
      entries: [
        {
          path: "src/main/agent/tools/web/extract.ts",
          kind: "modified",
          index: " ",
          worktree: "M",
        },
      ],
    })
    await act(async () => {
      renderGitActions()
    })

    click(document.querySelector('button[aria-label*="Git actions"]')!)
    click(
      Array.from(document.querySelectorAll('[role="menuitem"]')).find(
        (item) => item.textContent === "Commit…"
      )!
    )

    await act(async () => {})

    const path = Array.from(
      document.querySelectorAll<HTMLElement>("[title]")
    ).find((element) => element.title === "src/main/agent/tools/web/extract.ts")
    expect(path?.textContent).toBe("extract.ts ...ent/tools/web")
    expect(path?.querySelector(".text-muted-foreground")?.textContent).toBe(
      " ...ent/tools/web"
    )
  })
})
