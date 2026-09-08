import { describe, expect, it } from "vitest"
import {
  hexToOklch,
  themeCssFromHexes,
  DEFAULT_ACCENT_HEX,
  DEFAULT_NEUTRAL_HEX,
} from "./theme"

// Extract the oklch(...) value of a single token from an emitted declaration
// block, e.g. tokenOf("--primary: oklch(0.5 0.1 150); …", "primary").
function tokenOf(css: string, name: string): string | null {
  const m = css.match(new RegExp(`--${name}:\\s*(oklch\\([^)]*\\))`))
  return m ? m[1] : null
}

// Pull the three numbers out of an `oklch(L C H)` string (ignores alpha).
function numsOf(oklch: string): [number, number, number] {
  const m = oklch.match(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)/)
  if (!m) throw new Error(`not an oklch triple: ${oklch}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

describe("hexToOklch", () => {
  it("parses #rrggbb, tolerating a missing hash and whitespace", () => {
    expect(hexToOklch("#ffffff")).not.toBeNull()
    expect(hexToOklch("  0a0a0a ")).not.toBeNull()
  })

  it("expands #rgb shorthand", () => {
    const long = hexToOklch("#ffffff")!
    const short = hexToOklch("#fff")!
    expect(short.l).toBeCloseTo(long.l, 6)
  })

  it("returns null for invalid input", () => {
    expect(hexToOklch("not-a-color")).toBeNull()
    expect(hexToOklch("#12")).toBeNull()
    expect(hexToOklch("#zzzzzz")).toBeNull()
  })

  it("maps the current green primary back to ~its globals.css oklch", () => {
    const g = hexToOklch("#008236")!
    expect(g.l).toBeCloseTo(0.527, 2)
    expect(g.c).toBeCloseTo(0.154, 1)
    expect(Math.abs(g.h - 150.069)).toBeLessThan(2)
  })

  it("reads pure grays as (near-)zero chroma", () => {
    expect(hexToOklch("#0a0a0a")!.c).toBeCloseTo(0, 3)
    expect(hexToOklch("#ffffff")!.c).toBeCloseTo(0, 3)
  })
})

describe("themeCssFromHexes", () => {
  it("reproduces the current token values when seeded with the defaults", () => {
    const theme = themeCssFromHexes(DEFAULT_ACCENT_HEX, DEFAULT_NEUTRAL_HEX)

    // Brand token: light primary is oklch(0.527 0.154 150.069) in globals.css.
    // L is preserved exactly; chroma + hue round-trip through hex within a
    // sub-perceptual margin (~0.005 chroma, ~1° hue).
    const [pl, pc, ph] = numsOf(tokenOf(theme.light, "primary")!)
    expect(pl).toBeCloseTo(0.527, 3)
    expect(pc).toBeCloseTo(0.154, 1)
    expect(Math.abs(ph - 150.069)).toBeLessThan(2)

    // Neutral token: light background is oklch(1 0 0) — pure white.
    const [bl, bc] = numsOf(tokenOf(theme.light, "background")!)
    expect(bl).toBeCloseTo(1, 3)
    expect(bc).toBeCloseTo(0, 3)

    // Sidebar list is intentionally offset from the main sidebar so the
    // scrollable conversation region has a visible but quiet boundary.
    expect(theme.light).toMatch(/--sidebar-list:\s*oklch\(0.965 0 0\)/)
    expect(theme.dark).toMatch(/--sidebar-list:\s*oklch\(0.18 0 0\)/)

    // Dark border keeps its alpha (globals.css: oklch(1 0 0 / 10%)).
    expect(theme.dark).toMatch(/--border:\s*oklch\(1 0 0 \/ 10%\)/)
  })

  it("rotates brand tokens to the configured hue while preserving lightness", () => {
    const blue = hexToOklch("#2563eb")!
    const theme = themeCssFromHexes("#2563eb", DEFAULT_NEUTRAL_HEX)
    const [l, , h] = numsOf(tokenOf(theme.light, "primary")!)
    expect(l).toBeCloseTo(0.527, 3) // unchanged L ladder
    expect(h).toBeCloseTo(blue.h, 0) // rotated to the accent hue
    // The sidebar brand token rotates to the same hue.
    const [, , sh] = numsOf(tokenOf(theme.light, "sidebar-primary")!)
    expect(sh).toBeCloseTo(blue.h, 0)
  })

  it("recolors neutrals toward the configured neutral hue", () => {
    const tint = hexToOklch("#0a0a12")! // a faintly blue-tinted gray
    const theme = themeCssFromHexes(DEFAULT_ACCENT_HEX, "#0a0a12")
    const [, c, h] = numsOf(tokenOf(theme.light, "background")!)
    expect(c).toBeCloseTo(tint.c, 3)
    expect(h).toBeCloseTo(tint.h, 0)

    const [listL, listC, listH] = numsOf(tokenOf(theme.light, "sidebar-list")!)
    expect(listL).toBeCloseTo(0.965, 3)
    expect(listC).toBeCloseTo(tint.c, 3)
    expect(listH).toBeCloseTo(tint.h, 0)
  })

  it("falls back to defaults for an invalid hex", () => {
    const theme = themeCssFromHexes("garbage", DEFAULT_NEUTRAL_HEX)
    const [, , h] = numsOf(tokenOf(theme.light, "primary")!)
    expect(Math.abs(h - 150.069)).toBeLessThan(2) // default green hue, not thrown away
  })
})
