import { expect, it } from "vitest"
import { isBrowserAddressShortcut } from "./browser-shortcut"

it("matches only the platform address shortcut", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const modifier = platform === "darwin" ? { meta: true } : { control: true }
    expect(isBrowserAddressShortcut({ key: "l", ...modifier }, platform)).toBe(
      true
    )
    expect(isBrowserAddressShortcut({ key: "L", ...modifier }, platform)).toBe(
      true
    )
    expect(isBrowserAddressShortcut({ key: "l" }, platform)).toBe(false)
    expect(
      isBrowserAddressShortcut(
        { key: "l", meta: true, control: true },
        platform
      )
    ).toBe(false)
    expect(
      isBrowserAddressShortcut({ key: "l", ...modifier, alt: true }, platform)
    ).toBe(false)
    expect(
      isBrowserAddressShortcut({ key: "l", ...modifier, shift: true }, platform)
    ).toBe(false)
    expect(isBrowserAddressShortcut({ key: "k", ...modifier }, platform)).toBe(
      false
    )
  }
})
