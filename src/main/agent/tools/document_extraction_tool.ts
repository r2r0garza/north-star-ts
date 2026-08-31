import { open as hostOpen, stat as hostStat } from "fs/promises"
import { basename, extname } from "path"
import AdmZip from "adm-zip"
import { LocalEnvironment } from "../env/local"
import type { Environment, StatInfo } from "../env/types"
import { renderMetadata, toolError, truncateUtf8Text } from "./output"
import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"
import { isSkillResourceUri, resolveSkillResourcePath } from "./skill_resources"

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
const MAX_ZIP_ENTRIES = 512
const MAX_ZIP_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_ZIP_TOTAL_BYTES = 32 * 1024 * 1024
const DEFAULT_BLOCK_LIMIT = 80
const MAX_BLOCK_LIMIT = 200
const MAX_RESULT_BYTES = 192 * 1024
const MAX_CELL_TEXT_BYTES = 4096
const MAX_NOTEBOOK_OUTPUT_BYTES = 16 * 1024

type DocumentKind = "pdf" | "docx" | "xlsx" | "pptx" | "ipynb" | "image"

export interface ExtractedBlock {
  kind: "paragraph" | "table" | "cell" | "slide" | "page" | "code" | "metadata"
  text: string
  location: { page?: number; sheet?: string; cell?: string; slide?: number }
  rows?: string[][]
  formula?: string
  value?: string
}

interface ExtractedDocument {
  type: DocumentKind
  metadata: Record<string, unknown>
  blocks: ExtractedBlock[]
  warnings: string[]
}

type Readable =
  | { source: "env"; path: string }
  | { source: "host"; path: string }

interface ReadFilter {
  page?: number
  sheet?: string
  slide?: number
  index: number
}

export function supportedDocumentKind(path: string): DocumentKind | null {
  const lower = path.toLowerCase()
  const ext = extname(lower)
  if (ext === ".pdf") return "pdf"
  if (ext === ".docx") return "docx"
  if (ext === ".xlsx") return "xlsx"
  if (ext === ".pptx") return "pptx"
  if (ext === ".ipynb") return "ipynb"
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image"
  return null
}

async function resolveReadable(
  ctx: ToolContext,
  env: Environment,
  path: string
): Promise<Readable> {
  if (isSkillResourceUri(path)) {
    return { source: "host", path: await resolveSkillResourcePath(ctx, path) }
  }
  if (ctx.workspace) {
    return { source: "env", path: await env.resolve(path) }
  }
  const attachments = ctx.attachments ?? []
  const match = attachments.find((a) => a === path || basename(a) === path)
  if (!match) {
    throw new Error(
      `"${path}" is not an attached file. Readable files: ${
        attachments.map((a) => basename(a)).join(", ") || "(none)"
      }.`
    )
  }
  return { source: "host", path: match }
}

async function readAllBytes(
  readable: Readable,
  env: Environment,
  statInfo: StatInfo
): Promise<Buffer> {
  if (statInfo.size > MAX_DOCUMENT_BYTES) {
    throw new Error(
      `Document is ${statInfo.size} bytes; maximum is ${MAX_DOCUMENT_BYTES}.`
    )
  }
  if (readable.source === "env") return env.readFile(readable.path)
  const handle = await hostOpen(readable.path, "r")
  try {
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

function stripTags(xml: string): string {
  return decodeXml(xml.replace(/<[^>]*>/g, ""))
}

function attr(xml: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`\\b${escaped}="([^"]*)"`, "i").exec(xml)
  return match ? decodeXml(match[1]) : undefined
}

function truncateCellText(text: string): string {
  const truncated = truncateUtf8Text(text, MAX_CELL_TEXT_BYTES)
  return truncated.truncated ? `${truncated.text}\n[truncated cell text]` : text
}

function textRuns(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g")
  return [...xml.matchAll(pattern)].map((m) => stripTags(m[1]))
}

function safeZip(data: Buffer): { zip: AdmZip; warnings: string[] } {
  for (const name of rawZipEntryNames(data)) {
    if (unsafeArchiveName(name)) {
      throw new Error(`Archive entry is not safe to read: ${name}`)
    }
  }
  const zip = new AdmZip(data)
  const entries = zip.getEntries()
  const warnings: string[] = []
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(
      `Archive has ${entries.length} entries; maximum is ${MAX_ZIP_ENTRIES}.`
    )
  }

  let total = 0
  for (const entry of entries) {
    const name = entry.entryName
    if (unsafeArchiveName(name)) {
      throw new Error(`Archive entry is not safe to read: ${name}`)
    }
    const size = entry.header.size
    total += size
    if (size > MAX_ZIP_ENTRY_BYTES) {
      throw new Error(
        `Archive entry ${name} is ${size} bytes; maximum is ${MAX_ZIP_ENTRY_BYTES}.`
      )
    }
    if (total > MAX_ZIP_TOTAL_BYTES) {
      throw new Error(
        `Archive expands past ${MAX_ZIP_TOTAL_BYTES} bytes and was refused.`
      )
    }
    if (
      /(^|\/)(vbaProject\.bin|embeddings\/|oleObject|externalLinks\/)/i.test(
        name
      )
    ) {
      warnings.push(`Skipped executable or linked document payload: ${name}`)
    }
  }
  return { zip, warnings }
}

function unsafeArchiveName(name: string): boolean {
  return (
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    name.split(/[\\/]/).includes("..")
  )
}

function rawZipEntryNames(data: Buffer): string[] {
  const names: string[] = []
  let offset = 0
  while (offset + 30 <= data.length) {
    if (data.readUInt32LE(offset) !== 0x04034b50) {
      offset += 1
      continue
    }
    const compressedSize = data.readUInt32LE(offset + 18)
    const nameLength = data.readUInt16LE(offset + 26)
    const extraLength = data.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const nameEnd = nameStart + nameLength
    if (nameEnd > data.length) break
    names.push(data.subarray(nameStart, nameEnd).toString("utf8"))
    const next = nameEnd + extraLength + compressedSize
    if (next <= offset) break
    offset = next
  }
  return names
}

function zipText(zip: AdmZip, name: string): string | null {
  const entry = zip.getEntry(name)
  if (!entry || entry.isDirectory) return null
  return entry.getData().toString("utf8")
}

function coreMetadata(zip: AdmZip): Record<string, unknown> {
  const xml = zipText(zip, "docProps/core.xml")
  if (!xml) return {}
  const out: Record<string, unknown> = {}
  for (const [key, tag] of [
    ["title", "dc:title"],
    ["subject", "dc:subject"],
    ["creator", "dc:creator"],
    ["created", "dcterms:created"],
    ["modified", "dcterms:modified"],
  ]) {
    const value = textRuns(xml, tag)[0]?.trim()
    if (value) out[key] = value
  }
  return out
}

function extractDocx(data: Buffer): ExtractedDocument {
  const { zip, warnings } = safeZip(data)
  const xml = zipText(zip, "word/document.xml")
  if (!xml) throw new Error("DOCX is missing word/document.xml.")
  const blocks: ExtractedBlock[] = []
  let paragraph = 0

  for (const m of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const text = textRuns(m[0], "w:t").join("").trim()
    if (text) {
      paragraph += 1
      blocks.push({ kind: "paragraph", text, location: { page: paragraph } })
    }
  }

  let tableIndex = 0
  for (const table of xml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)) {
    const rows = [...table[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((r) =>
      [...r[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) =>
        textRuns(c[0], "w:t").join("").trim()
      )
    )
    if (rows.length) {
      tableIndex += 1
      blocks.push({
        kind: "table",
        text: rows.map((row) => row.join(" | ")).join("\n"),
        rows,
        location: { page: tableIndex },
      })
    }
  }

  return {
    type: "docx",
    metadata: {
      ...coreMetadata(zip),
      paragraphs: paragraph,
      tables: tableIndex,
    },
    blocks,
    warnings,
  }
}

function relationshipTargets(xml: string): Map<string, string> {
  const rels = new Map<string, string>()
  for (const m of xml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = attr(m[0], "Id")
    const target = attr(m[0], "Target")
    if (id && target) rels.set(id, target)
  }
  return rels
}

function sharedStrings(zip: AdmZip): string[] {
  const xml = zipText(zip, "xl/sharedStrings.xml")
  if (!xml) return []
  return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((m) =>
    textRuns(m[0], "t").join("")
  )
}

function extractXlsx(data: Buffer): ExtractedDocument {
  const { zip, warnings } = safeZip(data)
  const workbook = zipText(zip, "xl/workbook.xml")
  if (!workbook) throw new Error("XLSX is missing xl/workbook.xml.")
  const rels = relationshipTargets(
    zipText(zip, "xl/_rels/workbook.xml.rels") ?? ""
  )
  const strings = sharedStrings(zip)
  const blocks: ExtractedBlock[] = []
  const sheets: string[] = []

  for (const sheet of workbook.matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = attr(sheet[0], "name") ?? "Sheet"
    const rid = attr(sheet[0], "r:id")
    const target = rid ? rels.get(rid) : undefined
    const normalized = target
      ? `xl/${target.replace(/^\/?xl\//, "").replace(/^\//, "")}`
      : undefined
    const xml = normalized ? zipText(zip, normalized) : null
    if (!xml) {
      warnings.push(`Skipped sheet ${name}: worksheet XML was not found.`)
      continue
    }
    sheets.push(name)
    for (const cell of xml.matchAll(/<c\b[^>]*>[\s\S]*?<\/c>/g)) {
      const tag = cell[0]
      const ref = attr(tag, "r")
      if (!ref) continue
      const type = attr(tag, "t")
      const formula = textRuns(tag, "f")[0]
      const raw = textRuns(tag, "v")[0] ?? textRuns(tag, "t")[0] ?? ""
      const value =
        type === "s" ? (strings[Number.parseInt(raw, 10)] ?? raw) : raw
      const text = [
        formula ? `formula: ${formula}` : "",
        value ? `value: ${value}` : "",
      ]
        .filter(Boolean)
        .join("; ")
      if (text) {
        blocks.push({
          kind: "cell",
          text: truncateCellText(text),
          location: { sheet: name, cell: ref },
          formula,
          value,
        })
      }
    }
  }

  return {
    type: "xlsx",
    metadata: { ...coreMetadata(zip), sheets },
    blocks,
    warnings,
  }
}

function slideNumber(name: string): number {
  return Number.parseInt(/slide(\d+)\.xml$/i.exec(name)?.[1] ?? "0", 10)
}

function extractPptx(data: Buffer): ExtractedDocument {
  const { zip, warnings } = safeZip(data)
  const slides = zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
    .sort((a, b) => slideNumber(a.entryName) - slideNumber(b.entryName))
  const blocks: ExtractedBlock[] = []
  for (const slide of slides) {
    const number = slideNumber(slide.entryName)
    const text = textRuns(slide.getData().toString("utf8"), "a:t")
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n")
    blocks.push({
      kind: "slide",
      text,
      location: { slide: number },
    })
  }
  return {
    type: "pptx",
    metadata: { ...coreMetadata(zip), slides: slides.length },
    blocks,
    warnings,
  }
}

function textFromNotebookOutput(output: unknown): string {
  if (typeof output !== "object" || output === null) return ""
  const data = output as Record<string, unknown>
  const text = data.text ?? data.data
  if (typeof text === "string") return text
  if (Array.isArray(text)) return text.map(String).join("")
  if (typeof text === "object" && text !== null) {
    const plain = (text as Record<string, unknown>)["text/plain"]
    if (typeof plain === "string") return plain
    if (Array.isArray(plain)) return plain.map(String).join("")
  }
  return ""
}

function extractIpynb(data: Buffer): ExtractedDocument {
  const parsed = JSON.parse(data.toString("utf8")) as Record<string, unknown>
  const cells = Array.isArray(parsed.cells) ? parsed.cells : []
  const blocks: ExtractedBlock[] = [
    {
      kind: "metadata",
      text: JSON.stringify(parsed.metadata ?? {}, null, 2),
      location: {},
    },
  ]
  const warnings = [
    "Notebook cells and outputs were parsed only; no code was executed.",
  ]
  cells.forEach((cell, i) => {
    if (typeof cell !== "object" || cell === null) return
    const data = cell as Record<string, unknown>
    const source = Array.isArray(data.source)
      ? data.source.map(String).join("")
      : typeof data.source === "string"
        ? data.source
        : ""
    blocks.push({
      kind: data.cell_type === "code" ? "code" : "paragraph",
      text: source,
      location: { page: i + 1 },
    })
    const outputs = Array.isArray(data.outputs) ? data.outputs : []
    outputs.forEach((output, outputIndex) => {
      const text = textFromNotebookOutput(output)
      if (!text) return
      const capped = truncateUtf8Text(text, MAX_NOTEBOOK_OUTPUT_BYTES)
      blocks.push({
        kind: "metadata",
        text: `output ${outputIndex + 1}: ${
          capped.truncated ? `${capped.text}\n[truncated output]` : text
        }`,
        location: { page: i + 1 },
      })
    })
  })
  return {
    type: "ipynb",
    metadata: {
      nbformat: parsed.nbformat,
      nbformat_minor: parsed.nbformat_minor,
      cells: cells.length,
    },
    blocks,
    warnings,
  }
}

function pdfString(raw: string): string {
  return raw.replace(/\\([nrtbf()\\])/g, (_, ch: string) => {
    switch (ch) {
      case "n":
        return "\n"
      case "r":
        return "\r"
      case "t":
        return "\t"
      case "b":
        return "\b"
      case "f":
        return "\f"
      default:
        return ch
    }
  })
}

function extractPdf(data: Buffer): ExtractedDocument {
  const text = data.toString("latin1")
  const blocks: ExtractedBlock[] = []
  const pageCount = [...text.matchAll(/\/Type\s*\/Page\b/g)].length
  const metadata: Record<string, unknown> = { pages: pageCount || undefined }
  for (const key of ["Title", "Author", "Subject", "Creator", "Producer"]) {
    const value = new RegExp(`/${key}\\s*\\(([^)]*)\\)`).exec(text)?.[1]
    if (value) metadata[key.toLowerCase()] = pdfString(value)
  }
  const strings = [...text.matchAll(/\(([^()]*)\)\s*T[Jj]/g)].map((m) =>
    pdfString(m[1]).trim()
  )
  const combined = strings.filter(Boolean).join("\n")
  if (combined) {
    blocks.push({ kind: "page", text: combined, location: { page: 1 } })
  }
  return {
    type: "pdf",
    metadata,
    blocks,
    warnings: [
      "PDF v1 extraction reads metadata and simple uncompressed text operators only; complex layout, compressed streams, and encrypted PDFs may be partial.",
    ],
  }
}

function imageMetadata(data: Buffer, path: string): Record<string, unknown> {
  const ext = extname(path).toLowerCase()
  if (
    ext === ".png" &&
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return {
      format: "png",
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    }
  }
  if (
    ext === ".gif" &&
    data.length >= 10 &&
    data.subarray(0, 3).toString() === "GIF"
  ) {
    return {
      format: "gif",
      width: data.readUInt16LE(6),
      height: data.readUInt16LE(8),
    }
  }
  if ([".jpg", ".jpeg"].includes(ext) && data.length > 4) {
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) break
      const marker = data[offset + 1]
      const size = data.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          format: "jpeg",
          width: data.readUInt16BE(offset + 7),
          height: data.readUInt16BE(offset + 5),
        }
      }
      offset += 2 + size
    }
    return { format: "jpeg" }
  }
  if (
    ext === ".webp" &&
    data.length >= 30 &&
    data.subarray(0, 4).toString() === "RIFF"
  ) {
    const riff = data.subarray(8, 12).toString()
    const chunk = data.subarray(12, 16).toString()
    if (riff === "WEBP" && chunk === "VP8X") {
      return {
        format: "webp",
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3),
      }
    }
    return { format: "webp" }
  }
  return { format: ext.replace(/^\./, "") || "unknown" }
}

function extractImage(data: Buffer, path: string): ExtractedDocument {
  const metadata = imageMetadata(data, path)
  return {
    type: "image",
    metadata,
    blocks: [
      {
        kind: "metadata",
        text: JSON.stringify(metadata, null, 2),
        location: {},
      },
    ],
    warnings: [
      "Image OCR and vision analysis are not part of document reading v1.",
    ],
  }
}

function extractDocument(
  data: Buffer,
  path: string,
  kind: DocumentKind
): ExtractedDocument {
  switch (kind) {
    case "docx":
      return extractDocx(data)
    case "xlsx":
      return extractXlsx(data)
    case "pptx":
      return extractPptx(data)
    case "ipynb":
      return extractIpynb(data)
    case "pdf":
      return extractPdf(data)
    case "image":
      return extractImage(data, path)
  }
}

function parseCursor(raw: unknown): ReadFilter {
  if (typeof raw !== "string" || !raw) return { index: 0 }
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    return {
      index:
        typeof parsed.index === "number" && parsed.index >= 0
          ? Math.floor(parsed.index)
          : 0,
      page: typeof parsed.page === "number" ? parsed.page : undefined,
      sheet: typeof parsed.sheet === "string" ? parsed.sheet : undefined,
      slide: typeof parsed.slide === "number" ? parsed.slide : undefined,
    }
  } catch {
    return { index: 0 }
  }
}

function encodeCursor(filter: ReadFilter): string {
  return Buffer.from(JSON.stringify(filter), "utf8").toString("base64url")
}

function blockMatches(block: ExtractedBlock, filter: ReadFilter): boolean {
  if (filter.page != null && block.location.page !== filter.page) return false
  if (filter.sheet && block.location.sheet !== filter.sheet) return false
  if (filter.slide != null && block.location.slide !== filter.slide)
    return false
  return true
}

function renderBlock(block: ExtractedBlock): string {
  const where = Object.entries(block.location)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")
  const title = `[${block.kind}${where ? ` ${where}` : ""}]`
  if (block.kind === "table" && block.rows) {
    return `${title}\n${block.rows.map((row) => row.join(" | ")).join("\n")}`
  }
  return `${title}\n${block.text}`
}

export const readDocumentTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  definition: {
    type: "function",
    function: {
      name: "read_document",
      description:
        "Read a bounded, provenance-preserving view of PDF, DOCX, XLSX, PPTX, IPYNB, or basic image metadata. " +
        "Does not execute macros, formulas, notebook cells, embedded objects, or network links.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Document path. In a workspace, relative to the workspace root " +
              "or an activated skill resource URI like skill://name/path. " +
              "In Chat, the name or path of an attached file.",
          },
          cursor: {
            type: "string",
            description:
              "Continuation cursor returned by a previous read_document call.",
          },
          page: { type: "integer", description: "Restrict blocks to a page." },
          sheet: { type: "string", description: "Restrict blocks to a sheet." },
          slide: {
            type: "integer",
            description: "Restrict blocks to a slide.",
          },
          limit: {
            type: "integer",
            description:
              "Maximum blocks to return. Defaults to 80; maximum 200.",
          },
          include_metadata: {
            type: "boolean",
            description: "Include document metadata in the rendered response.",
          },
        },
        required: ["path"],
      },
    },
  },
  execute: async (args, ctx) => {
    const path = typeof args.path === "string" ? args.path : ""
    if (!path) return toolError("bad_args", "A `path` is required.")
    const kind = supportedDocumentKind(path)
    if (!kind) {
      return toolError(
        "unsupported_document",
        `Unsupported document type for ${path}.`,
        "Supported types: PDF, DOCX, XLSX, PPTX, IPYNB, PNG, JPEG, GIF, WEBP."
      )
    }

    const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
    let readable: Readable
    try {
      readable = await resolveReadable(ctx, env, path)
    } catch (error) {
      return toolError("not_allowed", (error as Error).message)
    }

    const statAt = (p: string): Promise<StatInfo> =>
      readable.source === "env" ? env.stat(p) : hostStat(p)
    let info: StatInfo
    try {
      info = await statAt(readable.path)
    } catch {
      return toolError("not_found", `No such file: ${path}`)
    }
    if (!info.isFile()) {
      return toolError("not_a_file", `Not a regular file: ${path}`)
    }

    let data: Buffer
    try {
      data = await readAllBytes(readable, env, info)
    } catch (error) {
      return toolError(
        "read_failed",
        `Could not read ${path}: ${(error as Error).message}`
      )
    }

    let doc: ExtractedDocument
    try {
      doc = extractDocument(data, path, kind)
    } catch (error) {
      return toolError(
        "extract_failed",
        `Could not extract ${path}: ${(error as Error).message}`
      )
    }

    const cursorFilter = parseCursor(args.cursor)
    const filter: ReadFilter = {
      index: cursorFilter.index,
      page:
        typeof args.page === "number" && args.page > 0
          ? Math.floor(args.page)
          : cursorFilter.page,
      sheet: typeof args.sheet === "string" ? args.sheet : cursorFilter.sheet,
      slide:
        typeof args.slide === "number" && args.slide > 0
          ? Math.floor(args.slide)
          : cursorFilter.slide,
    }
    const requestedLimit =
      typeof args.limit === "number" && args.limit > 0
        ? Math.floor(args.limit)
        : DEFAULT_BLOCK_LIMIT
    const limit = Math.min(requestedLimit, MAX_BLOCK_LIMIT)
    const matched = doc.blocks.filter((block) => blockMatches(block, filter))
    const pageBlocks = matched.slice(filter.index, filter.index + limit)
    const nextIndex = filter.index + pageBlocks.length
    const hasMore = nextIndex < matched.length
    const nextCursor = hasMore
      ? encodeCursor({ ...filter, index: nextIndex })
      : undefined

    const parts = [
      `Document: ${path}`,
      typeof args.include_metadata === "boolean" && args.include_metadata
        ? `[document_metadata]\n${JSON.stringify(doc.metadata, null, 2)}`
        : "",
      pageBlocks.map(renderBlock).join("\n\n"),
    ].filter(Boolean)
    const rendered = parts.join("\n\n")
    const capped = truncateUtf8Text(rendered, MAX_RESULT_BYTES)
    const finalText = capped.truncated
      ? `${capped.text}\n[truncated: result capped at ${MAX_RESULT_BYTES} bytes; use cursor or narrower page/sheet/slide filters]`
      : rendered

    return `${finalText}\n${renderMetadata({
      type: doc.type,
      fileBytes: info.size,
      blockStart: filter.index,
      blocksReturned: pageBlocks.length,
      totalMatchingBlocks: matched.length,
      hasMore,
      nextCursor,
      warnings: doc.warnings,
      outputTruncated: capped.truncated,
      limitCapped: requestedLimit !== limit || undefined,
    })}`
  },
}
