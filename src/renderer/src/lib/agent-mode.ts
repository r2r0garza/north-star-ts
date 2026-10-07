export type AgentMode = "default" | "plan" | "auto"

// `draft` is the mode of the not-yet-created conversation; null means the user
// hasn't picked one, so it follows the view's default (see `fallback`).
export type AgentModeSession = {
  draft: AgentMode | null
  conversations: Record<string, AgentMode>
}

export const INITIAL_AGENT_MODE_SESSION: AgentModeSession = {
  draft: null,
  conversations: {},
}

// `fallback` is the mode for a conversation (or draft) with no explicit pick —
// the per-view default (e.g. Auto for North Star).
export function agentModeFor(
  session: AgentModeSession,
  conversationId: string | null,
  fallback: AgentMode = "default"
): AgentMode {
  return conversationId
    ? (session.conversations[conversationId] ?? fallback)
    : (session.draft ?? fallback)
}

export function setConversationAgentMode(
  session: AgentModeSession,
  conversationId: string | null,
  update: AgentMode | ((current: AgentMode) => AgentMode),
  fallback: AgentMode = "default"
): AgentModeSession {
  const current = agentModeFor(session, conversationId, fallback)
  const mode = typeof update === "function" ? update(current) : update

  if (!conversationId) {
    return mode === session.draft ? session : { ...session, draft: mode }
  }
  if (session.conversations[conversationId] === mode) return session

  return {
    ...session,
    conversations: { ...session.conversations, [conversationId]: mode },
  }
}

// Clear the draft's explicit pick so a fresh blank conversation starts in the
// view's default mode.
export function resetDraftAgentMode(
  session: AgentModeSession
): AgentModeSession {
  return session.draft === null ? session : { ...session, draft: null }
}

export function adoptDraftAgentMode(
  session: AgentModeSession,
  conversationId: string,
  fallback: AgentMode = "default"
): AgentModeSession {
  return {
    draft: null,
    conversations: {
      ...session.conversations,
      [conversationId]: session.draft ?? fallback,
    },
  }
}
