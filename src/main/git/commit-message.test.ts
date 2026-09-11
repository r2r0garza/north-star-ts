import { describe, expect, it } from "vitest"
import { parseCommitMessage, selectedPathForInspection } from "./commit-message"

describe("commit-message", () => {
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
