import { describe, expect, it } from "vitest"
import {
  formatSeatAddress,
  isPodKey,
  isReservedRigAddress,
  isRigKey,
  parseSeatAddress,
} from "./address"

describe("Mission Control addresses", () => {
  it("round-trips canonical seat addresses", () => {
    expect(formatSeatAddress("builder-1", "implementation")).toBe(
      "builder-1@implementation"
    )
    expect(parseSeatAddress("builder-1@implementation")).toEqual({
      seatKey: "builder-1",
      podKey: "implementation",
    })
  })

  it("rejects malformed and reserved keys", () => {
    expect(isRigKey("Builder")).toBe(false)
    expect(isRigKey("builder--one")).toBe(false)
    expect(isPodKey("rig")).toBe(false)
    expect(parseSeatAddress("builder@rig")).toBeNull()
  })

  it("recognizes system-owned addresses", () => {
    expect(isReservedRigAddress("user@rig")).toBe(true)
    expect(isReservedRigAddress("navigator@rig")).toBe(true)
  })
})
