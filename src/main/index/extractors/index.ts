import type { Extractor } from "./types"
import { typeScriptExtractor } from "./typescript-extractor"
import { fallbackExtractor } from "./fallback-extractor"

// Ordered extractor registry (plan 008 Stage 3). First supports() match wins;
// fallbackExtractor claims everything the specific ones didn't, so every
// non-binary file gets some representation. Add a language/format by importing a
// new extractor and inserting it BEFORE the fallback.
const REGISTRY: Extractor[] = [typeScriptExtractor, fallbackExtractor]

// Pick the extractor for a file (always resolves — fallback is the catch-all).
export function pickExtractor(file: { relPath: string; ext: string }): Extractor {
  for (const ex of REGISTRY) {
    if (ex.supports(file)) return ex
  }
  return fallbackExtractor
}

export type { Extractor, ExtractedDocument, ExtractedSymbol, ExtractableFile } from "./types"
