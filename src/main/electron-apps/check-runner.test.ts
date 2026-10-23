import { describe, expect, it } from "vitest"
import { validateCheck } from "./check-runner"

const ok = (check: unknown) => {
  const result = validateCheck(check)
  if ("errors" in result) throw new Error(result.errors.join("; "))
  return result.check
}
const errors = (check: unknown) => {
  const result = validateCheck(check)
  return "errors" in result ? result.errors.join("\n") : ""
}

describe("validateCheck", () => {
  it("accepts the documented vocabulary", () => {
    const check = ok({
      name: "counter",
      steps: [
        { step: "window", title: "Fixture" },
        { step: "click", target: { role: "button", name: "Count" } },
        { step: "fill", target: { label: "Name" }, text: "Bob", submit: false },
        { step: "select", target: { role: "combobox", nth: 1 }, option: "Green" },
        { step: "press", key: "Escape", modifiers: ["Shift"] },
        { step: "drag", target: { testId: "src" }, to: { testId: "dst" } },
        { step: "wait", until: { text: { text: "Hello" }, contains: "Bob" }, timeoutMs: 2000 },
        { step: "assert", that: { state: { label: "Agree" }, checked: true } },
        { step: "assert", that: { count: { role: "listitem" }, equals: 3 } },
        { step: "assert", that: { url: { contains: "index.html" } } },
        { step: "assert", that: { windowCount: 1 } },
        { step: "assert", that: { load: true } },
        { step: "screenshot" },
        { step: "snapshot" },
      ],
    })
    expect(check.steps).toHaveLength(14)
  })

  it("treats expression- and script-like strings as literal text", () => {
    expect(() =>
      ok({ steps: [{ step: "assert", that: { pageText: { contains: "${process.exit()}" } } }, { step: "fill", target: { label: "x" }, text: "javascript:alert(1)" }] })
    ).not.toThrow()
  })

  it("rejects unknown steps, fields and condition shapes", () => {
    expect(errors({ steps: [{ step: "evaluate", script: "1" }] })).toMatch(/unknown step/)
    expect(errors({ steps: [{ step: "click", target: { name: "x" }, script: "1" }] })).toMatch(/unknown field "script"/)
    expect(errors({ steps: [{ step: "click", target: { css: "#x" } }] })).toMatch(/unknown field "css"/)
    expect(errors({ steps: [{ step: "assert", that: { visible: { name: "a" }, hidden: { name: "b" } } }] })).toMatch(/exactly one/)
    expect(errors({ steps: [{ step: "assert", that: { expression: "a == b" } }] })).toMatch(/exactly one/)
    expect(errors({ steps: [{ step: "launch", entry: "." }] })).toMatch(/unknown step/)
    expect(errors({ steps: [], launch: true })).toMatch(/unknown field "launch"|non-empty/)
  })

  it("enforces bounds", () => {
    expect(errors({ steps: Array(201).fill({ step: "snapshot" }) })).toMatch(/at most 200/)
    expect(errors({ steps: Array(6).fill({ step: "screenshot" }) })).toMatch(/at most 5 screenshot/)
    expect(errors({ steps: [{ step: "fill", target: { label: "a" }, text: "x".repeat(70_000) }] })).toMatch(/larger than/)
    expect(errors({ timeoutMs: 999_999, steps: [{ step: "snapshot" }] })).toMatch(/timeoutMs/)
    expect(errors({ steps: [{ step: "click", target: { testId: 'a"] , *' } }] })).toMatch(/testId/)
    expect(errors({ steps: [{ step: "click", target: { nth: 2 } }] })).toMatch(/at least one/)
    expect(errors("not a check")).toMatch(/must be an object/)
  })
})
