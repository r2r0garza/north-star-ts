# PR63: Universal document extraction tool

> Status: **DONE**. Implemented by `98a7f39` with bounded `read_document` extraction,
> provenance-preserving format handling, binary-read guidance, capability mapping, and
> focused document tests.

## Goal

Add `read_document(path, cursor?, sheet?, slide?, page?, include_metadata?)` for:

- PDF
- DOCX
- XLSX
- PPTX
- IPYNB
- basic image metadata, with OCR/vision treated as a separately gated adapter

## Design

Read bytes through the selected Environment, then dispatch to a main-process extractor
registry. Extractors return a common document model with source locations:

```ts
interface ExtractedBlock {
  kind: "paragraph" | "table" | "cell" | "slide" | "page" | "code" | "metadata"
  text: string
  location: { page?: number; sheet?: string; cell?: string; slide?: number }
}
```

The tool returns bounded blocks with a continuation cursor, document metadata, and
warnings for unsupported/partial features. Tables preserve rows/columns rather than
flattening everything into ambiguous prose. Formula cells include formula and cached
value when available. Notebook output is separated from source cells and capped.

## Security and packaging

- File-size, archive-entry, decompressed-size, sheet/page/slide, cell, and output caps.
- ZIP-based formats get zip-slip/zip-bomb defenses even though extraction is in-memory.
- No macros, formulas, embedded objects, external links, scripts, or notebook cells are
  executed.
- No network fetches for linked assets.
- Dependencies must be pure/packageable in Electron or explicitly unpacked/tested;
  implementation begins with a dependency/licensing/security spike and fixture corpus.
- Malformed documents fail per extractor without crashing main.

## Integration

- `read_file_tool` detects supported binary formats and recommends `read_document`
  instead of returning a UTF-8 error.
- Add a `document_read` capability for external-agent mapping; do not treat notebook
  execution as document reading.
- Skills may provide domain workflows, but basic extraction must not depend on a skill
  being installed.

## Verification

- Multi-page/sheet/slide documents, merged cells, formulas, notes, hidden sheets,
  Unicode, large tables, malformed archives, encrypted files, and truncation cursors.
- Prove zero macro/formula/notebook/embedded-object execution and zero network access.
- Local/container byte reads produce identical extraction.
- Packaged macOS/Windows/Linux builds include working extractor dependencies.

## Out of scope

- Editing documents, rendering perfect visual layout, executing notebooks, OCR by
  default, or bypassing encryption.
