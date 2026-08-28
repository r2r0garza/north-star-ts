import { beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import { createAccount } from "./provider-accounts"
import { addModel } from "./models"
import {
  deleteMapping,
  getMapping,
  listMappings,
  normalizeSourceModel,
  upsertMapping,
} from "./external-agent-model-mappings"
import {
  listMappingViews,
  resolveExternalAgentModel,
} from "../../agent/runtime/model-resolution"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("external agent model mappings", () => {
  it("normalizes source tokens by case and whitespace per source/account", () => {
    const account = createAccount({ provider: "openai", displayName: "OpenAI" })
    upsertMapping({
      sourceKind: "claude",
      sourceModel: "  Haiku ",
      destinationAccountId: account.id,
      destinationModelId: "anthropic/claude-haiku-4.5",
    })
    const updated = upsertMapping({
      sourceKind: "claude",
      sourceModel: "haiku",
      destinationAccountId: account.id,
      destinationModelId: "anthropic/claude-haiku-4.6",
    })
    expect(updated.normalizedSourceModel).toBe("haiku")
    expect(listMappings()).toHaveLength(1)
    expect(
      getMapping("claude", " HAIKU ", account.id)?.destinationModelId
    ).toBe("anthropic/claude-haiku-4.6")
  })

  it("keeps identical source tokens separate across source kinds", () => {
    const account = createAccount({ provider: "openai", displayName: "OpenAI" })
    upsertMapping({
      sourceKind: "claude",
      sourceModel: "haiku",
      destinationAccountId: account.id,
      destinationModelId: "claude-target",
    })
    upsertMapping({
      sourceKind: "cursor",
      sourceModel: "haiku",
      destinationAccountId: account.id,
      destinationModelId: "cursor-target",
    })
    expect(listMappings()).toHaveLength(2)
    expect(getMapping("cursor", "haiku", account.id)?.destinationModelId).toBe(
      "cursor-target"
    )
  })

  it("resolves inherit, exact catalog matches, saved mappings, and stale mappings", () => {
    const account = createAccount({ provider: "openai", displayName: "OpenAI" })
    addModel({ accountId: account.id, modelId: "gpt-5" })
    addModel({ accountId: account.id, modelId: "anthropic/haiku" })
    expect(
      resolveExternalAgentModel({
        sourceKind: "claude",
        sourceModel: "inherit",
        destinationAccountId: account.id,
        conversationModelId: "gpt-5",
      }).status
    ).toBe("inherit")
    expect(
      resolveExternalAgentModel({
        sourceKind: "github",
        sourceModel: "gpt-5",
        destinationAccountId: account.id,
        conversationModelId: "unused",
      }).status
    ).toBe("exact")

    upsertMapping({
      sourceKind: "claude",
      sourceModel: "haiku",
      destinationAccountId: account.id,
      destinationModelId: "anthropic/haiku",
    })
    expect(
      resolveExternalAgentModel({
        sourceKind: "claude",
        sourceModel: "haiku",
        destinationAccountId: account.id,
        conversationModelId: "gpt-5",
      }).status
    ).toBe("saved")

    deleteMapping("claude", "haiku", account.id)
    expect(
      resolveExternalAgentModel({
        sourceKind: "claude",
        sourceModel: "haiku",
        destinationAccountId: account.id,
        conversationModelId: "gpt-5",
      }).status
    ).toBe("unresolved")

    upsertMapping({
      sourceKind: "claude",
      sourceModel: "haiku",
      destinationAccountId: account.id,
      destinationModelId: "missing",
    })
    const stale = resolveExternalAgentModel({
      sourceKind: "claude",
      sourceModel: "haiku",
      destinationAccountId: account.id,
      conversationModelId: "gpt-5",
    })
    expect(stale.status).toBe("unresolved")
    expect(stale.status === "unresolved" ? stale.reason : null).toBe(
      "stale_mapping"
    )
  })

  it("marks mapping views stale when the destination model is absent", () => {
    const account = createAccount({ provider: "openai", displayName: "OpenAI" })
    upsertMapping({
      sourceKind: "codex",
      sourceModel: "gpt-5.6-sol",
      destinationAccountId: account.id,
      destinationModelId: "missing",
    })
    expect(listMappingViews()[0]?.stale).toBe(true)
  })

  it("does not fuzzy-match ambiguous aliases", () => {
    const account = createAccount({ provider: "openai", displayName: "OpenAI" })
    addModel({ accountId: account.id, modelId: "anthropic/claude-haiku-4.5" })
    addModel({ accountId: account.id, modelId: "anthropic/claude-haiku-4.6" })
    const result = resolveExternalAgentModel({
      sourceKind: "claude",
      sourceModel: "haiku",
      destinationAccountId: account.id,
      conversationModelId: "anthropic/claude-haiku-4.5",
    })
    expect(result.status).toBe("unresolved")
    expect(result.status === "unresolved" ? result.reason : null).toBe(
      "no_mapping"
    )
  })

  it("exposes the canonical source-model normalizer", () => {
    expect(normalizeSourceModel("  GPT   5  ")).toBe("gpt 5")
  })
})
