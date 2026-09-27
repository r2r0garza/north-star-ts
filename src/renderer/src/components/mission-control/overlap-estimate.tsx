import type { OverlapEstimate } from "@/lib/overlap-schedule"

const MAX_PAIRS = 3

// One line per milestone: what "Overlapping stories" would change for it.
export function overlapEstimateText(estimate: OverlapEstimate): string {
  const steps = (n: number) => `${n} step${n === 1 ? "" : "s"}`
  if (!estimate.pairs.length)
    return `${estimate.label}: no independent user stories overlap, so both settings take ${steps(estimate.wait)}.`
  const shown = estimate.pairs
    .slice(0, MAX_PAIRS)
    .map(([a, b]) => `${a} ↔ ${b}`)
    .join(", ")
  const more =
    estimate.pairs.length > MAX_PAIRS
      ? ` (+${estimate.pairs.length - MAX_PAIRS} more)`
      : ""
  if (estimate.wait === estimate.parallel)
    return `${estimate.label}: ${steps(estimate.wait)} either way; the concurrency limit, not the overlaps, sets the pace. Overlapping: ${shown}${more}.`
  return `${estimate.label}: ${steps(estimate.wait)} if overlapping stories wait, ${steps(estimate.parallel)} if they run in parallel. Overlapping: ${shown}${more}.`
}

export function OverlapEstimates({
  estimates,
}: {
  estimates: OverlapEstimate[]
}) {
  if (!estimates.length) return null
  return (
    <div
      className="space-y-0.5 text-xs text-muted-foreground"
      title="Estimated in equal-length steps using the Navigator's rules. Running in parallel can cost time at merge if the stories really collide."
    >
      {estimates.map((estimate) => (
        <p key={estimate.label}>{overlapEstimateText(estimate)}</p>
      ))}
    </div>
  )
}
