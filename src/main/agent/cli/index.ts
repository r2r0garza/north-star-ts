import { app } from "electron"
import { mkdir, realpath, stat } from "fs/promises"
import { isAbsolute, join, resolve } from "path"
import { appendMessage, listMessages } from "../../db/repositories/messages"
import {
  deleteCliSession,
  ensureCliSession,
  getCliSession,
  setCliSession,
  touchCliSession,
} from "../../db/repositories/cli-sessions"
import type { Conversation } from "../../db/types"
import type { ChatEvent, ChatResult } from "../index"
import { recordMemoryTurn } from "../memory/service"
import { normalizeClaudeModel, runClaudeCode } from "./claude"
import { normalizeCodexModel, runCodexCli } from "./codex"
import { CliTranscriptRecorder } from "./transcript"
import {
  claudeMcpArgs,
  cliMcpEnv,
  codexMcpArgs,
  grantCliMcpAccess,
  writeClaudeMcpConfig,
  type CliMcpInjection,
  type CliMcpProvider,
  type CliMcpToolName,
  BROWSER_MCP_TOOL_NAMES,
} from "../mcp-server"
import type { BrowserHandle } from "../../browser/manager"

// The North Star tools a CLI turn may reach over the MCP bridge (plan 045).
// `ask_user_question` is offered only when someone is watching this turn and can
// actually answer — a headless Process worker gets an empty grant, and with no
// tools to serve we skip the bridge entirely rather than injecting a dead server.
// Exported for tests: the browser half of this is only reachable if runAgentLoop
// actually forwards `provideBrowser` to the runner, which is exactly what once
// silently regressed (every option here is optional, so types can't catch it).
export function bridgeToolsFor(input: {
  suppressUserQuestions?: boolean
  hasBrowser: boolean
}): CliMcpToolName[] {
  const tools: CliMcpToolName[] = []
  if (!input.suppressUserQuestions) tools.push("ask_user_question")
  // Granted whenever this turn has a handle to give. Claude Code has no browser
  // of its own (only WebFetch and shelling out to `open`), so this is a real
  // capability gain there. Codex DOES have one — `browser_use`/`computer_use`
  // are stable and on, surfacing as its `cua_repl` tool — and it also defers all
  // MCP tools behind a tool search (`tool_search_always_defer_mcp_tools`, now a
  // permanent default), so it reaches for its own browser unless asked for ours.
  // Ours is still the one visible in the app, bound to the conversation's tab.
  if (input.hasBrowser) tools.push(...BROWSER_MCP_TOOL_NAMES)
  return tools
}

// Mint this turn's grant. Returns null when nothing is granted; throws when the
// bridge itself can't start, so the caller fails the turn rather than running
// with a partial contract.
async function openBridge(input: {
  conversationId: string
  cwd: string
  workspace: string | null
  provider: CliMcpProvider
  tools: CliMcpToolName[]
  onEvent: (event: ChatEvent) => void
  signal: AbortSignal
  browser: BrowserHandle | undefined
}): Promise<CliMcpInjection | null> {
  if (input.tools.length === 0) return null
  try {
    return await grantCliMcpAccess({
      conversationId: input.conversationId,
      workingDirectory: input.cwd,
      workspace: input.workspace,
      provider: input.provider,
      tools: input.tools,
      question: { emit: input.onEvent, signal: input.signal },
      browser: input.browser
        ? { browser: input.browser, signal: input.signal }
        : null,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`The North Star MCP bridge could not start: ${detail}`)
  }
}

export async function resolveCliCwd(input: {
  conversation: Conversation
  workspace?: string
  userDataPath?: string
}): Promise<string> {
  if (input.conversation.mode === "chat") {
    const cwd = join(
      input.userDataPath ?? app.getPath("userData"),
      "cli-chat-workdirs",
      input.conversation.id
    )
    await mkdir(cwd, { recursive: true })
    return realpath(cwd)
  }
  if (!input.workspace || !isAbsolute(input.workspace)) {
    throw new Error(
      "A valid absolute workspace path is required for CLI providers."
    )
  }
  const cwd = resolve(input.workspace)
  const info = await stat(cwd).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`Workspace does not exist: ${cwd}`)
  return realpath(cwd)
}

export async function runCodexConversation(input: {
  conversation: Conversation
  workspace?: string
  // Withhold the MCP bridge's ask_user_question: this turn has nobody watching
  // who could answer. Mirrors RunAgentLoopOptions.suppressUserQuestions.
  suppressUserQuestions?: boolean
  // Build the agent browser handle for this turn (RunAgentLoopOptions.provideBrowser).
  // Injected by the caller rather than imported — the agent module can't reach
  // the BrowserManager singleton. Absent where there is no browser.
  provideBrowser?: (signal: AbortSignal) => BrowserHandle
  // Memory scope for this turn, resolved by the caller the same way the main
  // agent loop resolves it. These CLI paths return before that loop runs, and
  // previously recorded no memory at all.
  memoryWorkspaceDir?: string
  userMessage?: string
  model?: string | null
  abort: AbortController
  onEvent: (event: ChatEvent) => void
}): Promise<ChatResult> {
  let prompt = input.userMessage
  if (prompt !== undefined) {
    prompt = prompt || "Hello"
    appendMessage({
      conversationId: input.conversation.id,
      role: "user",
      content: prompt,
    })
  } else {
    const latestUser = listMessages(input.conversation.id)
      .slice()
      .reverse()
      .find((message) => message.role === "user" && message.content)
    prompt = latestUser?.content ?? "Continue."
  }

  // Visible prose this turn produced. Accumulated from the stream so a stopped
  // or failed turn still has its work recorded, not just a clean completion.
  let assistantText = ""
  const transcript = new CliTranscriptRecorder(input.conversation.id)
  let bridge: CliMcpInjection | null = null
  try {
    const cwd = await resolveCliCwd({
      conversation: input.conversation,
      workspace: input.workspace,
    })
    const session = getCliSession(input.conversation.id, "codex_cli")
    // Per-turn MCP grant. Minted here and revoked in `finally` on every exit
    // path — success, failure, Stop, or spawn error.
    bridge = await openBridge({
      conversationId: input.conversation.id,
      cwd,
      workspace: input.conversation.mode === "chat" ? null : cwd,
      provider: "codex_cli",
      tools: bridgeToolsFor({ ...input, hasBrowser: !!input.provideBrowser }),
      onEvent: input.onEvent,
      signal: input.abort.signal,
      browser: input.provideBrowser?.(input.abort.signal),
    })
    const toolNames = new Map<string, string>()
    const result = await runCodexCli({
      cwd,
      message: prompt,
      threadId: session?.sessionId,
      model: normalizeCodexModel(input.model),
      signal: input.abort.signal,
      mcpArgs: bridge ? codexMcpArgs(bridge) : undefined,
      extraEnv: bridge ? cliMcpEnv(bridge, "codex_cli") : undefined,
      onEvent: (event) => {
        transcript.record(event)
        if (event.type === "text" && event.text) {
          assistantText += event.text
          input.onEvent({ type: "token", delta: event.text })
        } else if (event.type === "tool_start" && event.id && event.name) {
          toolNames.set(event.id, event.name)
          input.onEvent({
            type: "tool",
            phase: "start",
            id: event.id,
            name: event.name,
            arguments: event.arguments ?? "{}",
          })
        } else if (event.type === "tool_done" && event.id) {
          input.onEvent({
            type: "tool",
            phase: "done",
            id: event.id,
            name: toolNames.get(event.id) ?? event.name ?? "Codex command",
            result: event.result ?? "",
          })
        }
      },
    })
    if (result.threadId) {
      setCliSession(input.conversation.id, "codex_cli", result.threadId)
    }
    touchCliSession(input.conversation.id, "codex_cli")
    transcript.persist(
      result.error || result.stopped ? undefined : (result.content ?? "")
    )
    if (result.stopped) {
      appendMessage({
        conversationId: input.conversation.id,
        role: "assistant",
        content: "Stopped by user.",
      })
      return { stopped: true }
    }
    if (result.error) {
      appendMessage({
        conversationId: input.conversation.id,
        role: "assistant",
        content: `The Codex CLI turn ended early: ${result.error}`,
      })
      return { error: result.error }
    }
    if (result.content) assistantText = result.content
    return { content: result.content }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    transcript.persist()
    appendMessage({
      conversationId: input.conversation.id,
      role: "assistant",
      content: `The Codex CLI turn ended early: ${message}`,
    })
    return { error: message }
  } finally {
    // Revoking releases any MCP call still blocked on a question, so the child
    // can never outlive the grant that authorized it.
    bridge?.revoke()
    // Every exit path, matching the main agent loop. `userMessage` is undefined
    // on a resume, which tells the service to log the turn without extracting.
    void recordMemoryTurn({
      conversationId: input.conversation.id,
      userText: input.userMessage,
      assistantText,
      workspaceDir: input.memoryWorkspaceDir,
    }).catch((err) => console.warn("[memory] turn record failed:", err))
  }
}

export async function runClaudeConversation(input: {
  conversation: Conversation
  workspace?: string
  // Withhold the MCP bridge's ask_user_question: this turn has nobody watching
  // who could answer. Mirrors RunAgentLoopOptions.suppressUserQuestions.
  suppressUserQuestions?: boolean
  // Build the agent browser handle for this turn (RunAgentLoopOptions.provideBrowser).
  // Injected by the caller rather than imported — the agent module can't reach
  // the BrowserManager singleton. Absent where there is no browser.
  provideBrowser?: (signal: AbortSignal) => BrowserHandle
  // Memory scope for this turn, resolved by the caller the same way the main
  // agent loop resolves it. These CLI paths return before that loop runs, and
  // previously recorded no memory at all.
  memoryWorkspaceDir?: string
  userMessage?: string
  model?: string | null
  abort: AbortController
  onEvent: (event: ChatEvent) => void
}): Promise<ChatResult> {
  let prompt = input.userMessage
  if (prompt !== undefined) {
    prompt = prompt || "Hello"
    appendMessage({
      conversationId: input.conversation.id,
      role: "user",
      content: prompt,
    })
  } else {
    const latestUser = listMessages(input.conversation.id)
      .slice()
      .reverse()
      .find((message) => message.role === "user" && message.content)
    prompt = latestUser?.content ?? "Continue."
  }

  // Visible prose this turn produced. Accumulated from the stream so a stopped
  // or failed turn still has its work recorded, not just a clean completion.
  let assistantText = ""
  const transcript = new CliTranscriptRecorder(input.conversation.id)
  let bridge: CliMcpInjection | null = null
  let mcpConfig: { path: string; cleanup: () => Promise<void> } | null = null
  try {
    const cwd = await resolveCliCwd({
      conversation: input.conversation,
      workspace: input.workspace,
    })
    const { session, created } = ensureCliSession(
      input.conversation.id,
      "claude_code"
    )
    // Per-turn MCP grant. Minted here and revoked in `finally` on every exit
    // path — success, failure, Stop, or spawn error.
    bridge = await openBridge({
      conversationId: input.conversation.id,
      cwd,
      workspace: input.conversation.mode === "chat" ? null : cwd,
      provider: "claude_code",
      tools: bridgeToolsFor({ ...input, hasBrowser: !!input.provideBrowser }),
      onEvent: input.onEvent,
      signal: input.abort.signal,
      browser: input.provideBrowser?.(input.abort.signal),
    })
    if (bridge) {
      // App-owned session config. Holds the URL and a ${VAR} placeholder — never
      // the token — and leaves the user's own MCP files untouched.
      mcpConfig = await writeClaudeMcpConfig(
        bridge,
        join(app.getPath("userData"), "cli-mcp-configs"),
        `${input.conversation.id}-${session.sessionId}`
      )
    }
    const toolNames = new Map<string, string>()
    const result = await runClaudeCode({
      cwd,
      message: prompt,
      sessionId: session.sessionId,
      resume: !created,
      model: normalizeClaudeModel(input.model),
      signal: input.abort.signal,
      mcpArgs:
        bridge && mcpConfig ? claudeMcpArgs(bridge, mcpConfig.path) : undefined,
      extraEnv: bridge ? cliMcpEnv(bridge, "claude_code") : undefined,
      onEvent: (event) => {
        transcript.record(event)
        if (event.type === "text" && event.text) {
          assistantText += event.text
          input.onEvent({ type: "token", delta: event.text })
        } else if (event.type === "tool_start" && event.id && event.name) {
          toolNames.set(event.id, event.name)
          input.onEvent({
            type: "tool",
            phase: "start",
            id: event.id,
            name: event.name,
            arguments: event.arguments ?? "{}",
          })
        } else if (event.type === "tool_done" && event.id) {
          input.onEvent({
            type: "tool",
            phase: "done",
            id: event.id,
            name: toolNames.get(event.id) ?? event.name ?? "Claude tool",
            result: event.result ?? "",
          })
        }
      },
    })
    touchCliSession(input.conversation.id, "claude_code")
    transcript.persist(
      result.error || result.stopped ? undefined : (result.content ?? "")
    )
    if (result.stopped) {
      appendMessage({
        conversationId: input.conversation.id,
        role: "assistant",
        content: "⏹ Stopped by user.",
      })
      return { stopped: true }
    }
    if (result.error) {
      // A failed first spawn (missing binary, auth failure, invalid setup) did
      // not establish a resumable native session. Let the next attempt use
      // --session-id again instead of trying --resume on a phantom session.
      if (created) deleteCliSession(input.conversation.id, "claude_code")
      appendMessage({
        conversationId: input.conversation.id,
        role: "assistant",
        content: `⚠️ The Claude Code turn ended early: ${result.error}`,
      })
      return { error: result.error }
    }
    if (result.content) assistantText = result.content
    return { content: result.content }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    transcript.persist()
    appendMessage({
      conversationId: input.conversation.id,
      role: "assistant",
      content: `⚠️ The Claude Code turn ended early: ${message}`,
    })
    return { error: message }
  } finally {
    // Revoking releases any MCP call still blocked on a question, so the child
    // can never outlive the grant that authorized it.
    bridge?.revoke()
    void mcpConfig?.cleanup()
    // Every exit path, matching the main agent loop. `userMessage` is undefined
    // on a resume, which tells the service to log the turn without extracting.
    void recordMemoryTurn({
      conversationId: input.conversation.id,
      userText: input.userMessage,
      assistantText,
      workspaceDir: input.memoryWorkspaceDir,
    }).catch((err) => console.warn("[memory] turn record failed:", err))
  }
}
