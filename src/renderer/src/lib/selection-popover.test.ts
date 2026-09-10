import { describe, expect, it } from "vitest"
import { placeSelectionPopover } from "./selection-popover"

const viewport = {
  top: 100,
  right: 500,
  bottom: 500,
  left: 100,
  width: 400,
  height: 400,
}

describe("placeSelectionPopover", () => {
  it("places the control below a visible selection when space is available", () => {
    expect(
      placeSelectionPopover({
        selection: {
          top: 180,
          right: 320,
          bottom: 200,
          left: 220,
          width: 100,
          height: 20,
        },
        viewport,
        popoverWidth: 100,
        popoverHeight: 28,
      })
    ).toEqual({ top: 106, left: 120, side: "below" })
  })

  it("moves above when there is not enough room below", () => {
    expect(
      placeSelectionPopover({
        selection: {
          top: 470,
          right: 320,
          bottom: 490,
          left: 220,
          width: 100,
          height: 20,
        },
        viewport,
        popoverWidth: 100,
        popoverHeight: 28,
      })
    ).toEqual({ top: 336, left: 120, side: "above" })
  })

  it("hides when the selection is outside the scroll viewport", () => {
    expect(
      placeSelectionPopover({
        selection: {
          top: 40,
          right: 320,
          bottom: 80,
          left: 220,
          width: 100,
          height: 40,
        },
        viewport,
        popoverWidth: 100,
        popoverHeight: 28,
      })
    ).toBeNull()
  })

  it("keeps the control inside the viewport horizontally", () => {
    expect(
      placeSelectionPopover({
        selection: {
          top: 180,
          right: 495,
          bottom: 200,
          left: 480,
          width: 15,
          height: 20,
        },
        viewport,
        popoverWidth: 100,
        popoverHeight: 28,
      })
    ).toEqual({ top: 106, left: 294, side: "below" })
  })
})
