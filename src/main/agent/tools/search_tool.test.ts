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

const truncatingEnv = (): Environment =>
  ({
    resolve: async () => "/workspace",
    search: async () => ({
      engine: "rg",
      result: "content",
      matches: [
        {
          path: "/workspace/a.txt",
          line: 1,
          column: 1,
          text: "needle",
          kind: "match",
        },
      ],
      files: ["/workspace/a.txt"],
      counts: [],
      totalMatches: 1,
      capped: true,
      capReason: "captureBytes",
      captureTruncated: true,
      capturedOutputBytes: 600,
      observedOutputBytes: 1200,
      malformedJsonLines: 1,
    }),
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

  it("renders capture truncation with an actionable narrowing hint", async () => {
    const result = await searchTool.execute(
      { query: "needle", result: "content", max_results: 100 },
      {
        workspace: "/workspace",
        env: truncatingEnv(),
      }
    )

    expect(result).toContain(
      "output capture truncated after 600 captured bytes"
    )
    expect(result).toContain("results may be incomplete")
    expect(result).toContain("narrow query/path/globs")
  })
})
