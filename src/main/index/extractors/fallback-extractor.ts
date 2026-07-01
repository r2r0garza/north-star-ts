import type { Extractor, ExtractableFile, ExtractedDocument, ExtractedSymbol, ExtractedChunk } from "./types"

const MARKDOWN_EXTS = new Set([".md", ".mdx", ".markdown"])

// Roughly one chunk per this many lines for non-code text (used for the deferred
// embedding path; chunks aren't persisted in this slice).
const CHUNK_LINES = 40

// The catch-all extractor: claims every file the specific extractors didn't, so
// every non-binary file gets *some* representation. Markdown yields heading
// symbols (a cheap outline); everything else yields text chunks only (no
// symbols). Never throws.
export const fallbackExtractor: Extractor = {
  supports: () => true,

  extract: (file: ExtractableFile): ExtractedDocument => {
    if (MARKDOWN_EXTS.has(file.ext)) {
      return { symbols: markdownHeadings(file.content), chunks: chunkLines(file.content) }
    }
    return { symbols: [], chunks: chunkLines(file.content) }
  },
}

// ATX headings (`# Title`) → heading symbols, with the level in detail.
function markdownHeadings(content: string): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = []
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i])
    if (m) {
      out.push({
        name: m[2].trim(),
        kind: "heading",
        line: i + 1,
        detail: { level: m[1].length },
      })
    }
  }
  return out
}

// Split into fixed line-count chunks (span metadata only; the text is carried for
// the future embedding path but not persisted yet).
function chunkLines(content: string): ExtractedChunk[] {
  const lines = content.split("\n")
  const chunks: ExtractedChunk[] = []
  for (let start = 0; start < lines.length; start += CHUNK_LINES) {
    const end = Math.min(start + CHUNK_LINES, lines.length)
    chunks.push({
      text: lines.slice(start, end).join("\n"),
      startLine: start + 1,
      endLine: end,
    })
  }
  return chunks
}
