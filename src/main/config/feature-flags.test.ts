import { afterEach, describe, expect, it, vi } from "vitest"
import { missionControlEnabled } from "./feature-flags"

afterEach(() => vi.unstubAllEnvs())

describe("missionControlEnabled", () => {
  it.each([
    ["true", true],
    ["  TRUE  ", true],
    ["false", false],
    ["", false],
    ["yes", false],
    ["1", false],
    [undefined, false],
  ])("reads %s as %s", (value, expected) => {
    vi.stubEnv("NEXT_mission_control", value)
    expect(missionControlEnabled()).toBe(expected)
  })

  it("reads lazily after environment configuration changes", () => {
    vi.stubEnv("NEXT_mission_control", "false")
    expect(missionControlEnabled()).toBe(false)
    vi.stubEnv("NEXT_mission_control", "true")
    expect(missionControlEnabled()).toBe(true)
  })
})
