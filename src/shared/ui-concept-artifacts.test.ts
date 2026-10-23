import { describe, expect, it } from "vitest"
import {
  UI_CONCEPT_LIMITS,
  isPresentationTool,
  validateArtifactPresentation,
  validateArtifactSnapshot,
  validateUiConceptSnapshot,
  uiConceptChoiceNote,
} from "./conversation-artifacts"
import { conceptInput } from "./ui-concept-artifacts.fixture"

const wrap = (tree: unknown) => ({ title: "Concept", tree })
const deep = (depth: number): unknown =>
  depth <= 1
    ? { type: "separator" }
    : { type: "stack", children: [deep(depth - 1)] }

describe("UI concept snapshot contract", () => {
  it("accepts the documented vocabulary and dispatches by kind", () => {
    const snapshot = validateUiConceptSnapshot(conceptInput)
    expect(snapshot).toEqual({
      ...conceptInput,
      kind: "ui_concept",
      schemaVersion: 1,
    })
    expect(validateArtifactSnapshot(snapshot)).toEqual(snapshot)
    expect(isPresentationTool("present_ui")).toBe(true)
    expect(isPresentationTool("toString")).toBe(false)
  })

  it("keeps markup-like text as plain data", () => {
    const text = '<script>alert(1)</script><a href="javascript:x">'
    expect(
      validateUiConceptSnapshot(wrap({ type: "text", text })).tree
    ).toEqual({ type: "text", text })
  })

  it.each([
    [
      { type: "text", text: "x", className: "fixed inset-0" },
      /unsupported field className/,
    ],
    [
      { type: "text", text: "x", onClick: "steal()" },
      /unsupported field onClick/,
    ],
    [{ type: "stack", style: "x", children: [] }, /unsupported field style/],
    [{ type: "iframe" }, /unsupported node type iframe/],
    [{ type: "stack", children: [{ type: "input" }] }, /belong inside a field/],
    [
      { type: "field", label: "x", control: { type: "button", text: "y" } },
      /input, select or switch/,
    ],
    [
      {
        type: "field",
        label: "x",
        control: { type: "input", inputType: "password" },
      },
      /inputType/,
    ],
    [{ type: "field", label: "", control: { type: "switch" } }, /label/],
    [
      {
        type: "field",
        label: "x",
        control: { type: "select", options: ["a"], defaultValue: "b" },
      },
      /one of its options/,
    ],
    [
      {
        type: "field",
        label: "x",
        control: { type: "select", options: ["a", "a"] },
      },
      /unique/,
    ],
    [
      { type: "button", text: "x", children: [{ type: "button", text: "y" }] },
      /unsupported field children/,
    ],
    [{ type: "grid", columns: 7, children: [] }, /columns/],
    [{ type: "stack", gap: "xl", children: [] }, /gap/],
    [{ type: "tabs", tabs: [{ label: "Only", children: [] }] }, /2–6 tabs/],
    [
      {
        type: "tabs",
        tabs: [
          { label: "A", children: [] },
          { label: "A", children: [] },
        ],
      },
      /unique/,
    ],
    [
      { type: "table", columns: ["a", "b"], rows: [["only one"]] },
      /one cell per column/,
    ],
    [
      { type: "text", text: "x".repeat(UI_CONCEPT_LIMITS.text + 1) },
      /at most 500/,
    ],
    [deep(UI_CONCEPT_LIMITS.depth + 1), /nesting depth/],
    [
      {
        type: "stack",
        children: Array.from({ length: UI_CONCEPT_LIMITS.nodes }, () => ({
          type: "separator",
        })),
      },
      /exceeds 200 nodes/,
    ],
  ])("rejects %j", (tree, message) => {
    expect(() => validateUiConceptSnapshot(wrap(tree))).toThrow(message)
  })

  it("rejects unknown top-level fields and versions, and validates revisions", () => {
    expect(() =>
      validateUiConceptSnapshot({ ...conceptInput, html: "<b>" })
    ).toThrow(/unsupported field html/)
    expect(() =>
      validateUiConceptSnapshot({ ...conceptInput, schemaVersion: 2 })
    ).toThrow(/schema version/)
    expect(
      validateArtifactPresentation(
        { ...conceptInput, artifactId: "a-1", expectedBaseRevision: 1 },
        "ui_concept"
      )
    ).toMatchObject({ kind: "ui_concept", artifactId: "a-1" })
    expect(() =>
      validateArtifactPresentation(
        { ...conceptInput, artifactId: "a-1" },
        "ui_concept"
      )
    ).toThrow(/together/)
  })

  it("validates declared states and button targets", () => {
    const go = (goTo: string) => ({ type: "button", text: "Go", goTo })
    const state = (id: string, tree: unknown = go("initial")) => ({
      id,
      label: id,
      tree,
    })
    expect(
      validateUiConceptSnapshot({
        ...wrap(go("detail")),
        states: [state("detail")],
      }).states
    ).toEqual([{ id: "detail", label: "detail", tree: go("initial") }])
    expect(() => validateUiConceptSnapshot(wrap(go("missing")))).toThrow(
      /declared state/
    )
    expect(() =>
      validateUiConceptSnapshot({
        ...wrap(go("a")),
        states: [state("initial")],
      })
    ).toThrow(/unique/)
    expect(() =>
      validateUiConceptSnapshot({
        ...wrap(go("a")),
        states: [state("a"), state("a")],
      })
    ).toThrow(/unique/)
    expect(() =>
      validateUiConceptSnapshot({ ...wrap(go("a")), states: [] })
    ).toThrow(/1–8/)
    expect(() =>
      validateUiConceptSnapshot({
        ...wrap(go("a b")),
        states: [state("a b")],
      })
    ).toThrow(/safe alphanumeric/)
    expect(() =>
      validateUiConceptSnapshot({
        ...wrap(go("a")),
        states: [{ ...state("a"), onEnter: "x" }],
      })
    ).toThrow(/unsupported field onEnter/)
    // The node budget is shared across every screen.
    const half = {
      type: "stack",
      children: Array.from({ length: 100 }, () => ({ type: "separator" })),
    }
    expect(() =>
      validateUiConceptSnapshot({
        ...wrap(half),
        states: [state("a", half)],
      })
    ).toThrow(/exceeds 200 nodes/)
  })

  it("accepts bounded style tokens only", () => {
    expect(
      validateUiConceptSnapshot({
        ...wrap({ type: "card", surface: "muted", children: [] }),
        density: "compact",
        typeScale: "lg",
      })
    ).toMatchObject({
      density: "compact",
      typeScale: "lg",
      tree: { surface: "muted" },
    })
    expect(() =>
      validateUiConceptSnapshot({ ...conceptInput, density: "tiny" })
    ).toThrow(/density/)
    expect(() =>
      validateUiConceptSnapshot({ ...conceptInput, typeScale: "2xl" })
    ).toThrow(/typeScale/)
    expect(() =>
      validateUiConceptSnapshot(
        wrap({ type: "card", surface: "#f00", children: [] })
      )
    ).toThrow(/surface/)
  })

  it("builds a host-tagged choice note naming one exact revision", () => {
    expect(uiConceptChoiceNote('a"b', 3)).toBe(
      '<user_design_choice artifact_id="a\\"b" revision=3>Chose this UI concept direction via the "Use this direction" button.</user_design_choice>'
    )
  })

  it("accepts exactly the depth limit", () => {
    expect(() =>
      validateUiConceptSnapshot(wrap(deep(UI_CONCEPT_LIMITS.depth)))
    ).not.toThrow()
  })
})
