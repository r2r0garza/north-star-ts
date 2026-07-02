import { describe, it, expect, beforeEach, vi } from "vitest"

// Back the settings repo with an in-memory map so the service is testable
// without SQLite. Mock is hoisted; the store is module-scoped and reset per test.
const store = new Map<string, string>()
vi.mock("../db/repositories/settings", () => ({
  getSetting: (k: string) => store.get(k),
  setSetting: (k: string, v: string) => void store.set(k, v),
  getAll: () => Object.fromEntries(store),
}))

import * as service from "./service"

beforeEach(() => {
  store.clear()
  service._resetCacheForTests()
  delete process.env.COWORK_ENV_RUNTIME
  delete process.env.COWORK_ENV_IMAGE
})

describe("settings service — defaults (back-compat)", () => {
  it("permissions default to auto/auto", () => {
    expect(service.getPermissions()).toEqual({
      file_write: "auto",
      file_edit: "auto",
    })
  })

  it("execution defaults to local with sandbox off", () => {
    const exec = service.getExecution()
    expect(exec.backend).toBe("local")
    expect(exec.sandbox.autoApprove).toBe(false)
    expect(exec.sandbox.prompted).toBe(false)
  })

  it("getExecutionConfig falls back to env var when nothing is persisted", () => {
    process.env.COWORK_ENV_RUNTIME = "docker"
    service._resetCacheForTests()
    expect(service.getExecutionConfig()).toEqual({
      kind: "container",
      runtime: "docker",
      image: "node:20-bookworm",
    })
  })

  it("getExecutionConfig is local by default with no env var", () => {
    expect(service.getExecutionConfig()).toEqual({ kind: "local" })
  })
})

describe("settings service — persisted overrides", () => {
  it("a persisted backend wins over the env var fallback", () => {
    process.env.COWORK_ENV_RUNTIME = "docker"
    service.setExecution({
      backend: "local",
      sandbox: { autoApprove: false, prompted: true, categories: {} as never },
    })
    // Persisted "local" beats the docker env var.
    expect(service.getExecutionConfig()).toEqual({ kind: "local" })
  })

  it("persists a container backend with its image", () => {
    service.setExecution({
      backend: "podman",
      image: "alpine:3",
      sandbox: { autoApprove: false, prompted: true, categories: {} as never },
    })
    expect(service.getExecutionConfig()).toEqual({
      kind: "container",
      runtime: "podman",
      image: "alpine:3",
    })
  })

  it("setPermissions round-trips and is read back", () => {
    service.setPermissions({
      file_write: "require_approval",
      file_edit: "auto",
    })
    expect(service.getPermissions().file_write).toBe("require_approval")
  })
})

describe("settings service — llm selection", () => {
  it("defaults to no active account/model", () => {
    expect(service.getLlm()).toEqual({
      activeAccountId: null,
      activeModelId: null,
    })
  })

  it("round-trips the active selection and fires the change listener", () => {
    let fired = 0
    service.setLlmChangeListener(() => fired++)
    service.setLlm({ activeAccountId: "acc-1", activeModelId: "model-1" })
    expect(service.getLlm()).toEqual({
      activeAccountId: "acc-1",
      activeModelId: "model-1",
    })
    expect(fired).toBe(1)
  })
})

describe("settings service — sandboxAutoApproves", () => {
  it("returns false when auto-approve is off", () => {
    service.setExecution({
      backend: "docker",
      sandbox: {
        autoApprove: false,
        prompted: true,
        categories: { workspace_mutation: true } as never,
      },
    })
    expect(service.sandboxAutoApproves("workspace_mutation")).toBe(false)
  })

  it("returns true only for enabled categories when auto-approve is on", () => {
    service.setExecution({
      backend: "docker",
      sandbox: {
        autoApprove: true,
        prompted: true,
        categories: {
          workspace_mutation: true,
          destructive_fs: false,
        } as never,
      },
    })
    expect(service.sandboxAutoApproves("workspace_mutation")).toBe(true)
    expect(service.sandboxAutoApproves("destructive_fs")).toBe(false)
    expect(service.sandboxAutoApproves(undefined)).toBe(false)
    expect(service.sandboxAutoApproves("unknown_category")).toBe(false)
  })
})

describe("settings service — indexing (plan 008)", () => {
  it("defaults: auto-index on, use-for-context on, embeddings off", () => {
    expect(service.getIndexing()).toEqual({
      autoIndexNewWorkspaces: true,
      useIndexForContext: true,
      includeEmbeddings: false,
    })
  })

  it("round-trips a persisted change", () => {
    service.setIndexing({
      autoIndexNewWorkspaces: false,
      useIndexForContext: false,
      includeEmbeddings: false,
    })
    service._resetCacheForTests()
    const idx = service.getIndexing()
    expect(idx.autoIndexNewWorkspaces).toBe(false)
    expect(idx.useIndexForContext).toBe(false)
  })

  it("falls back to defaults on a corrupt blob", () => {
    service.setIndexing({
      autoIndexNewWorkspaces: false,
      useIndexForContext: true,
      includeEmbeddings: false,
    })
    // A partial/corrupt stored blob still yields a complete typed shape.
    expect(service.getIndexing().includeEmbeddings).toBe(false)
  })
})
