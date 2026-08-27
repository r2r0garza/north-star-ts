import { describe, expect, it } from "vitest"
import { truncateForModel, truncateUtf8Text } from "./output"

const cases = [
  { name: "2-byte", char: "é", prefixBytes: 2 },
  { name: "3-byte", char: "語", prefixBytes: 2 },
  { name: "4-byte", char: "🚀", prefixBytes: 2 },
]

describe("output truncation", () => {
  it.each(cases)(
    "does not split a $name UTF-8 character without a newline",
    ({ char, prefixBytes }) => {
      const text = `ab${char}tail`
      const result = truncateUtf8Text(text, prefixBytes + 1)

      expect(result.truncated).toBe(true)
      expect(result.text).toBe("ab")
      expect(result.text).not.toContain("\ufffd")
      expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
        prefixBytes + 1
      )
    }
  )

  it.each(cases)(
    "falls back to the previous line before a split $name UTF-8 character",
    ({ char, prefixBytes }) => {
      const firstLine = "safe"
      const text = `${firstLine}\nab${char}tail`
      const cap = Buffer.byteLength(`${firstLine}\nab`, "utf8") + 1
      expect(cap).toBe(
        Buffer.byteLength(`${firstLine}\n`, "utf8") + prefixBytes + 1
      )

      const result = truncateUtf8Text(text, cap)

      expect(result.truncated).toBe(true)
      expect(result.text).toBe(firstLine)
      expect(result.text).not.toContain("\ufffd")
      expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(cap)
    }
  )

  it("keeps the generic truncation note within the byte cap", () => {
    const result = truncateForModel("語".repeat(200), {
      maxBytes: 120,
      metadata: { source: "unit", reason: "utf8-boundary" },
    })

    expect(result.truncated).toBe(true)
    expect(result.note).toContain("capped at 120 bytes")
    expect(result.text).toContain(result.note)
    expect(result.text).not.toContain("\ufffd")
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(120)
  })

  it("keeps line-count truncation notes within the byte cap", () => {
    const result = truncateForModel(["alpha", "beta", "gamma"].join("\n"), {
      maxLines: 1,
      maxBytes: 80,
      recoveryHint: "read a narrower range",
    })

    expect(result.truncated).toBe(true)
    expect(result.note).toContain("showing 1 of 3 lines")
    expect(result.text).toContain(result.note)
    expect(result.text).not.toContain("\ufffd")
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(80)
  })
})
