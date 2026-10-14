// Splits streaming Markdown into finished top-level blocks plus the tail that
// is still being written. Finished blocks never change as more text arrives,
// so the renderer can parse each one once and re-parse only the tail; without
// this, every update re-parses the whole reply and the cost grows with the
// square of its length.
//
// A boundary is a blank line followed by a complete line that starts a new
// block: not inside a fence, not indented, not a list item or blockquote (those
// can continue the previous block). The settled render parses the whole reply,
// so any approximation here only lasts while the reply streams.

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const CONTINUES_BLOCK = /^(?:[ \t]|[-*+][ \t]|\d{1,9}[.)][ \t]|>)/
// Reference definitions and footnotes resolve across the whole document, so a
// reply that uses them is not split.
const CROSS_BLOCK_REFERENCE = /^ {0,3}\[[^\]]+\]:/m

export interface StreamingMarkdownParts {
  blocks: string[]
  tail: string
}

export function splitStreamingMarkdown(
  content: string
): StreamingMarkdownParts {
  if (CROSS_BLOCK_REFERENCE.test(content)) return { blocks: [], tail: content }

  const blocks: string[] = []
  let start = 0
  let pos = 0
  let fence: string | null = null
  let afterBlank = false

  while (pos < content.length) {
    const end = content.indexOf("\n", pos)
    // The last line is still arriving; it can't confirm a boundary yet.
    if (end === -1) break
    const line = content.slice(pos, end)

    if (fence) {
      const close = FENCE_CLOSE.exec(line)
      if (
        close &&
        close[1][0] === fence[0] &&
        close[1].length >= fence.length
      ) {
        fence = null
      }
    } else if (line.trim() === "") {
      afterBlank = true
    } else {
      if (afterBlank && pos > start && !CONTINUES_BLOCK.test(line)) {
        blocks.push(content.slice(start, pos))
        start = pos
      }
      afterBlank = false
      fence = FENCE_OPEN.exec(line)?.[1] ?? null
    }
    pos = end + 1
  }

  return { blocks, tail: content.slice(start) }
}
