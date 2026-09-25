import { describe, expect, it } from "vitest"
import { filesOutsideHints } from "./integration"

describe("filesOutsideHints", () => {
  it("reports touched files no hint covers", () => {
    expect(
      filesOutsideHints(
        ["src/billing/invoice.ts", "src/billing/pdf/render.ts", "README.md", "src/api.ts"],
        ["src/billing/**", "./README.md"]
      )
    ).toEqual(["src/api.ts"])
  })

  it("reports nothing for a slice without hints", () => {
    expect(filesOutsideHints(["anything.ts"], [])).toEqual([])
  })
})
