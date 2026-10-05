import { mkdir, rm } from "fs/promises"
import { homedir } from "os"
import { join } from "path"
import { dataDirName } from "../../config/system-name"
import { LocalEnvironment } from "../env/local"
import type { ToolContext } from "./types"

// Chat has no workspace, but it still gets the command tools so it can install
// packages and run skill helpers. Its commands run in a per-conversation scratch
// dir instead: ~/.<system>/chats/<conversationId>. The command tools need
// ctx.workspace (as the cwd root, and to match later poll/stdin/terminate calls
// to their session), so the agent loop runs every one of them with the context
// chatShellContext() returns. Approval works exactly as in a workspace.

// The command-session tools a workspace-less Chat is offered.
export const CHAT_SHELL_TOOL_NAMES = new Set([
  "exec_command",
  "write_stdin",
  "poll_command",
  "wait_for_events",
  "terminate_command",
])

const SAFE_ID = /^[A-Za-z0-9_-]+$/

export function chatScratchDir(
  conversationId: string,
  home: string = homedir()
): string {
  return join(home, dataDirName(), "chats", conversationId)
}

// The tool context for a Chat command: rooted in the scratch dir (created on
// first use), with the turn's environment re-rooted there so it keeps the chat
// venv overlay. Throws when the conversation id can't name a directory.
export async function chatShellContext(ctx: ToolContext): Promise<ToolContext> {
  const id = ctx.conversationId ?? ""
  if (!SAFE_ID.test(id)) {
    throw new Error("This conversation has no scratch folder for commands.")
  }
  const workspace = chatScratchDir(id)
  await mkdir(workspace, { recursive: true })
  const env =
    ctx.env instanceof LocalEnvironment
      ? ctx.env.withWorkspace(workspace)
      : new LocalEnvironment(workspace)
  return { ...ctx, workspace, env }
}

// Best-effort, like deletePlanFiles: a leftover scratch dir must never fail a
// conversation delete.
export async function deleteChatScratchDirs(
  conversationIds: Iterable<string>
): Promise<void> {
  for (const id of conversationIds) {
    if (!SAFE_ID.test(id)) continue
    try {
      await rm(chatScratchDir(id), { recursive: true, force: true })
    } catch (err) {
      console.warn(`Could not remove chat scratch dir for ${id}: ${err}`)
    }
  }
}
