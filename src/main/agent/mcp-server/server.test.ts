import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  cancelAllQuestions,
  pendingQuestionCount,
  resolveQuestion,
  type QuestionEvent,
} from "../questions/broker"
import { revokeAllGrants } from "./grants"
import { closeCliMcpBridge, grantCliMcpAccess, qualifyToolName } from "./server"
import type { CliMcpInjection, CliMcpToolName } from "./types"

// A real SDK client over the real loopback listener — the contract this bridge
// publishes to Claude and Codex, exercised end to end.
async function connect(token: string, url: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  )
  return client
}

interface Harness {
  injection: CliMcpInjection
  events: QuestionEvent[]
  abort: AbortController
}

async function grant(input: {
  conversationId?: string
  workspace?: string | null
  tools?: CliMcpToolName[]
  withQuestionSink?: boolean
}): Promise<Harness> {
  const events: QuestionEvent[] = []
  const abort = new AbortController()
  const injection = await grantCliMcpAccess({
    conversationId: input.conversationId ?? "conv-1",
    workingDirectory: "/tmp/one",
    workspace: input.workspace === undefined ? "/tmp/one" : input.workspace,
    provider: "claude_code",
    tools: input.tools ?? ["ask_user_question"],
    question:
      input.withQuestionSink === false
        ? null
        : { emit: (event) => events.push(event), signal: abort.signal },
  })
  return { injection, events, abort }
}

// Wait for the question the MCP call raises, without racing the round trip.
async function nextQuestion(events: QuestionEvent[]): Promise<QuestionEvent> {
  for (let i = 0; i < 200 && events.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (!events[0]) throw new Error("no question was emitted")
  return events[0]
}

const ASK = [
  {
    question: "Which database should the service use?",
    header: "Database",
    options: [{ label: "SQLite" }, { label: "Postgres" }],
  },
]

describe("CLI MCP bridge server", () => {
  beforeEach(() => {
    revokeAllGrants()
    cancelAllQuestions()
  })
  afterAll(async () => {
    cancelAllQuestions()
    await closeCliMcpBridge()
  })

  it("binds to loopback only and namespaces tools per provider", async () => {
    const { injection } = await grant({})
    expect(injection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(injection.tokenEnv).toBe("NORTH_STAR_MCP_TOKEN")
    expect(injection.allowedTools).toEqual([
      "mcp__north-star__ask_user_question",
    ])
    expect(qualifyToolName("codex_cli", "ask_user_question")).toBe(
      "north-star__ask_user_question"
    )
    injection.revoke()
  })

  it("initializes, lists, and runs a question round trip", async () => {
    const { injection, events } = await grant({})
    const client = await connect(injection.token, injection.url)
    try {
      const listed = await client.listTools()
      expect(listed.tools.map((t) => t.name)).toEqual(["ask_user_question"])

      const call = client.callTool({
        name: "ask_user_question",
        arguments: { questions: ASK },
      })
      const question = await nextQuestion(events)
      expect(question.questions[0].header).toBe("Database")
      resolveQuestion(question.requestId, [
        { selected: ["Postgres"], other: "with pgvector" },
      ])

      const result = (await call) as {
        isError?: boolean
        content: Array<{ text: string }>
      }
      expect(result.isError).toBeFalsy()
      expect(JSON.parse(result.content[0].text)).toEqual({
        answers: [
          {
            question: ASK[0].question,
            header: "Database",
            selected: ["Postgres"],
            other: "with pgvector",
          },
        ],
      })
    } finally {
      await client.close()
      injection.revoke()
    }
  })

  it("rejects missing, wrong, and revoked tokens before MCP handling", async () => {
    const { injection } = await grant({})
    const url = injection.url
    await expect(connect("", url)).rejects.toThrow()
    await expect(connect("not-a-real-token", url)).rejects.toThrow()

    const live = await connect(injection.token, url)
    await live.close()

    injection.revoke()
    await expect(connect(injection.token, url)).rejects.toThrow()
  })

  it("serves no tools and fails closed when a grant allows none", async () => {
    const { injection } = await grant({ tools: [] })
    const client = await connect(injection.token, injection.url)
    try {
      expect((await client.listTools()).tools).toEqual([])
      const result = (await client.callTool({
        name: "ask_user_question",
        arguments: { questions: ASK },
      })) as { isError?: boolean; content: Array<{ text: string }> }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("Unknown tool")
    } finally {
      await client.close()
      injection.revoke()
    }
  })

  it("rejects a tool the server does not implement", async () => {
    const { injection } = await grant({})
    const client = await connect(injection.token, injection.url)
    try {
      const result = (await client.callTool({
        name: "run_shell",
        arguments: { command: "rm -rf /" },
      })) as { isError?: boolean; content: Array<{ text: string }> }
      expect(result.isError).toBe(true)
    } finally {
      await client.close()
      injection.revoke()
    }
  })

  it("validates arguments instead of trusting the client's schema compliance", async () => {
    const { injection } = await grant({})
    const client = await connect(injection.token, injection.url)
    try {
      const result = (await client.callTool({
        name: "ask_user_question",
        arguments: {
          questions: [{ question: "Why?", header: "Y", options: [] }],
        },
      })) as { isError?: boolean; content: Array<{ text: string }> }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("at least 2 options")
      expect(pendingQuestionCount()).toBe(0)
    } finally {
      await client.close()
      injection.revoke()
    }
  })

  it("cannot ask when the turn has no attached question sink", async () => {
    const { injection } = await grant({ withQuestionSink: false })
    const client = await connect(injection.token, injection.url)
    try {
      const result = (await client.callTool({
        name: "ask_user_question",
        arguments: { questions: ASK },
      })) as { isError?: boolean; content: Array<{ text: string }> }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("no interactive session")
    } finally {
      await client.close()
      injection.revoke()
    }
  })

  it("releases a pending question when the turn is stopped", async () => {
    const { injection, events, abort } = await grant({})
    const client = await connect(injection.token, injection.url)
    try {
      const call = client.callTool({
        name: "ask_user_question",
        arguments: { questions: ASK },
      })
      await nextQuestion(events)
      abort.abort()
      const result = (await call) as {
        isError?: boolean
        content: Array<{ text: string }>
      }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("dismissed the question")
    } finally {
      await client.close()
      injection.revoke()
    }
  })

  it("releases a pending question when the grant is revoked", async () => {
    const { injection, events } = await grant({})
    const client = await connect(injection.token, injection.url)
    try {
      const call = client.callTool({
        name: "ask_user_question",
        arguments: { questions: ASK },
      })
      await nextQuestion(events)
      injection.revoke()
      const result = (await call) as { isError?: boolean }
      expect(result.isError).toBe(true)
      expect(pendingQuestionCount()).toBe(0)
    } finally {
      await client.close()
    }
  })

  it("keeps two simultaneous grants from seeing each other's turns", async () => {
    const a = await grant({ conversationId: "conv-a" })
    const b = await grant({ conversationId: "conv-b", tools: [] })
    const clientA = await connect(a.injection.token, a.injection.url)
    const clientB = await connect(b.injection.token, b.injection.url)
    try {
      expect((await clientA.listTools()).tools).toHaveLength(1)
      expect((await clientB.listTools()).tools).toHaveLength(0)

      const call = clientA.callTool({
        name: "ask_user_question",
        arguments: { questions: ASK },
      })
      await nextQuestion(a.events)
      // B's turn ending must not release A's question.
      b.injection.revoke()
      expect(pendingQuestionCount()).toBe(1)
      expect(b.events).toHaveLength(0)

      resolveQuestion(a.events[0].requestId, [{ selected: ["SQLite"] }])
      const result = (await call) as { isError?: boolean }
      expect(result.isError).toBeFalsy()
    } finally {
      await clientA.close()
      await clientB.close()
      a.injection.revoke()
    }
  })
})

describe("CLI MCP bridge discoverability", () => {
  beforeEach(() => {
    revokeAllGrants()
    cancelAllQuestions()
  })

  it("returns server instructions steering toward the granted tool", async () => {
    const { injection } = await grant({})
    const client = await connect(injection.token, injection.url)
    try {
      const instructions = client.getInstructions()
      expect(instructions).toContain("ask_user_question")
      expect(instructions).toContain("North Star")
      // Cedes everything else, so the model doesn't read this as a takeover.
      expect(instructions).toContain("native tools")
    } finally {
      await client.close()
      injection.revoke()
    }
  })

  it("sends no instructions when the grant carries no tools", async () => {
    const { injection } = await grant({ tools: [] })
    const client = await connect(injection.token, injection.url)
    try {
      expect(client.getInstructions()).toBeUndefined()
    } finally {
      await client.close()
      injection.revoke()
    }
  })

  it("describes the bridge tool in terms a CLI has a reason to prefer", async () => {
    const { injection } = await grant({})
    const client = await connect(injection.token, injection.url)
    try {
      const [tool] = (await client.listTools()).tools
      // The internal tool's "don't use it for things you can decide yourself"
      // framing reads as "skip this" to a CLI that can just ask in prose.
      expect(tool.description).not.toContain("Don't use it")
      expect(tool.description).toContain(
        "never write a question to them in prose"
      )
      expect(tool.description).toContain("clickable options")
    } finally {
      await client.close()
      injection.revoke()
    }
  })
})

describe("Claude system-prompt steering", () => {
  beforeEach(() => revokeAllGrants())

  it("names the provider-qualified tool and nothing else", async () => {
    const { injection } = await grant({})
    expect(injection.systemPromptSteering).toContain(
      "mcp__north-star__ask_user_question"
    )
    expect(injection.systemPromptSteering).toContain("North Star desktop app")
    // Narrow by construction: no mode prompts, skills, or internal tool names.
    expect(injection.systemPromptSteering).not.toContain("read_file")
    expect(injection.systemPromptSteering).not.toContain("run_shell")
    injection.revoke()
  })

  it("is null when the grant carries no tools", async () => {
    const { injection } = await grant({ tools: [] })
    expect(injection.systemPromptSteering).toBeNull()
    injection.revoke()
  })
})
