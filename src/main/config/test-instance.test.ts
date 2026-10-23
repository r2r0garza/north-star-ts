import { describe, it, expect, vi } from "vitest"

vi.mock("electron", () => ({ app: { setPath: vi.fn() } }))

import { parseTestProfile } from "./test-instance"

describe("parseTestProfile", () => {
  it("is null without the flag", () => {
    expect(parseTestProfile(["electron", "."])).toBeNull()
  })

  it("splits an absolute root into userData and home", () => {
    expect(parseTestProfile([".", "--test-profile=/tmp/p/"])).toEqual({
      root: "/tmp/p",
      userData: "/tmp/p/user-data",
      home: "/tmp/p/home",
    })
  })

  it("fails closed on relative, empty or repeated values", () => {
    expect(() => parseTestProfile(["--test-profile=rel"])).toThrow(/absolute/)
    expect(() => parseTestProfile(["--test-profile="])).toThrow(/absolute/)
    expect(() =>
      parseTestProfile(["--test-profile=/a", "--test-profile=/b"])
    ).toThrow(/more than once/)
  })
})
