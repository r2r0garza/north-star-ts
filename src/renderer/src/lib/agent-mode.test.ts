import { describe, expect, it } from "vitest"
import {
  INITIAL_AGENT_MODE_SESSION,
  adoptDraftAgentMode,
  agentModeFor,
  resetDraftAgentMode,
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

  it("falls back to the view default until the user picks a mode", () => {
    let session = setConversationAgentMode(
      INITIAL_AGENT_MODE_SESSION,
      "picked",
      "default",
      "auto"
    )
    expect(agentModeFor(session, "unpicked", "auto")).toBe("auto")
    expect(agentModeFor(session, "picked", "auto")).toBe("default")
    expect(agentModeFor(session, null, "auto")).toBe("auto")

    // An unpicked draft adopts the view default; a reset clears the draft pick.
    expect(
      agentModeFor(adoptDraftAgentMode(session, "new", "auto"), "new")
    ).toBe("auto")
    session = setConversationAgentMode(session, null, "plan", "auto")
    expect(agentModeFor(session, null, "auto")).toBe("plan")
    expect(agentModeFor(resetDraftAgentMode(session), null, "auto")).toBe(
      "auto"
    )
  })
})
