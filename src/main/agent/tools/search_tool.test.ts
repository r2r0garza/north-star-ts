import { describe, expect, it } from "vitest"
import { SearchExecutionError, SearchPatternError } from "../env/ripgrep"
import type { Environment } from "../env/types"
import { searchTool } from "./search_tool"

const failingEnv = (err: Error): Environment =>
  ({
    resolve: async () => "/workspace",
    search: async () => {
      throw err
    },
  }) as unknown as Environment

describe("search_tool", () => {
  it("renders infrastructure failures as search errors even in regex mode", async () => {
    const result = await searchTool.execute(
      { query: "needle", mode: "regex" },
      {
        workspace: "/workspace",
        env: failingEnv(
          new SearchExecutionError(
            "search_unavailable",
            "ripgrep could not start: ENOENT"
          )
        ),
      }
    )

    expect(result).toContain("ERROR[search_unavailable]")
    expect(result).not.toContain("ERROR[bad_regex]")
  })

  it("renders genuine pattern failures as bad_regex", async () => {
    const result = await searchTool.execute(
      { query: "[", mode: "regex" },
      {
        workspace: "/workspace",
        env: failingEnv(new SearchPatternError("rg: regex parse error")),
      }
    )

    expect(result).toContain("ERROR[bad_regex]")
  })
})
