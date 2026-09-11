export type AgentMode = "default" | "plan" | "auto"

export type AgentModeSession = {
  draft: AgentMode
  conversations: Record<string, AgentMode>
}

export const INITIAL_AGENT_MODE_SESSION: AgentModeSession = {
  draft: "default",
  conversations: {},
}

export function agentModeFor(
  session: AgentModeSession,
  conversationId: string | null
): AgentMode {
  return conversationId
    ? (session.conversations[conversationId] ?? "default")
    : session.draft
}

export function setConversationAgentMode(
  session: AgentModeSession,
  conversationId: string | null,
  update: AgentMode | ((current: AgentMode) => AgentMode)
): AgentModeSession {
  const current = agentModeFor(session, conversationId)
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

export function adoptDraftAgentMode(
  session: AgentModeSession,
  conversationId: string
): AgentModeSession {
  return {
    draft: "default",
    conversations: {
      ...session.conversations,
      [conversationId]: session.draft,
    },
  }
}
