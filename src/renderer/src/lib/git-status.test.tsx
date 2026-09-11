// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useGitStatus } from "./git-status"

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

function StatusConsumer({ workspace }: { workspace: string }) {
  const { status } = useGitStatus(workspace)
  return <span>{status?.branch ?? "loading"}</span>
}

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
  vi.restoreAllMocks()
})

describe("shared Git status", () => {
  it("shares one request across consumers and refreshes them together", async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({ isRepo: true, branch: "main", entries: [] })
      .mockResolvedValueOnce({ isRepo: true, branch: "feature", entries: [] })
    Object.defineProperty(window, "cowork", {
      configurable: true,
      value: { git: { status } },
    })

    await act(async () => {
      root.render(
        <>
          <StatusConsumer workspace="/workspace" />
          <StatusConsumer workspace="/workspace" />
        </>
      )
    })

    expect(status).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe("mainmain")

    await act(async () => {
      window.dispatchEvent(new Event("git-state-changed"))
    })

    expect(status).toHaveBeenCalledTimes(2)
    expect(container.textContent).toBe("featurefeature")
  })

  it("queues one follow-up refresh instead of overlapping requests", async () => {
    const first = deferred<{
      isRepo: true
      branch: string
      entries: []
    }>()
    const status = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ isRepo: true, branch: "next", entries: [] })
    Object.defineProperty(window, "cowork", {
      configurable: true,
      value: { git: { status } },
    })

    act(() => root.render(<StatusConsumer workspace="/slow-workspace" />))
    expect(status).toHaveBeenCalledTimes(1)

    act(() => {
      window.dispatchEvent(new Event("focus"))
      window.dispatchEvent(new Event("git-state-changed"))
    })
    expect(status).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve({ isRepo: true, branch: "old", entries: [] })
      await first.promise
    })

    expect(status).toHaveBeenCalledTimes(2)
    expect(container.textContent).toBe("next")
  })
})
