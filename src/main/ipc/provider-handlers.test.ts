import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  preflight: vi.fn(),
  catalog: vi.fn(),
  setKey: vi.fn(),
}))
let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))
vi.mock("electron", () => ({
  app: { getPath: () => "/app-data" },
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => any) =>
      mocks.handlers.set(name, fn),
  },
  shell: {},
}))
vi.mock("../agent/providers/claude-subscription/preflight", () => ({
  preflightClaudeSubscription: mocks.preflight,
}))
vi.mock("../agent/providers/claude-subscription/model-catalog", () => ({
  loadClaudeSubscriptionCatalog: mocks.catalog,
}))
vi.mock("../settings/secrets", () => ({
  getMaskedApiKey: () => undefined,
  setApiKey: mocks.setKey,
}))
vi.mock("../agent/providers", () => ({
  invalidate: vi.fn(),
  hasActiveProvider: vi.fn(),
  fetchGatewayModelIds: vi.fn(),
}))
vi.mock("../settings/service", () => ({
  getLlm: () => ({ activeAccountId: null, activeModelId: null }),
  getMemory: () => ({}),
  getTitleGeneration: () => ({}),
}))
import { registerProviderHandlers } from "./provider-handlers"
import * as accounts from "../db/repositories/provider-accounts"
import * as models from "../db/repositories/models"

const sqliteLoads = sqliteLoadsForTests()
const ready = {
  ok: true,
  installed: true,
  version: "2.1.295",
  compatible: true,
  loggedIn: true,
  hint: "Ready",
}
const invoke = (name: string, ...args: unknown[]) =>
  mocks.handlers.get(name)!({}, ...args)
beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
  vi.clearAllMocks()
  mocks.preflight.mockResolvedValue(ready)
  mocks.catalog.mockResolvedValue({
    source: "discovered",
    models: [{ id: "sonnet" }],
    hint: "Discovered",
  })
  mocks.handlers.clear()
  registerProviderHandlers()
})
afterEach(() => {
  if (sqliteLoads) db.close()
})

describe.skipIf(!sqliteLoads)("Claude subscription provider IPC", () => {
  const input = { provider: "claude_subscription", displayName: "Subscription" }
  it("exposes preflight before account creation", async () => {
    expect(await invoke("providers:preflightClaudeSubscription")).toEqual(ready)
    expect(accounts.listAccounts()).toEqual([])
  })
  it("creates a keyless account and catalog only after successful preflight", async () => {
    const account = await invoke("providers:create", input)
    expect(account).toMatchObject({
      provider: "claude_subscription",
      hasKey: false,
      baseUrl: null,
      apiMode: "completions",
      maskedKey: null,
    })
    expect(models.listModels(account.id)).toMatchObject([
      { modelId: "sonnet", origin: "gateway" },
    ])
    expect(mocks.preflight.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.catalog.mock.invocationCallOrder[0]
    )
    expect(db.pragma("foreign_key_check")).toEqual([])
  })
  it("writes nothing when preflight fails", async () => {
    mocks.preflight.mockResolvedValue({
      ...ready,
      ok: false,
      hint: "Install CLI",
    })
    await expect(invoke("providers:create", input)).rejects.toThrow(
      "Install CLI"
    )
    expect(accounts.listAccounts()).toEqual([])
    expect(mocks.catalog).not.toHaveBeenCalled()
  })
  it("rolls back the account and every model when catalog insertion fails", async () => {
    mocks.catalog.mockResolvedValue({
      source: "discovered",
      models: [{ id: "sonnet" }, { id: "reject" }],
      hint: "Discovered",
    })
    db.exec(
      "CREATE TRIGGER fail_model BEFORE INSERT ON models WHEN NEW.model_id = 'reject' BEGIN SELECT RAISE(ABORT, 'fixture insertion failure'); END"
    )
    await expect(invoke("providers:create", input)).rejects.toThrow(
      "fixture insertion failure"
    )
    expect(accounts.listAccounts()).toEqual([])
    expect(db.prepare("SELECT * FROM models").all()).toEqual([])
  })
  it.each([
    { baseUrl: "https://custom.test" },
    { apiMode: "responses" },
    { apiKey: "private" },
    { encrypted_key: "private" },
  ])("rejects custom configuration before probing (%j)", async (patch) => {
    await expect(
      invoke("providers:create", { ...input, ...patch })
    ).rejects.toThrow(/official CLI login/)
    expect(mocks.preflight).not.toHaveBeenCalled()
    expect(accounts.listAccounts()).toEqual([])
  })
  it("rejects custom upstream and key changes for existing accounts", () => {
    const account = accounts.createAccount(
      input as Parameters<typeof accounts.createAccount>[0]
    )
    expect(() =>
      invoke("providers:update", account.id, { baseUrl: "https://custom.test" })
    ).toThrow(/official CLI login/)
    expect(invoke("providers:setKey", account.id, "private")).toMatchObject({
      ok: false,
    })
    expect(mocks.setKey).not.toHaveBeenCalled()
    expect(accounts.getAccount(account.id)?.baseUrl).toBeNull()
  })
  it("seeds the explicitly reported fallback catalog atomically", async () => {
    mocks.catalog.mockResolvedValue({
      source: "fallback",
      models: [{ id: "claude-sonnet-4-6" }],
      hint: "Fallback",
    })
    const account = await invoke("providers:create", input)
    expect(models.listModels(account.id)).toMatchObject([
      { modelId: "claude-sonnet-4-6", origin: "seeded" },
    ])
  })
  it("refreshes additively and preserves custom names, favorites and manual rows", async () => {
    const account = await invoke("providers:create", input)
    const original = models.listModels(account.id)[0]
    models.updateModel(original.id, { modelName: "My Sonnet", favorite: true })
    models.addModel({ accountId: account.id, modelId: "claude-custom" })
    mocks.catalog.mockResolvedValue({
      source: "discovered",
      models: [{ id: "opus" }],
      hint: "Discovered",
    })
    const result = await invoke(
      "providers:refreshClaudeSubscriptionModels",
      account.id
    )
    expect(result).toMatchObject({
      ok: true,
      catalog: { source: "discovered" },
    })
    expect(models.listModels(account.id)).toHaveLength(3)
    expect(models.getModel(original.id)).toMatchObject({
      modelName: "My Sonnet",
      favorite: true,
    })
  })
  it("retains all rows on failed discovery and reports fallback state", async () => {
    const account = await invoke("providers:create", input)
    const before = models.listModels(account.id)
    mocks.catalog.mockResolvedValue({
      source: "retained",
      models: before.map((model) => ({ id: model.modelId })),
      hint: "Previous entries retained",
    })
    expect(
      await invoke("providers:refreshClaudeSubscriptionModels", account.id)
    ).toMatchObject({ ok: true, catalog: { source: "retained" } })
    expect(models.listModels(account.id)).toEqual(before)
    mocks.preflight.mockResolvedValue({
      ...ready,
      ok: false,
      hint: "Recheck login",
    })
    expect(
      await invoke("providers:refreshClaudeSubscriptionModels", account.id)
    ).toMatchObject({ ok: false })
    expect(models.listModels(account.id)).toEqual(before)
  })
})
