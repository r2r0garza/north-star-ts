import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  diffFile: vi.fn(),
  completion: vi.fn(),
}))
vi.mock("../settings/service", () => ({ getLlm: () => ({}) }))
vi.mock("../agent/providers", () => ({
  resolveLlm: () => ({ client: {}, model: "test", apiMode: "completions" }),
  createCompletion: mocks.completion,
}))
vi.mock("./service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service")>()),
  GitService: class {
    status = mocks.status
    diffFile = mocks.diffFile
  },
}))
import {
  generateCommitMessage,
  parseCommitMessage,
  selectedPathForInspection,
} from "./commit-message"

beforeEach(() => vi.clearAllMocks())

describe("commit-message", () => {
  it("allows sequential inspection of more than four selected files", async () => {
    const paths = Array.from({ length: 6 }, (_, i) => `file${i}.ts`)
    mocks.status.mockResolvedValue({
      isRepo: true,
      entries: paths.map((path) => ({ path, kind: "modified" })),
    })
    mocks.diffFile.mockResolvedValue({ diff: "selected diff" })
    for (const [i, path] of paths.entries()) {
      mocks.completion.mockResolvedValueOnce({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: `${i}`,
                  function: {
                    name: "exec_command",
                    arguments: JSON.stringify({
                      command: `git diff -- ${path}`,
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
    }
    mocks.completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '{"commit_message":"fix: update selected files"}',
          },
        },
      ],
    })
    expect(await generateCommitMessage("/workspace", paths)).toEqual({
      ok: true,
      commitMessage: "fix: update selected files",
    })
    expect(mocks.diffFile).toHaveBeenCalledTimes(6)
  })

  it("requests a final answer without tools when the inspection budget is spent", async () => {
    mocks.status.mockResolvedValue({
      isRepo: true,
      entries: [{ path: "a.ts", kind: "modified" }],
    })
    mocks.diffFile.mockResolvedValue({ diff: "diff" })
    mocks.completion.mockImplementation(
      async (_client, _model, _tokens, request) => ({
        choices: [
          {
            message:
              request.tool_choice === "none"
                ? { content: '{"commit_message":"fix: update a"}' }
                : {
                    tool_calls: [
                      {
                        id: "call",
                        function: {
                          name: "exec_command",
                          arguments: '{"command":"git diff -- a.ts"}',
                        },
                      },
                    ],
                  },
          },
        ],
      })
    )
    expect(await generateCommitMessage("/workspace", ["a.ts"])).toEqual({
      ok: true,
      commitMessage: "fix: update a",
    })
    expect(mocks.completion).toHaveBeenCalledTimes(5)
  })

  it("accepts only a single commit_message field", () => {
    expect(
      parseCommitMessage('{"commit_message":"feat(git): add actions"}')
    ).toBe("feat(git): add actions")
    expect(
      parseCommitMessage('```json\n{"commit_message":"fix: parse output"}\n```')
    ).toBe("fix: parse output")
    expect(
      parseCommitMessage('{"commit_message":"ok","extra":true}')
    ).toBeNull()
    expect(
      parseCommitMessage('Here is JSON: {"commit_message":"ok"}')
    ).toBeNull()
    expect(parseCommitMessage('{"commit_message":""}')).toBeNull()
  })

  it("permits only selected-path Git inspection commands", () => {
    const selected = ["src/a.ts", "new file.txt"]
    expect(selectedPathForInspection("git diff -- src/a.ts", selected)).toBe(
      "src/a.ts"
    )
    expect(
      selectedPathForInspection('git diff -- "new file.txt"', selected)
    ).toBe("new file.txt")
    expect(
      selectedPathForInspection("git diff -- src/other.ts", selected)
    ).toBeNull()
    expect(selectedPathForInspection("git add src/a.ts", selected)).toBeNull()
    expect(
      selectedPathForInspection("git diff -- src/a.ts; git push", selected)
    ).toBeNull()
    expect(selectedPathForInspection("cat src/a.ts", selected)).toBeNull()
  })
})
