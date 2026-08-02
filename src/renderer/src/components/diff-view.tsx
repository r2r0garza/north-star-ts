import * as React from "react"
import { cn } from "@/lib/utils"
import type { GitDiffResult } from "@/types"

// Renders a unified git diff as colorized lines. No diff library: git already
// emits unified-diff text; we colorize by the leading character (+ added, -
// removed, @@ hunk header, everything else context). Shared by the changed-file
// pill hover popover and the sidebar "Changes" review.

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-muted-foreground" // file headers
  }
  if (line.startsWith("@@")) return "text-sky-500 dark:text-sky-400"
  if (line.startsWith("+")) return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  if (line.startsWith("-")) return "bg-red-500/10 text-red-700 dark:text-red-300"
  if (line.startsWith("diff ") || line.startsWith("index ")) {
    return "text-muted-foreground/70"
  }
  return "text-foreground/80"
}

export function DiffView({
  result,
  className,
}: {
  // null = not a git repo (or not resolved); empty diff = tracked & unchanged.
  result: GitDiffResult | null
  className?: string
}) {
  if (!result) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        Not a git repository — no diff available.
      </p>
    )
  }
  if (!result.diff.trim()) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        No changes vs. the last commit.
      </p>
    )
  }
  const lines = result.diff.split("\n")
  return (
    <div className={cn("overflow-auto", className)}>
      <pre className="font-mono text-[11px] leading-relaxed">
        <code>
          {lines.map((line, i) => (
            <div key={i} className={cn("px-2", lineClass(line))}>
              {line || " "}
            </div>
          ))}
        </code>
      </pre>
      {result.truncated && (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          Diff truncated (too large to show in full).
        </p>
      )}
    </div>
  )
}
