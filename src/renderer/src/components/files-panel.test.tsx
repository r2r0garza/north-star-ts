// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FilesPanel } from "./files-panel"

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("FilesPanel live refresh", () => {
  it("reconciles a directory after adding it to the file watcher", async () => {
    const initialFolderListing = deferred<{
      entries: []
      error: null
      truncated: false
    }>()
    const watcherRegistration = deferred<void>()
    let folderReads = 0

    const listDirectory = vi.fn((_: string, path: string) => {
      if (!path) {
        return Promise.resolve({
          entries: [
            {
              name: "test-folder",
              path: "test-folder",
              kind: "directory" as const,
              ignored: true,
            },
          ],
          error: null,
          truncated: false,
        })
      }
      folderReads += 1
      if (folderReads === 1) return initialFolderListing.promise
      return Promise.resolve({
        entries: [
          {
            name: ".gitkeep",
            path: "test-folder/.gitkeep",
            kind: "file" as const,
            ignored: false,
          },
        ],
        error: null,
        truncated: false,
      })
    })
    const updateDirectories = vi.fn((directories: string[]) =>
      directories.includes("test-folder")
        ? watcherRegistration.promise
        : Promise.resolve()
    )

    Object.defineProperty(window, "cowork", {
      configurable: true,
      value: {
        files: {
          listDirectory,
          onDidChange: () => ({ updateDirectories, unsubscribe: vi.fn() }),
        },
        git: {
          status: () => Promise.resolve({ isRepo: true, entries: [] }),
        },
        openInEditor: vi.fn(),
      },
    })

    await act(async () => {
      root.render(
        <FilesPanel
          workspace="/workspace"
          selectedPath={null}
          onSelectedPathChange={vi.fn()}
          onAddSelection={vi.fn()}
        />
      )
    })

    const folder = container.querySelector<HTMLButtonElement>(
      'button[title="test-folder — Ignored by Git"]'
    )
    expect(folder).not.toBeNull()
    expect(folder?.classList.contains("opacity-45")).toBe(true)
    await act(async () => folder!.click())
    expect(folderReads).toBe(1)

    await act(async () => {
      initialFolderListing.resolve({
        entries: [],
        error: null,
        truncated: false,
      })
      await initialFolderListing.promise
    })
    expect(container.textContent).not.toContain(".gitkeep")

    await act(async () => {
      watcherRegistration.resolve()
      await watcherRegistration.promise
    })

    expect(folderReads).toBe(2)
    expect(container.textContent).toContain(".gitkeep")
  })

  it("keeps loaded tree rows mounted while watcher registration refreshes them", async () => {
    const rootRefresh = deferred<{
      entries: []
      error: null
      truncated: false
    }>()
    const watcherRegistration = deferred<void>()
    let rootReads = 0

    const listDirectory = vi.fn((_: string, path: string) => {
      if (!path) {
        rootReads += 1
        if (rootReads > 1) return rootRefresh.promise
        return Promise.resolve({
          entries: [
            {
              name: "folder",
              path: "folder",
              kind: "directory" as const,
              ignored: false,
            },
          ],
          error: null,
          truncated: false,
        })
      }
      return Promise.resolve({ entries: [], error: null, truncated: false })
    })

    Object.defineProperty(window, "cowork", {
      configurable: true,
      value: {
        files: {
          listDirectory,
          onDidChange: () => ({
            updateDirectories: (directories: string[]) =>
              directories.includes("folder")
                ? watcherRegistration.promise
                : Promise.resolve(),
            unsubscribe: vi.fn(),
          }),
        },
        git: {
          status: () => Promise.resolve({ isRepo: true, entries: [] }),
        },
        openInEditor: vi.fn(),
      },
    })

    await act(async () => {
      root.render(
        <FilesPanel
          workspace="/workspace"
          selectedPath={null}
          onSelectedPathChange={vi.fn()}
          onAddSelection={vi.fn()}
        />
      )
    })

    const tree = container.querySelector<HTMLElement>('[role="tree"]')!
    const folder = container.querySelector<HTMLButtonElement>(
      'button[title="folder"]'
    )!
    tree.scrollTop = 120

    await act(async () => folder.click())
    await act(async () => {
      watcherRegistration.resolve()
      await watcherRegistration.promise
    })

    expect(rootReads).toBeGreaterThanOrEqual(2)
    expect(container.querySelector('button[title="folder"]')).toBe(folder)
    expect(container.textContent).not.toContain("Loading files…")
    expect(tree.scrollTop).toBe(120)

    await act(async () => {
      rootRefresh.resolve({ entries: [], error: null, truncated: false })
      await rootRefresh.promise
    })
  })

  it("clears selected-file gutter annotations when Git status refreshes", async () => {
    let statusReads = 0
    const status = vi.fn(() => {
      statusReads += 1
      return Promise.resolve({
        isRepo: true,
        entries:
          statusReads === 1
            ? [
                {
                  kind: "ordinary" as const,
                  path: "file.ts",
                  index: ".",
                  worktree: "M",
                },
              ]
            : [],
      })
    })
    const diff = vi
      .fn()
      .mockResolvedValueOnce({
        diff: "@@ -0,0 +1 @@\n+changed\n",
        untracked: false,
        truncated: false,
      })
      .mockResolvedValue({ diff: "", untracked: false, truncated: false })

    Object.defineProperty(window, "cowork", {
      configurable: true,
      value: {
        files: {
          listDirectory: () =>
            Promise.resolve({
              entries: [
                {
                  name: "file.ts",
                  path: "file.ts",
                  kind: "file" as const,
                  ignored: false,
                },
              ],
              error: null,
              truncated: false,
            }),
          readText: () =>
            Promise.resolve({
              content: "changed",
              truncated: false,
              error: null,
              kind: "text" as const,
            }),
          onDidChange: () => ({
            updateDirectories: () => Promise.resolve(),
            unsubscribe: vi.fn(),
          }),
        },
        git: { status, diff },
        openInEditor: vi.fn(),
      },
    })

    await act(async () => {
      root.render(
        <FilesPanel
          workspace="/workspace"
          selectedPath="file.ts"
          onSelectedPathChange={vi.fn()}
          onAddSelection={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[aria-label="Added line"]')).not.toBeNull()

    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })

    expect(status).toHaveBeenCalledTimes(2)
    expect(diff).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[aria-label="Added line"]')).toBeNull()
  })
})
