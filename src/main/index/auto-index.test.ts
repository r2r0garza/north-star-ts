import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  autoIndex: true,
  run: undefined as { enabled: boolean } | undefined,
}))
vi.mock("../settings/service", () => ({
  getIndexing: () => ({ autoIndexNewWorkspaces: state.autoIndex }),
}))
vi.mock("../db/repositories/index-runs", () => ({
  getRunByWorkspace: () => state.run,
}))

import { autoIndexWorkspace } from "./auto-index"

describe("autoIndexWorkspace", () => {
  const service = { ensureRunning: vi.fn() }
  const watcher = { start: vi.fn(async () => {}) }
  beforeEach(() => {
    state.autoIndex = true
    state.run = undefined
    service.ensureRunning.mockReset()
    watcher.start.mockClear()
  })

  it("starts indexing and watching the workspace", () => {
    autoIndexWorkspace("ws", "high", service, watcher)
    expect(service.ensureRunning).toHaveBeenCalledWith("ws", "high")
    expect(watcher.start).toHaveBeenCalledWith("ws")
  })

  it("respects the global auto-index setting and a workspace opt-out", () => {
    state.autoIndex = false
    autoIndexWorkspace("ws", "high", service, watcher)
    state.autoIndex = true
    state.run = { enabled: false }
    autoIndexWorkspace("ws", "high", service, watcher)
    expect(service.ensureRunning).not.toHaveBeenCalled()
  })

  it("never throws when indexing can't start", () => {
    service.ensureRunning.mockImplementation(() => {
      throw new Error("boom")
    })
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => autoIndexWorkspace("ws", "low", service)).not.toThrow()
    error.mockRestore()
  })
})
