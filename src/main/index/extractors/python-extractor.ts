import type {
  Extractor,
  ExtractableFile,
  ExtractedDocument,
  ExtractedSymbol,
} from "./types"

const PY_EXTS = new Set([".py", ".pyi"])

// Extracts a Python file's structural shape line by line: top-level classes
// and functions, methods (with their class), UPPER_CASE module constants, and
// imports tagged with their module so "what imports X" works. Indentation
// tracks nesting, so local functions and classes inside a function body are
// skipped, as the TS extractor skips locals. No Python runtime, deterministic,
// and it never throws: odd input just yields fewer symbols.
export const pythonExtractor: Extractor = {
  supports: (file) => PY_EXTS.has(file.ext),

  extract: (file: ExtractableFile): ExtractedDocument => {
    try {
      return { symbols: extractPython(file.content) }
    } catch {
      return { symbols: [] }
    }
  },
}

const DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/
const CLASS = /^(\s*)class\s+([A-Za-z_]\w*)/
const CONST = /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=)/
const IMPORT = /^\s*import\s+(.+)$/
const FROM_IMPORT = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)$/

interface Block {
  kind: "class" | "def"
  name: string
  indent: number
}

function extractPython(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []
  const lines = content.split("\n")
  const stack: Block[] = []
  let docstring: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = i + 1

    // Inside a triple-quoted string: skip until it closes.
    if (docstring) {
      if (raw.includes(docstring)) docstring = null
      continue
    }
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const opener = trimmed.match(/^[rRbBuUfF]*("""|''')/)?.[1]
    if (opener) {
      const rest = trimmed.slice(trimmed.indexOf(opener) + 3)
      if (!rest.includes(opener)) docstring = opener
      continue
    }

    const indent = raw.length - raw.trimStart().length
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack[stack.length - 1]
    const insideFunction = stack.some((block) => block.kind === "def")

    const cls = CLASS.exec(raw)
    if (cls) {
      if (!insideFunction)
        symbols.push({
          name: cls[2],
          kind: "class",
          line,
          detail: {
            exported: !cls[2].startsWith("_"),
            ...(parent ? { class: parent.name } : {}),
          },
        })
      stack.push({ kind: "class", name: cls[2], indent })
      continue
    }

    const fn = DEF.exec(raw)
    if (fn) {
      if (!parent)
        symbols.push({
          name: fn[2],
          kind: "function",
          line,
          detail: { exported: !fn[2].startsWith("_") },
        })
      else if (parent.kind === "class" && !insideFunction)
        symbols.push({
          name: fn[2],
          kind: "method",
          line,
          detail: { class: parent.name },
        })
      stack.push({ kind: "def", name: fn[2], indent })
      continue
    }

    if (indent === 0) {
      const constant = CONST.exec(raw)
      if (constant) {
        symbols.push({
          name: constant[1],
          kind: "const",
          line,
          detail: { exported: true },
        })
        continue
      }
    }

    // Imports anywhere outside a function body (module level, or inside a
    // module-level try/if block).
    if (insideFunction) continue
    const fromImport = FROM_IMPORT.exec(raw)
    if (fromImport) {
      const module = fromImport[1]
      let names = fromImport[2]
      // A parenthesized list may span lines: `from x import (\n a,\n b,\n)`.
      if (names.trimStart().startsWith("(")) {
        while (!names.includes(")") && i + 1 < lines.length)
          names += ` ${lines[++i]}`
      } else {
        while (names.trimEnd().endsWith("\\") && i + 1 < lines.length)
          names = `${names.trimEnd().slice(0, -1)} ${lines[++i]}`
      }
      for (const name of importNames(names))
        symbols.push({ name, kind: "import", line, detail: { module } })
      continue
    }
    const plainImport = IMPORT.exec(raw)
    if (plainImport) {
      for (const part of stripComment(plainImport[1]).split(",")) {
        const [module, alias] = part.trim().split(/\s+as\s+/)
        if (!module) continue
        symbols.push({
          name: alias?.trim() || module,
          kind: "import",
          line,
          detail: { module },
        })
      }
    }
  }
  return symbols
}

function stripComment(text: string): string {
  const hash = text.indexOf("#")
  return hash >= 0 ? text.slice(0, hash) : text
}

// The bound names of `a, b as c` / `(a,\n b)` / `*`.
function importNames(list: string): string[] {
  return list
    .split("\n")
    .map(stripComment)
    .join(" ")
    .replace(/[()\\]/g, " ")
    .split(",")
    .map((part) =>
      part
        .trim()
        .split(/\s+as\s+/)
        .pop()!
        .trim()
    )
    .filter(Boolean)
}
