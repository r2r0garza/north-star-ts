import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import AdmZip from "adm-zip"
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

  it("extracts simple PDF metadata and uncompressed text operators", async () => {
    await writeFile(
      join(workspace, "note.pdf"),
      Buffer.from(
        "%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Title (Hello PDF) >> endobj\nstream\n(Visible text) Tj\nendstream\n%%EOF",
        "latin1"
      )
    )

    const result = await readDocumentTool.execute(
      { path: "note.pdf", include_metadata: true },
      { workspace }
    )

    expect(result).toContain('"title": "Hello PDF"')
    expect(result).toContain("[page page=1]\nVisible text")
    expect(result).toContain("PDF v1 extraction")
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
