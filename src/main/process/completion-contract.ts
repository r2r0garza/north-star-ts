import type { PhaseCompletionContract } from "../db/types"

export const LEGACY_COMPLETION: PhaseCompletionContract = { policy: "legacy" }

// Shared authoring/import boundary. Unknown versions and malformed checks must
// never degrade into legacy success. Only omission is backwards compatible.
export function parseCompletionContract(
  value: unknown
): PhaseCompletionContract {
  if (value === undefined) return { ...LEGACY_COMPLETION }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid phase completion contract")
  const c = value as Record<string, unknown>
  if (c.policy === "legacy" && Object.keys(c).length === 1)
    return { policy: "legacy" }
  if (
    c.policy !== "validated" ||
    c.version !== 1 ||
    Object.keys(c).some(
      (k) => !["policy", "version", "requiredArtifacts"].includes(k)
    ) ||
    !Array.isArray(c.requiredArtifacts) ||
    c.requiredArtifacts.length > 100 ||
    !c.requiredArtifacts.every(
      (p) =>
        typeof p === "string" &&
        p.trim() === p &&
        p.length > 0 &&
        p.length <= 1024 &&
        !p.includes("\0") &&
        !p.includes("\\") &&
        !p.startsWith("/") &&
        !/^[a-z]:/i.test(p) &&
        p.split("/").every((s) => s !== ".." && s !== "." && s !== "")
    )
  )
    throw new Error(
      "Validated completion requires version 1 and workspace-relative file paths"
    )
  return {
    policy: "validated",
    version: 1,
    requiredArtifacts: [...new Set(c.requiredArtifacts as string[])],
  }
}
