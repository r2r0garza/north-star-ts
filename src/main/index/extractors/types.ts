// Stage 3 extraction (plan 008 → built in 014). An Extractor turns one file's
// text into structured symbols (and, later, text chunks for embeddings). The
// registry dispatches each file to the first extractor that supports() it, so
// adding a language/format is additive — a new extractor + a registry entry, no
// IndexService change. Deterministic: AST/parse only, never a model call.

// A file symbol or import surfaced from a file, persisted to index_symbols.
export interface ExtractedSymbol {
  name: string
  // 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'export' |
  // 'import' | 'method' | ... (open string; the query tool filters on it).
  kind: string
  // 1-based line where the symbol is declared, when known.
  line?: number
  // Extra structured detail (JSON): for an import, the source module; for a
  // function, its signature; etc. Kept small.
  detail?: Record<string, unknown>
}

// A text span for later embedding/semantic search (Stage 4). Computed now by the
// fallback extractor but NOT persisted in this slice (no chunk table yet).
export interface ExtractedChunk {
  text: string
  startLine: number
  endLine: number
}

export interface ExtractedDocument {
  symbols: ExtractedSymbol[]
  chunks?: ExtractedChunk[]
}

// What an extractor sees. `relPath`/`ext` drive supports(); `content` is the
// file's decoded text (the caller has already filtered out binaries).
export interface ExtractableFile {
  relPath: string
  ext: string
  content: string
}

export interface Extractor {
  // Whether this extractor claims the file (by extension / sniffed type). The
  // registry tries extractors in order; first match wins.
  supports(file: { relPath: string; ext: string }): boolean
  // Parse the file into structured output. Must be deterministic and must not
  // throw on malformed input — return an empty document instead.
  extract(file: ExtractableFile): ExtractedDocument
}
