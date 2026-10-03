// A user story's acceptance check manifest (plan 109.02): which checks verify
// each acceptance criterion. QA writes it in the `checks` step at
// `<checksDir>/stories/<storyRef>.json`; the harness validates it before the
// step may complete and reads it when `run_checks` runs. Pure rules only: the
// caller reads the file and resolves the criteria and story ref server-side.

export const DEFAULT_CHECK_TIMEOUT_MS = 5 * 60_000
export const MAX_CHECK_TIMEOUT_MS = 30 * 60_000

export interface AutomatedCheck {
  id: string
  kind: "automated"
  command: string
  // Workspace-relative; "" is the workspace root.
  cwd: string
  // App services from the launch recipe (plan 109.03).
  services: string[]
  timeoutMs: number
}

export interface ExploratoryCheck {
  id: string
  kind: "exploratory"
  // What to verify by driving the app in the test step.
  note: string
}

export type ManifestCheck = AutomatedCheck | ExploratoryCheck

export interface ChecksManifest {
  // Criterion id (AC-1, …) → its checks, in the spec's criterion order.
  criteria: Record<string, ManifestCheck[]>
}

export type ManifestValidation =
  | { ok: true; manifest: ChecksManifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] }

const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// A workspace-relative cwd as stored ("" for the root), or null when it leaves
// the workspace.
function normalizeCwd(value: string): string | null {
  const trimmed = value.trim().replace(/\\/g, "/")
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) return null
  const parts = trimmed.split("/").filter((p) => p !== "" && p !== ".")
  if (parts.includes("..")) return null
  return parts.join("/")
}

// Validate a manifest's text against the user story's criterion ids. Every
// criterion needs at least one check; an automated check needs a command; ids
// are unique across the manifest; a cwd stays inside the workspace. Services
// are refused until app launch recipes exist (`servicesAvailable`).
export function validateChecksManifest(input: {
  text: string
  criterionIds: string[]
  storyRef: string
  servicesAvailable?: boolean
}): ManifestValidation {
  const errors: string[] = []
  const warnings: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(input.text)
  } catch (err) {
    return {
      ok: false,
      errors: [
        `The manifest isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
      warnings,
    }
  }
  if (!isRecord(raw) || !isRecord(raw.criteria))
    return {
      ok: false,
      errors: [
        'The manifest must be an object with a "criteria" object mapping each criterion id (AC-1, …) to a list of checks.',
      ],
      warnings,
    }

  const known = new Set(input.criterionIds)
  const ids = new Set<string>()
  const parsed = new Map<string, ManifestCheck[]>()
  // Criteria the manifest mentions, valid or not, so a broken entry isn't
  // also reported as missing.
  const mentioned = new Set<string>()
  for (const [key, list] of Object.entries(raw.criteria)) {
    const criterion = key.trim().toUpperCase()
    if (!known.has(criterion)) {
      errors.push(
        `"${key}" is not one of this user story's criteria (${input.criterionIds.join(", ") || "none"}).`
      )
      continue
    }
    if (mentioned.has(criterion)) {
      errors.push(`Criterion ${criterion} appears more than once.`)
      continue
    }
    mentioned.add(criterion)
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`${criterion} needs a non-empty list of checks.`)
      continue
    }
    const checks: ManifestCheck[] = []
    list.forEach((item, index) => {
      const where = `${criterion}[${index}]`
      if (!isRecord(item)) {
        errors.push(`${where} must be an object.`)
        return
      }
      const id = typeof item.id === "string" ? item.id.trim() : ""
      if (!CHECK_ID.test(id)) {
        errors.push(
          `${where} needs an "id" of letters, digits, ".", "_" or "-" (e.g. "ac1-login-redirect").`
        )
        return
      }
      if (ids.has(id)) {
        errors.push(`Check id "${id}" is used more than once.`)
        return
      }
      ids.add(id)
      if (item.kind === "exploratory") {
        const note = typeof item.note === "string" ? item.note.trim() : ""
        if (!note) {
          errors.push(
            `Exploratory check "${id}" needs a "note" saying what to verify in the running app.`
          )
          return
        }
        checks.push({ id, kind: "exploratory", note })
        return
      }
      if (item.kind !== "automated") {
        errors.push(
          `Check "${id}" needs "kind": "automated" (a command) or "exploratory" (a note).`
        )
        return
      }
      const command =
        typeof item.command === "string" ? item.command.trim() : ""
      if (!command) {
        errors.push(`Automated check "${id}" needs a "command".`)
        return
      }
      const cwd =
        item.cwd === undefined || item.cwd === null
          ? ""
          : typeof item.cwd === "string"
            ? normalizeCwd(item.cwd)
            : null
      if (cwd === null) {
        errors.push(
          `Check "${id}" has a "cwd" outside the workspace. Use a workspace-relative folder, or "" for the root.`
        )
        return
      }
      const services =
        item.services === undefined
          ? []
          : Array.isArray(item.services) &&
              item.services.every((s) => typeof s === "string" && s.trim())
            ? (item.services as string[]).map((s) => s.trim())
            : null
      if (services === null) {
        errors.push(`Check "${id}" has "services" that aren't a list of names.`)
        return
      }
      if (services.length && !input.servicesAvailable) {
        errors.push(
          `Check "${id}" declares services (${services.join(", ")}), but this workspace has no app launch recipe yet, so nothing can start them. Have the check start what it needs itself, or remove "services".`
        )
        return
      }
      let timeoutMs = DEFAULT_CHECK_TIMEOUT_MS
      if (item.timeoutMs !== undefined) {
        if (
          typeof item.timeoutMs !== "number" ||
          !Number.isFinite(item.timeoutMs) ||
          item.timeoutMs < 1000 ||
          item.timeoutMs > MAX_CHECK_TIMEOUT_MS
        ) {
          errors.push(
            `Check "${id}" needs a "timeoutMs" between 1000 and ${MAX_CHECK_TIMEOUT_MS}.`
          )
          return
        }
        timeoutMs = Math.round(item.timeoutMs)
      }
      // A spec file holds several stories' tests, so a command should select
      // this story's by tag (or at least name a file).
      if (
        !command.includes(input.storyRef) &&
        !/[\w-]+\.[A-Za-z]{1,5}\b/.test(command.replace(/^\S+/, ""))
      )
        warnings.push(
          `Check "${id}" doesn't select this story's tests: its command mentions neither the tag @${input.storyRef} nor a file, so it may run every story's checks.`
        )
      checks.push({ id, kind: "automated", command, cwd, services, timeoutMs })
    })
    parsed.set(criterion, checks)
  }

  const missing = input.criterionIds.filter((id) => !mentioned.has(id))
  if (missing.length)
    errors.push(
      `Every criterion needs at least one check (automated, or exploratory when it can't be checked mechanically); missing: ${missing.join(", ")}.`
    )
  if (errors.length) return { ok: false, errors, warnings }
  const criteria: Record<string, ManifestCheck[]> = {}
  for (const id of input.criterionIds) criteria[id] = parsed.get(id)!
  return { ok: true, manifest: { criteria }, warnings }
}

// Every automated check in a manifest, with the criterion it verifies.
export function automatedChecks(
  manifest: ChecksManifest
): Array<AutomatedCheck & { criterionId: string }> {
  return Object.entries(manifest.criteria).flatMap(([criterionId, checks]) =>
    checks
      .filter((c): c is AutomatedCheck => c.kind === "automated")
      .map((c) => ({ ...c, criterionId }))
  )
}
