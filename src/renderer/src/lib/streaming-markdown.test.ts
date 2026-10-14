import { describe, expect, it } from "vitest"
import { splitStreamingMarkdown } from "./streaming-markdown"

describe("splitStreamingMarkdown", () => {
  it("keeps finished blocks stable and leaves the open block as the tail", () => {
    const parts = splitStreamingMarkdown("# Title\n\nFirst para.\n\nSecond pa")

    // "Second pa" is still arriving, so the boundary before it isn't confirmed.
    expect(parts).toEqual({
      blocks: ["# Title\n\n"],
      tail: "First para.\n\nSecond pa",
    })
  })

  it("rejoins to the original content", () => {
    const content =
      "Intro.\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n| A | B |\n| - | - |\n\nEnd\n"
    const { blocks, tail } = splitStreamingMarkdown(content)

    expect(blocks.join("") + tail).toBe(content)
  })

  it("does not split inside a fenced code block, even across blank lines", () => {
    const { blocks, tail } = splitStreamingMarkdown(
      "Before.\n\n```ts\nconst a = 1\n\nconst b = 2\n"
    )

    expect(blocks).toEqual(["Before.\n\n"])
    expect(tail).toBe("```ts\nconst a = 1\n\nconst b = 2\n")
  })

  it("splits after a closed fence", () => {
    const { blocks, tail } = splitStreamingMarkdown(
      "~~~\ncode\n\nmore\n~~~\n\nAfter\n"
    )

    expect(blocks).toEqual(["~~~\ncode\n\nmore\n~~~\n\n"])
    expect(tail).toBe("After\n")
  })

  it("waits for a complete line before confirming a boundary", () => {
    expect(splitStreamingMarkdown("Para.\n\nNext").blocks).toEqual([])
    expect(splitStreamingMarkdown("Para.\n\n").blocks).toEqual([])
  })

  it("keeps loose list items, indented continuations, and quotes together", () => {
    const content =
      "- one\n\n- two\n\n  continued\n\n1. first\n\n2. second\n\n> quote\n\n> more\n\nDone.\n\nTail"

    expect(splitStreamingMarkdown(content)).toEqual({
      blocks: [
        "- one\n\n- two\n\n  continued\n\n1. first\n\n2. second\n\n> quote\n\n> more\n\n",
      ],
      tail: "Done.\n\nTail",
    })
  })

  it("does not split replies that use reference definitions", () => {
    const content = "See [docs][d].\n\nMore text.\n\n[d]: https://example.com\n"

    expect(splitStreamingMarkdown(content)).toEqual({
      blocks: [],
      tail: content,
    })
  })
})
