import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { brandThemeCss, hexToOklch } from "./theme"

// The pure color math (hexToOklch, themeCssFromHexes) is covered in
// src/shared/theme.test.ts. Here we only assert the env-reading behavior of
// brandThemeCss: null when unset, env drives the hues, invalid hex falls back.
// (resolveBrandTheme's DB-over-env precedence is exercised in service tests.)

function tokenOf(css: string, name: string): string | null {
  const m = css.match(new RegExp(`--${name}:\\s*(oklch\\([^)]*\\))`))
  return m ? m[1] : null
}

function numsOf(oklch: string): [number, number, number] {
  const m = oklch.match(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)/)
  if (!m) throw new Error(`not an oklch triple: ${oklch}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

beforeEach(() => {
  delete process.env.NEXT_accent_color
  delete process.env.NEXT_neutral_color
})
afterEach(() => {
  delete process.env.NEXT_accent_color
  delete process.env.NEXT_neutral_color
})

describe("brandThemeCss (env path)", () => {
  it("returns null when neither env var is set (globals.css stands)", () => {
    expect(brandThemeCss()).toBeNull()
  })

  it("rotates brand tokens to the configured accent hue", () => {
    process.env.NEXT_accent_color = "#2563eb" // a blue
    const blue = hexToOklch("#2563eb")!
    const theme = brandThemeCss()!
    const [, , h] = numsOf(tokenOf(theme.light, "primary")!)
    expect(h).toBeCloseTo(blue.h, 0)
  })

  it("recolors neutrals toward the configured neutral hue", () => {
    process.env.NEXT_neutral_color = "#0a0a12" // a faintly blue-tinted gray
    const tint = hexToOklch("#0a0a12")!
    const theme = brandThemeCss()!
    const [, c, h] = numsOf(tokenOf(theme.light, "background")!)
    expect(c).toBeCloseTo(tint.c, 3)
    expect(h).toBeCloseTo(tint.h, 0)
  })

  it("falls back to defaults for an invalid hex", () => {
    process.env.NEXT_accent_color = "garbage"
    const theme = brandThemeCss()!
    const [, , h] = numsOf(tokenOf(theme.light, "primary")!)
    expect(Math.abs(h - 150.069)).toBeLessThan(2) // default green hue
  })
})
