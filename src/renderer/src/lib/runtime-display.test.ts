import { describe, expect, it } from "vitest"
import { runtimeBadgeDisplay } from "./runtime-display"
import type { AccountWithModels, ProcessRuntimeSnapshot } from "@/types"

const providers = [
  {
    account: { id: "acct-or", displayName: "OpenRouter" },
    models: [
      {
        modelId: "anthropic/claude-3.5-sonnet",
        modelName: "Claude 3.5 Sonnet",
      },
      { modelId: "meta/llama-3-70b", modelName: null },
    ],
  },
] as unknown as AccountWithModels[]

describe("runtimeBadgeDisplay", () => {
  it("shows the snapshot's account and model label", () => {
    const snapshot: ProcessRuntimeSnapshot = {
      worker: {
        accountId: "acct-or",
        modelId: "anthropic/claude-3.5-sonnet",
        source: "phase",
      },
    }
    expect(runtimeBadgeDisplay(snapshot, providers)).toEqual({
      label: "OpenRouter / Claude 3.5 Sonnet",
      title:
        "OpenRouter · anthropic/claude-3.5-sonnet · Runtime source: Phase override",
    })
  })

  it("falls back to the raw model id when the catalog has no display name", () => {
    const display = runtimeBadgeDisplay(
      {
        worker: {
          accountId: "acct-or",
          modelId: "meta/llama-3-70b",
          source: "run",
        },
      },
      providers
    )
    expect(display?.label).toBe("OpenRouter / meta/llama-3-70b")
  })

  it("keeps the model id when the account was deleted", () => {
    const display = runtimeBadgeDisplay(
      {
        worker: {
          accountId: "gone",
          modelId: "some-model",
          source: "phase_agent",
        },
      },
      providers
    )
    expect(display).toEqual({
      label: "some-model",
      title:
        "Account no longer available · some-model · Runtime source: Phase agent override",
    })
  })

  it("reads the requested slot, not always the worker", () => {
    const snapshot: ProcessRuntimeSnapshot = {
      validator: {
        accountId: "acct-or",
        modelId: "meta/llama-3-70b",
        source: "run",
      },
    }
    expect(runtimeBadgeDisplay(snapshot, providers)).toBeNull()
    expect(runtimeBadgeDisplay(snapshot, providers, "validator")).not.toBeNull()
  })

  it("returns null for historical runs and default-only snapshots", () => {
    expect(runtimeBadgeDisplay(undefined, providers)).toBeNull()
    expect(runtimeBadgeDisplay(null, providers)).toBeNull()
    expect(runtimeBadgeDisplay({}, providers)).toBeNull()
    expect(
      runtimeBadgeDisplay(
        { worker: { accountId: null, modelId: null, source: "default" } },
        providers
      )
    ).toBeNull()
  })

  it("renders a very long model id without throwing", () => {
    const modelId = `vendor/${"x".repeat(300)}`
    const display = runtimeBadgeDisplay(
      { worker: { accountId: null, modelId, source: "source_conversation" } },
      []
    )
    expect(display?.label).toBe(modelId)
  })
})
