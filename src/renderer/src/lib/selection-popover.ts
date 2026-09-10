export type SelectionPopoverPlacement = {
  top: number
  left: number
  side: "above" | "below"
}

type Rect = {
  top: number
  right: number
  bottom: number
  left: number
  width: number
  height: number
}

export function placeSelectionPopover({
  selection,
  viewport,
  popoverWidth,
  popoverHeight,
  gap = 6,
  padding = 6,
}: {
  selection: Rect
  viewport: Rect
  popoverWidth: number
  popoverHeight: number
  gap?: number
  padding?: number
}): SelectionPopoverPlacement | null {
  if (selection.bottom <= viewport.top || selection.top >= viewport.bottom) {
    return null
  }

  const side =
    viewport.bottom - selection.bottom >= popoverHeight + gap
      ? "below"
      : "above"
  const unclampedTop =
    side === "below"
      ? selection.bottom - viewport.top + gap
      : selection.top - viewport.top - popoverHeight - gap
  const maxTop = Math.max(padding, viewport.height - popoverHeight - padding)
  const top = Math.min(Math.max(unclampedTop, padding), maxTop)
  const centeredLeft =
    selection.left - viewport.left + selection.width / 2 - popoverWidth / 2
  const maxLeft = Math.max(padding, viewport.width - popoverWidth - padding)

  return {
    top,
    left: Math.min(Math.max(centeredLeft, padding), maxLeft),
    side,
  }
}
