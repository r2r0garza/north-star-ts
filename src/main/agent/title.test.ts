import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createCompletion: vi.fn(),
  resolveLlm: vi.fn(() => ({
    client: { chat: { completions: { create: vi.fn() } } },
    model: "reasoning-model",
    apiMode: "completions" as const,
  })),
  resolveLlmTarget: vi.fn(() => ({
    account: { provider: "openai" },
    model: "reasoning-model",
  })),
  runClaudeCode: vi.fn(),
  getTitleGeneration: vi.fn(() => ({ accountId: null, modelId: null })),
}))

vi.mock("./providers", () => ({
  createCompletion: mocks.createCompletion,
  resolveLlm: mocks.resolveLlm,
  resolveLlmTarget: mocks.resolveLlmTarget,
}))

vi.mock("./cli/claude", () => ({
  normalizeClaudeModel: (model: string) => model,
  runClaudeCode: mocks.runClaudeCode,
}))

vi.mock("../settings/service", () => ({
  getTitleGeneration: mocks.getTitleGeneration,
}))

import {
  fallbackConversationTitle,
  generateTitle,
  parseGeneratedTitle,
} from "./title"

beforeEach(() => {
  mocks.createCompletion.mockReset()
  mocks.resolveLlm.mockClear()
  mocks.resolveLlmTarget.mockReset()
  mocks.resolveLlmTarget.mockReturnValue({
    account: { provider: "openai" },
    model: "reasoning-model",
  })
  mocks.runClaudeCode.mockReset()
  mocks.getTitleGeneration.mockClear()
})

describe("title output validation", () => {
  it("extracts the marked title after visible model reasoning", () => {
    expect(
      parseGeneratedTitle(
        "We need to summarize the user's request.\nTITLE: LangChain DeepAgents Overview",
        "go to https://docs.langchain.com/oss/python/deepagents/overview"
      )
    ).toBe("LangChain DeepAgents Overview")
  })

  it("rejects truncated reasoning narration", () => {
    expect(
      parseGeneratedTitle(
        "We need to produce a short title 3-6 words summarizing the user's first message",
        "go to https://docs.langchain.com/oss/python/deepagents/overview"
      )
    ).toBeNull()
  })

  it("rejects an echoed generic greeting", () => {
    expect(parseGeneratedTitle("hey there", "hey there")).toBeNull()
    expect(fallbackConversationTitle("hey there")).toBe("Casual Greeting")
  })

  it("builds a bounded semantic fallback from a documentation URL", () => {
    expect(
      fallbackConversationTitle(
        "go to https://docs.langchain.com/oss/python/deepagents/overview"
      )
    ).toBe("LangChain DeepAgents Overview")
  })
})

describe("generateTitle", () => {
  it("uses an isolated Claude Code call for a CLI title model", async () => {
    mocks.resolveLlmTarget.mockReturnValue({
      account: { provider: "claude_code" },
      model: "haiku",
    })
    mocks.runClaudeCode.mockResolvedValue({
      content: "TITLE: Conversation Naming Fix",
    })

    await expect(generateTitle("fix title generation")).resolves.toBe(
      "Conversation Naming Fix"
    )
    expect(mocks.runClaudeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "haiku",
        isolated: true,
        systemPrompt: expect.stringContaining("TITLE:"),
      })
    )
    expect(mocks.resolveLlm).not.toHaveBeenCalled()
  })

  it("requests low reasoning with enough room and accepts a marked title", async () => {
    mocks.createCompletion.mockResolvedValue({
      choices: [
        { message: { content: "TITLE: LangChain DeepAgents Overview" } },
      ],
    })

    await expect(
      generateTitle(
        "go to https://docs.langchain.com/oss/python/deepagents/overview"
      )
    ).resolves.toBe("LangChain DeepAgents Overview")

    expect(mocks.createCompletion).toHaveBeenCalledWith(
      expect.anything(),
      "reasoning-model",
      256,
      expect.objectContaining({ reasoning_effort: "low" }),
      [],
      "completions"
    )
  })

  it("retries without reasoning_effort when a provider rejects it", async () => {
    mocks.createCompletion
      .mockRejectedValueOnce(
        new Error("Unsupported parameter: reasoning_effort is not supported")
      )
      .mockResolvedValueOnce({
        choices: [{ message: { content: "TITLE: Friendly Greeting" } }],
      })

    await expect(generateTitle("hey there")).resolves.toBe("Friendly Greeting")
    expect(mocks.createCompletion).toHaveBeenCalledTimes(2)
    expect(mocks.createCompletion.mock.calls[0][3]).toMatchObject({
      reasoning_effort: "low",
    })
    expect(mocks.createCompletion.mock.calls[1][3]).not.toHaveProperty(
      "reasoning_effort"
    )
  })

  it("uses the safe fallback when the completion contains only reasoning", async () => {
    mocks.createCompletion.mockResolvedValue({
      choices: [
        {
          message: {
            content:
              "We need to produce a short title summarizing the user's first message",
          },
        },
      ],
    })

    await expect(generateTitle("hey there")).resolves.toBe("Casual Greeting")
  })
})
