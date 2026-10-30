import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
function luminance(hex: string) {
  const rgb = hex
    .match(/\w\w/g)!
    .map((pair) => parseInt(pair, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}
it("keeps every host snapshot series above 3:1 against its theme surface", () => {
  const css = readFileSync("src/renderer/src/globals.css", "utf8")
  const [light, dark] = css.split(".dark {")
  for (const [theme, background] of [
    [light, 1],
    [dark, 0.145 ** 3],
  ] as const) {
    const colors = [...theme.matchAll(/--artifact-series-\d: #(\w{6})/g)]
    expect(colors).toHaveLength(5)
    for (const color of colors) {
      const foreground = luminance(color[1])
      expect(
        (Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05)
      ).toBeGreaterThanOrEqual(3)
    }
  }
})
