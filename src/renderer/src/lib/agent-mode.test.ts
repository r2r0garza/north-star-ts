import { describe, expect, it } from "vitest"
import {
  INITIAL_AGENT_MODE_SESSION,
  adoptDraftAgentMode,
  agentModeFor,
  setConversationAgentMode,
} from "./agent-mode"

describe("agent mode session", () => {
  it("keeps independent modes for each conversation", () => {
    let session = setConversationAgentMode(
      INITIAL_AGENT_MODE_SESSION,
      "conversation-a",
      "auto"
    )
    session = setConversationAgentMode(session, "conversation-b", "plan")

    expect(agentModeFor(session, "conversation-a")).toBe("auto")
    expect(agentModeFor(session, "conversation-b")).toBe("plan")
    expect(agentModeFor(session, "conversation-c")).toBe("default")
  })

  it("updates an offscreen conversation without changing the viewed one", () => {
    let session = setConversationAgentMode(
      INITIAL_AGENT_MODE_SESSION,
      "viewed",
      "auto"
    )
    session = setConversationAgentMode(session, "offscreen", "plan")
    session = setConversationAgentMode(session, "offscreen", (mode) =>
      mode === "plan" ? "default" : mode
    )

    expect(agentModeFor(session, "viewed")).toBe("auto")
    expect(agentModeFor(session, "offscreen")).toBe("default")
  })

  it("adopts a draft selection when its conversation is created", () => {
    const draft = setConversationAgentMode(
      INITIAL_AGENT_MODE_SESSION,
      null,
      "plan"
    )
    const session = adoptDraftAgentMode(draft, "created")

    expect(agentModeFor(session, "created")).toBe("plan")
    expect(agentModeFor(session, null)).toBe("default")
  })
})
