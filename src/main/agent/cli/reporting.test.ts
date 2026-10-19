import { beforeEach, expect, it, vi } from "vitest"
import type { Conversation } from "../../db/types"

const state = vi.hoisted(() => ({
  messages: [] as { role: string; content: string }[],
  claude: vi.fn(),
  codex: vi.fn(),
  bridge: vi.fn(),
  session: vi.fn(),
}))
vi.mock("electron", () => ({ app: { getPath: vi.fn() } }))
vi.mock("../../db/repositories/messages", () => ({
  listMessages: () => state.messages,
  appendMessage: (message: { role: string; content: string }) =>
    state.messages.push(message),
}))
vi.mock("../../db/repositories/cli-sessions", () => ({
  deleteCliSession: vi.fn(),
  ensureCliSession: state.session,
  getCliSession: state.session,
  setCliSession: vi.fn(),
  touchCliSession: vi.fn(),
}))
vi.mock("../memory/service", () => ({ recordMemoryTurn: vi.fn() }))
vi.mock("./claude", () => ({
  normalizeClaudeModel: () => "sonnet",
  runClaudeCode: state.claude,
}))
vi.mock("./codex", () => ({
  normalizeCodexModel: vi.fn(),
  runCodexCli: state.codex,
}))
vi.mock("../mcp-server", () => ({
  grantCliMcpAccess: state.bridge,
  BROWSER_MCP_TOOL_NAMES: [],
}))
import { runClaudeConversation, runCodexConversation } from "./index"

beforeEach(() => {
  vi.clearAllMocks()
  state.messages = [
    { role: "user", content: "Execute the step" },
    { role: "assistant", content: "Malformed handoff" },
  ]
  state.claude.mockResolvedValue({ content: "Corrected handoff" })
})

it("repairs with a fresh isolated Claude report containing the correction instruction", async () => {
  const result = await runClaudeConversation({
    conversation: { id: "conversation" } as Conversation,
    reportOnly: true,
    reportProvider: "claude_code",
    userMessage: "Correct the handoff; do not redo the step",
    completionInstruction: "Return handoff JSON",
    abort: new AbortController(),
    onEvent: vi.fn(),
  })
  expect(result).toEqual({ content: "Corrected handoff" })
  expect(state.claude).toHaveBeenCalledOnce()
  const input = state.claude.mock.calls[0][0]
  expect(input).toMatchObject({
    resume: false,
    isolated: true,
    systemPrompt: "Return handoff JSON",
  })
  expect(input.sessionId).toBeTruthy()
  expect(JSON.parse(input.message)).toEqual([
    { role: "user", content: "Execute the step" },
    { role: "assistant", content: "Malformed handoff" },
    { role: "user", content: "Correct the handoff; do not redo the step" },
  ])
  expect(state.messages.at(-1)?.content).toBe("Corrected handoff")
  expect(state.session).not.toHaveBeenCalled()
  expect(state.bridge).not.toHaveBeenCalled()
  expect(state.codex).not.toHaveBeenCalled()
})

it("fails Codex reporting without starting an action-capable CLI or bridge", async () => {
  const result = await runCodexConversation({
    conversation: { id: "conversation" } as Conversation,
    reportOnly: true,
    reportProvider: "codex_cli",
    userMessage: "Correct the handoff",
    abort: new AbortController(),
    onEvent: vi.fn(),
  })
  expect(result.error).toContain("not supported")
  expect(state.claude).not.toHaveBeenCalled()
  expect(state.codex).not.toHaveBeenCalled()
  expect(state.session).not.toHaveBeenCalled()
  expect(state.bridge).not.toHaveBeenCalled()
  expect(state.messages).toHaveLength(2)
})
