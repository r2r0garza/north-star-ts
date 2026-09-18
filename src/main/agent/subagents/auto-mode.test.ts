import { describe, expect, it, vi } from "vitest"
import { SubagentAutoModeRelay } from "./auto-mode"

describe("SubagentAutoModeRelay", () => {
  it("propagates changes to active children and auto-approves them when enabled", () => {
    const approve = vi.fn()
    const first = vi.fn()
    const second = vi.fn()
    const relay = new SubagentAutoModeRelay(false, approve)

    relay.register("first", first)
    relay.register("second", second)
    relay.set(true)

    expect(first).toHaveBeenLastCalledWith(true)
    expect(second).toHaveBeenLastCalledWith(true)
    expect(approve.mock.calls).toEqual([["first"], ["second"]])
  })

  it("applies the current mode to children registered after a change", () => {
    const approve = vi.fn()
    const child = vi.fn()
    const relay = new SubagentAutoModeRelay(false, approve)

    relay.set(true)
    relay.register("late", child)

    expect(child).toHaveBeenCalledWith(true)
    expect(approve).toHaveBeenCalledWith("late")
  })

  it("stops propagating after a child unregisters", () => {
    const child = vi.fn()
    const relay = new SubagentAutoModeRelay(false, vi.fn())
    const unregister = relay.register("child", child)

    unregister()
    relay.set(true)

    expect(child).toHaveBeenCalledTimes(1)
    expect(child).toHaveBeenCalledWith(false)
  })
})
