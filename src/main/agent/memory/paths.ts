// Automatic-memory files are owned exclusively by the background memory
// service. Any other write into them is a hole straight into durable memory:
// classifyAndDistribute reads raw "- " bullets out of staging.md with none of
// the provenance, kind, and injection checks the extraction path applies, so a
// single appended line becomes a permanent memory.
//
// Deliberately dependency-free (path math only) so both the tool layer and the
// approval classifier can import it without pulling Electron into either.

// Matched structurally — any dot-directory containing skills/memory-* — rather
// than against the configured system slug, so it holds for a renamed install
// and for the user-level ~/.<slug>/skills tree alike. Works on relative paths
// too, which is what shell argv carries.
export function isManagedMemoryPath(candidatePath: string): boolean {
  const segments = candidatePath.split(/[\\/]+/)
  return segments.some(
    (segment, i) =>
      segment.length > 1 &&
      segment.startsWith(".") &&
      segments[i + 1] === "skills" &&
      segments[i + 2]?.startsWith("memory-") === true
  )
}

export const MANAGED_MEMORY_WRITE_ERROR =
  "Automatic memory files are maintained by a background service and cannot be " +
  "written by tools. You do not need to record anything: state the fact in your " +
  "reply and the service captures it after the turn."
