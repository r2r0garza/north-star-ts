import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { deflateSync } from "zlib"
import AdmZip from "adm-zip"

// Page images are encoded through Electron's nativeImage, which doesn't exist
// under vitest. The stub records what it was handed so the decode → BGRA → JPEG
// → emitImage path can be asserted without a real encoder.
const encodedBitmaps: Array<{ width: number; height: number; bytes: number }> =
  []
vi.mock("electron", () => ({
  nativeImage: {
    createFromBitmap: (
      buffer: Buffer,
      { width, height }: { width: number; height: number }
    ) => {
      encodedBitmaps.push({ width, height, bytes: buffer.length })
      const handle = {
        resize: () => handle,
        toJPEG: () => Buffer.from("stub-jpeg-bytes"),
      }
      return handle
    },
  },
}))

import { readDocumentTool } from "./document_extraction_tool"

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "document-extraction-tool-"))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

function zip(entries: Record<string, string | Buffer>): Buffer {
  const archive = new AdmZip()
  for (const [name, data] of Object.entries(entries)) {
    archive.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data))
  }
  return archive.toBuffer()
}

// Assembles a structurally valid PDF: real objects and an xref table with real
// byte offsets. A parser that actually parses (rather than regexing raw bytes)
// requires this, so the fixtures double as a guard against regressing to one.
function buildPdf(objects: string[], trailer: Record<string, string> = {}) {
  const header = "%PDF-1.4\n"
  const offsets: number[] = [0]
  let body = ""
  for (const [index, object] of objects.entries()) {
    offsets.push(header.length + body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const startxref = header.length + body.length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`
  }
  const extra = Object.entries(trailer)
    .map(([key, value]) => `/${key} ${value}`)
    .join(" ")
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${extra} >>\nstartxref\n${startxref}\n%%EOF\n`
  return Buffer.from(header + body + xref, "latin1")
}

function pdfStream(dict: string, data: Buffer) {
  return `<< ${dict} /Length ${data.length} >>\nstream\n${data.toString("latin1")}\nendstream`
}

function textPdf() {
  return buildPdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      pdfStream(
        "",
        Buffer.from("BT /F1 24 Tf 72 700 Td (Visible text) Tj ET\n", "latin1")
      ),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Title (Hello PDF) /Author (Test Suite) >>",
    ],
    { Info: "6 0 R" }
  )
}

// One page that paints a single image and shows no text — the shape of a scan or
// a slide deck exported to PDF.
function imageOnlyPdf(width = 8, height = 8) {
  const rgb = Buffer.alloc(width * height * 3, 40)
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    pdfStream("", Buffer.from("q 612 0 0 792 0 0 cm /Im1 Do Q\n", "latin1")),
    pdfStream(
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
      deflateSync(rgb)
    ),
  ])
}

function metadata(result: string): Record<string, unknown> {
  const line = result
    .split("\n")
    .find((entry) => entry.startsWith("[metadata] "))
  if (!line) throw new Error("missing metadata")
  return JSON.parse(line.slice("[metadata] ".length)) as Record<string, unknown>
}

describe("read_document", () => {
  it("extracts DOCX paragraphs and tables with provenance", async () => {
    await writeFile(
      join(workspace, "sample.docx"),
      zip({
        "word/document.xml": `
          <w:document>
            <w:body>
              <w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t> world</w:t></w:r></w:p>
              <w:tbl>
                <w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
                <w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>
              </w:tbl>
            </w:body>
          </w:document>`,
        "docProps/core.xml":
          "<cp:coreProperties><dc:title>Doc title</dc:title></cp:coreProperties>",
      })
    )

    const result = await readDocumentTool.execute(
      { path: "sample.docx", include_metadata: true },
      { workspace }
    )

    expect(result).toContain("Document: sample.docx")
    expect(result).toContain("[document_metadata]")
    expect(result).toContain('"title": "Doc title"')
    expect(result).toContain("[paragraph page=1]\nHello world")
    expect(result).toContain("[table page=1]\nA1 | B1\nA2 | B2")
    expect(metadata(result)).toMatchObject({
      type: "docx",
      hasMore: false,
    })
  })

  it("extracts XLSX formula and cached values without executing formulas", async () => {
    await writeFile(
      join(workspace, "book.xlsx"),
      zip({
        "xl/workbook.xml": `
          <workbook><sheets>
            <sheet name="Budget" sheetId="1" r:id="rId1"/>
          </sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `
          <Relationships>
            <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
          </Relationships>`,
        "xl/sharedStrings.xml": "<sst><si><t>Revenue</t></si></sst>",
        "xl/worksheets/sheet1.xml": `
          <worksheet><sheetData><row r="1">
            <c r="A1" t="s"><v>0</v></c>
            <c r="B1"><f>SUM(1,2)</f><v>3</v></c>
          </row></sheetData></worksheet>`,
      })
    )

    const result = await readDocumentTool.execute(
      { path: "book.xlsx", sheet: "Budget" },
      { workspace }
    )

    expect(result).toContain("[cell sheet=Budget cell=A1]\nvalue: Revenue")
    expect(result).toContain(
      "[cell sheet=Budget cell=B1]\nformula: SUM(1,2); value: 3"
    )
    expect(result).not.toContain("ERROR")
  })

  it("extracts PPTX slide text and supports slide filtering", async () => {
    await writeFile(
      join(workspace, "deck.pptx"),
      zip({
        "ppt/slides/slide1.xml": "<p:sld><a:t>Intro</a:t></p:sld>",
        "ppt/slides/slide2.xml": "<p:sld><a:t>Decision</a:t></p:sld>",
      })
    )

    const result = await readDocumentTool.execute(
      { path: "deck.pptx", slide: 2 },
      { workspace }
    )

    expect(result).toContain("[slide slide=2]\nDecision")
    expect(result).not.toContain("Intro")
  })

  it("extracts notebooks without executing code and paginates blocks", async () => {
    await writeFile(
      join(workspace, "analysis.ipynb"),
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: { kernelspec: { name: "python3" } },
        cells: [
          { cell_type: "markdown", source: ["# Heading"] },
          {
            cell_type: "code",
            source: ["print('x')"],
            outputs: [{ text: ["x\n"] }],
          },
        ],
      })
    )

    const first = await readDocumentTool.execute(
      { path: "analysis.ipynb", limit: 2 },
      { workspace }
    )
    const firstMeta = metadata(first)
    const next = await readDocumentTool.execute(
      { path: "analysis.ipynb", cursor: String(firstMeta.nextCursor) },
      { workspace }
    )

    expect(first).toContain("[metadata]")
    expect(first).toContain("[paragraph page=1]\n# Heading")
    expect(first).toContain('"hasMore":true')
    expect(next).toContain("[code page=2]\nprint('x')")
    expect(next).toContain("output 1: x")
  })

  it("extracts PDF text and metadata per page", async () => {
    await writeFile(join(workspace, "note.pdf"), textPdf())

    const result = await readDocumentTool.execute(
      { path: "note.pdf", include_metadata: true },
      { workspace }
    )

    expect(result).toContain('"title": "Hello PDF"')
    expect(result).toContain('"author": "Test Suite"')
    expect(result).toContain("[page page=1]\nVisible text")
    expect(metadata(result)).toMatchObject({ type: "pdf", warnings: [] })
  })

  it("never emits bytes that are not text from a PDF", async () => {
    // The page draws an image and shows no text. Scanning the file's raw bytes
    // (the old behavior) matched compressed image data as if it were a text
    // operator and reported the binary as page content.
    await writeFile(join(workspace, "scan.pdf"), imageOnlyPdf())

    const result = await readDocumentTool.execute(
      { path: "scan.pdf" },
      { workspace }
    )

    expect(result).toContain("[page page=1]")
    expect(result).toContain("no text layer")
    // No control bytes: real text may be any Unicode, but decoded image data
    // reaching the model as "text" always shows up as control characters.
    const body = result.slice(0, result.indexOf("[metadata]"))
    expect(body).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/)
  })

  it("sends a page with no text layer to the vision model as an image", async () => {
    encodedBitmaps.length = 0
    await writeFile(join(workspace, "scan.pdf"), imageOnlyPdf())
    const images: Array<{ jpegBase64: string; alt: string }> = []

    const result = await readDocumentTool.execute(
      { path: "scan.pdf" },
      { workspace, emitImage: (image) => images.push(image) }
    )

    expect(images).toHaveLength(1)
    expect(images[0].alt).toBe("scan.pdf — page 1")
    expect(Buffer.from(images[0].jpegBase64, "base64").toString()).toBe(
      "stub-jpeg-bytes"
    )
    // The decoded page reached the encoder as a full BGRA bitmap.
    expect(encodedBitmaps).toEqual([{ width: 8, height: 8, bytes: 8 * 8 * 4 }])
    expect(metadata(result)).toMatchObject({ pageImagesSent: 1 })
    expect(String(metadata(result).warnings)).toContain("no text layer")
  })

  it("reads a PDF without images when the caller cannot show them", async () => {
    await writeFile(join(workspace, "scan.pdf"), imageOnlyPdf())

    // No emitImage (a headless caller): the read still succeeds, and the result
    // says outright that a page was not shown rather than implying it was empty.
    const result = await readDocumentTool.execute(
      { path: "scan.pdf" },
      { workspace }
    )

    expect(metadata(result)).toMatchObject({
      pageImagesSent: 0,
      pageImagesWithheld: 1,
    })
  })

  it("rejects a malformed PDF instead of inventing content", async () => {
    await writeFile(
      join(workspace, "broken.pdf"),
      Buffer.from("%PDF-1.4\nnot actually a pdf\n%%EOF", "latin1")
    )

    const result = await readDocumentTool.execute(
      { path: "broken.pdf" },
      { workspace }
    )

    expect(result).toContain("ERROR[extract_failed]")
  })

  it("extracts basic image metadata only", async () => {
    const png = Buffer.alloc(33)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0)
    png.writeUInt32BE(13, 8)
    Buffer.from("IHDR").copy(png, 12)
    png.writeUInt32BE(640, 16)
    png.writeUInt32BE(480, 20)
    await writeFile(join(workspace, "image.png"), png)

    const result = await readDocumentTool.execute(
      { path: "image.png", include_metadata: true },
      { workspace }
    )

    expect(result).toContain('"format": "png"')
    expect(result).toContain('"width": 640')
    expect(result).toContain('"height": 480')
    expect(result).toContain("Image OCR and vision analysis")
  })

  it("rejects unsafe ZIP entries", async () => {
    const unsafe = zip({
      "aa/escape.txt": "nope",
      "word/document.xml": "<w:document/>",
    })
    Buffer.from("../escape.txt").copy(
      unsafe,
      unsafe.indexOf(Buffer.from("aa/escape.txt"))
    )
    await writeFile(join(workspace, "bad.docx"), unsafe)

    const result = await readDocumentTool.execute(
      { path: "bad.docx" },
      { workspace }
    )

    expect(result).toContain("ERROR[extract_failed]")
    expect(result).toContain("Archive entry is not safe")
  })
})
