import { describe, expect, it } from "vitest"
import { parseRipgrepJson } from "./ripgrep"
import type { SearchOptions } from "./types"

const baseOpts: SearchOptions = {
  root: "/workspace",
  query: "needle",
  mode: "fixed",
  case: "smart",
  globs: [],
  result: "content",
  beforeContext: 0,
  afterContext: 0,
  includeHidden: false,
  respectIgnore: true,
  maxResults: 100,
  maxFileBytes: 1024 * 1024,
}

const rgEvent = (
  type: "match" | "context",
  path: string,
  line: number,
  text: string
) =>
  JSON.stringify({
    type,
    data: {
      path: { text: path },
      lines: { text: `${text}\n` },
      line_number: line,
      submatches:
        type === "match"
          ? [{ start: 0, end: Math.min(6, text.length), match: { text } }]
          : [],
    },
  })

describe("parseRipgrepJson", () => {
  it.each(["content", "files", "count"] as const)(
    "marks %s results capped when capture output was truncated",
    (result) => {
      const parsed = parseRipgrepJson(
        Buffer.from(`${rgEvent("match", "/workspace/a.txt", 1, "needle")}\n`),
        { ...baseOpts, result },
        {
          outputTruncated: true,
          capturedOutputBytes: 128,
          observedOutputBytes: 256,
        }
      )

      expect(parsed.capped).toBe(true)
      expect(parsed.captureTruncated).toBe(true)
      expect(parsed.capReason).toBe("captureBytes")
      expect(parsed.capturedOutputBytes).toBe(128)
      expect(parsed.observedOutputBytes).toBe(256)
    }
  )

  it("does not treat a capture boundary inside a JSON event as complete", () => {
    const complete = `${rgEvent("match", "/workspace/a.txt", 1, "needle")}\n`
    const partial = rgEvent(
      "match",
      "/workspace/b.txt",
      2,
      "needle later"
    ).slice(0, 35)

    const parsed = parseRipgrepJson(Buffer.from(complete + partial), baseOpts, {
      outputTruncated: true,
      capturedOutputBytes: complete.length + partial.length,
      observedOutputBytes: complete.length + partial.length + 100,
    })

    expect(parsed.matches).toHaveLength(1)
    expect(parsed.capped).toBe(true)
    expect(parsed.captureTruncated).toBe(true)
    expect(parsed.malformedJsonLines).toBe(1)
  })

  it("keeps complete context searches uncapped", () => {
    const parsed = parseRipgrepJson(
      Buffer.from(
        [
          rgEvent("context", "/workspace/a.txt", 1, "before"),
          rgEvent("match", "/workspace/a.txt", 2, "needle"),
          rgEvent("context", "/workspace/a.txt", 3, "after"),
          "",
        ].join("\n")
      ),
      { ...baseOpts, beforeContext: 1, afterContext: 1 }
    )

    expect(parsed.capped).toBe(false)
    expect(parsed.captureTruncated).toBeUndefined()
    expect(parsed.matches.map((m) => m.kind)).toEqual([
      "context",
      "match",
      "context",
    ])
  })
})
