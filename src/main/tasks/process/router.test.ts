import { describe, it, expect, beforeEach, vi } from "vitest"
import type { ProcessPhaseAgent } from "../../db/types"

// The classifier's one LLM call goes through the providers barrel. Mock it so
// route() is exercised without a network/gateway: `resolveLlm` returns a stub
// client + model, `createCompletion` returns whatever `nextReply` is set to (or
// throws `nextError`). NoActiveProviderError is a real-enough shim so the
// no-provider fallback branch is reachable.
let nextReply = ""
let nextError: unknown
let completionCalls = 0
// The `base` arg of the last createCompletion call — lets tests assert the roster
// + task made it into the prompt without exporting internal helpers.
let lastBase: { messages?: { role: string; content: string }[] } | undefined
vi.mock("../../agent/providers", () => {
  class NoActiveProviderError extends Error {}
  return {
    resolveLlm: () => ({
      client: {},
      model: "test-model",
      accountId: "a1",
      apiMode: "completions",
    }),
    createCompletion: async (
      _client: unknown,
      _model: string,
      _max: number,
      base: { messages?: { role: string; content: string }[] }
    ) => {
      completionCalls++
      lastBase = base
      if (nextError) throw nextError
      return { choices: [{ message: { content: nextReply } }] }
    },
    NoActiveProviderError,
  }
})

// Each pool agent's description is the routing signal. Mock the loader so tests
// control descriptions without touching the filesystem. `null` (agent no longer
// loads) is representable via missingAgents.
const descriptions: Record<string, string> = {}
const missingAgents = new Set<string>()
vi.mock("../../agent/agents/loader", () => ({
  loadAgent: async (name: string) => {
    if (missingAgents.has(name)) return null
    return { name, description: descriptions[name] ?? "" }
  },
}))

import { route } from "./router"
import { NoActiveProviderError as FakeNoProvider } from "../../agent/providers"

function agent(name: string, position: number): ProcessPhaseAgent {
  return {
    id: `${name}-id`,
    phaseId: "phase-1",
    agentName: name,
    skills: null,
    tools: null,
    position,
  }
}

const selection = { accountId: "a1", modelId: "m1" }

beforeEach(() => {
  nextReply = ""
  nextError = undefined
  completionCalls = 0
  lastBase = undefined
  for (const k of Object.keys(descriptions)) delete descriptions[k]
  missingAgents.clear()
})

describe("route", () => {
  it("returns the classifier's chosen pool member", async () => {
    descriptions["frontend"] = "React/CSS UI work"
    descriptions["backend"] = "APIs, databases, server logic"
    nextReply = "backend"

    const chosen = await route({
      pool: [agent("frontend", 0), agent("backend", 1)],
      taskPrompt: "Add a /session API route with a Postgres query",
      selection,
      signal: new AbortController().signal,
    })
    expect(chosen).toBe("backend")
    expect(completionCalls).toBe(1)
  })

  it("tolerates a wrapped/decorated reply (token match)", async () => {
    descriptions["frontend"] = "UI"
    descriptions["backend"] = "server"
    nextReply = "Agent: backend."

    const chosen = await route({
      pool: [agent("frontend", 0), agent("backend", 1)],
      taskPrompt: "build the server",
      selection,
      signal: new AbortController().signal,
    })
    expect(chosen).toBe("backend")
  })

  it("renders the roster + task into the classification prompt", async () => {
    descriptions["frontend"] = "React/CSS UI work"
    descriptions["backend"] = "APIs and databases"
    nextReply = "frontend"

    await route({
      pool: [agent("frontend", 0), agent("backend", 1)],
      taskPrompt: "Style the login page",
      selection,
      signal: new AbortController().signal,
    })
    const user = lastBase?.messages?.find((m) => m.role === "user")?.content ?? ""
    expect(user).toContain("frontend: React/CSS UI work")
    expect(user).toContain("backend: APIs and databases")
    expect(user).toContain("Style the login page")
  })

  it("falls back to pool[0] on a parse miss (unknown name)", async () => {
    descriptions["frontend"] = "UI"
    descriptions["backend"] = "server"
    nextReply = "some-agent-not-in-the-pool"

    const chosen = await route({
      pool: [agent("frontend", 0), agent("backend", 1)],
      taskPrompt: "do a thing",
      selection,
      signal: new AbortController().signal,
    })
    expect(chosen).toBe("frontend")
  })

  it("falls back to pool[0] on an empty reply", async () => {
    descriptions["frontend"] = "UI"
    descriptions["backend"] = "server"
    nextReply = "   "

    const chosen = await route({
      pool: [agent("frontend", 0), agent("backend", 1)],
      taskPrompt: "do a thing",
      selection,
      signal: new AbortController().signal,
    })
    expect(chosen).toBe("frontend")
  })

  it("falls back to pool[0] when no provider is configured", async () => {
    descriptions["frontend"] = "UI"
    descriptions["backend"] = "server"
    nextError = new FakeNoProvider("no provider")

    const chosen = await route({
      pool: [agent("frontend", 0), agent("backend", 1)],
      taskPrompt: "do a thing",
      selection,
      signal: new AbortController().signal,
    })
    expect(chosen).toBe("frontend")
  })

  it("falls back to pool[0] on any classifier error", async () => {
    descriptions["frontend"] = "UI"
    descriptions["backend"] = "server"
    nextError = new Error("gateway 500")

    const chosen = await route({
      pool: [agent("frontend", 0), agent("backend", 1)],
      taskPrompt: "do a thing",
      selection,
      signal: new AbortController().signal,
    })
    expect(chosen).toBe("frontend")
  })

  it("skips the LLM call entirely for a single-agent pool", async () => {
    descriptions["solo"] = "does everything"

    const chosen = await route({
      pool: [agent("solo", 0)],
      taskPrompt: "anything",
      selection,
      signal: new AbortController().signal,
    })
    expect(chosen).toBe("solo")
    expect(completionCalls).toBe(0)
  })

  it("keeps an unloadable pool agent selectable (empty description)", async () => {
    missingAgents.add("frontend")
    descriptions["backend"] = "server"
    nextReply = "frontend"

    const chosen = await route({
      pool: [agent("frontend", 0), agent("backend", 1)],
      taskPrompt: "do a thing",
      selection,
      signal: new AbortController().signal,
    })
    // frontend still resolves as the chosen name even though it didn't load.
    expect(chosen).toBe("frontend")
  })

  it("throws on an empty pool (programmer error)", async () => {
    await expect(
      route({
        pool: [],
        taskPrompt: "x",
        selection,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/empty agent pool/)
  })
})
