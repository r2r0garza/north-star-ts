import { useEffect, useId, useRef, useState } from "react"
import type { Mermaid as MermaidApi } from "mermaid"

// Lazy-load mermaid only when a diagram is actually rendered — it's large and
// most messages have none, so this keeps it out of the initial bundle. Cached
// after the first load. `securityLevel: "strict"` sanitizes labels (we render
// untrusted model output); startOnLoad is off since we render imperatively.
let mermaidPromise: Promise<MermaidApi> | undefined
function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" })
      return mermaid
    })
  }
  return mermaidPromise
}

// Renders a Mermaid diagram from its source. While the assistant is still
// streaming, the source is often incomplete and won't parse — we keep showing
// the previous successful render (or the raw source) instead of an error.
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, "")
  const containerRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState("")
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const source = chart.trim()
    if (!source) return

    getMermaid()
      .then((mermaid) => mermaid.render(`mermaid-${id}`, source))
      .then(({ svg }) => {
        if (!cancelled) {
          setSvg(svg)
          setFailed(false)
        }
      })
      .catch(() => {
        // Parse error — likely mid-stream or malformed. Keep the last good SVG;
        // only fall back to raw source if we never rendered anything.
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [chart, id])

  if (svg) {
    return (
      <div
        ref={containerRef}
        className="my-3 flex justify-center overflow-x-auto"
        // eslint-disable-next-line react/no-danger -- SVG comes from mermaid's
        // own renderer with securityLevel "strict"; input labels are sanitized.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    )
  }

  // No successful render yet — show the source so streaming/invalid diagrams
  // remain readable rather than blank.
  return (
    <pre className="my-3 overflow-x-auto rounded-lg bg-muted p-3 text-xs">
      <code>{chart}</code>
      {failed && (
        <span className="mt-2 block text-muted-foreground">
          (diagram not yet renderable)
        </span>
      )}
    </pre>
  )
}
