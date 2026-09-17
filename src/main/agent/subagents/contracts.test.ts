import { describe, expect, it } from "vitest"
import {
  SUBAGENT_LIMITS,
  serializeSubagentResults,
  validateSpawnSubagentsInput,
} from "./contracts"

const assignment = {
  id: "scan",
  agent: { type: "ephemeral", profile: "explore" },
  prompt: "inspect the workspace",
  access: "read",
}

describe("subagent contracts", () => {
  it("accepts a bounded read-only batch", () => {
    expect(
      validateSpawnSubagentsInput(
        { assignments: [assignment] },
        { planMode: false, writeEnabled: false }
      ).ok
    ).toBe(true)
  })

  it("rejects the whole request for duplicate ids and invalid write profiles", () => {
    expect(
      validateSpawnSubagentsInput(
        { assignments: [assignment, assignment] },
        { planMode: false, writeEnabled: false }
      )
    ).toMatchObject({ ok: false, error: "duplicate assignment id 'scan'" })
    expect(
      validateSpawnSubagentsInput(
        {
          assignments: [
            {
              ...assignment,
              access: "write",
              agent: { type: "ephemeral", profile: "explore" },
            },
          ],
        },
        { planMode: false, writeEnabled: true }
      )
    ).toMatchObject({ ok: false, error: "explore subagents only support read access" })
  })

  it("keeps aggregate output under its declared bound", () => {
    const output = serializeSubagentResults(
      Array.from({ length: 4 }, (_, index) => ({
        id: `child-${index}`,
        status: "completed" as const,
        identity: "general",
        access: "read" as const,
        content: "x".repeat(50_000),
      }))
    )
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(
      SUBAGENT_LIMITS.maxResultBytes
    )
    expect(output).toContain("truncated")
  })
})
