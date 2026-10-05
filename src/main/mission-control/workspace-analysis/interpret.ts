import path from "path"
import type {
  Finding,
  FindingCategory,
  FindingSeverity,
} from "../../../shared/mission-control/workspace-analysis"
import type { AnalysisFacts } from "./analyze"
import type { FindingDraft } from "./draft"
import {
  checkGeneratedCommand,
  checkGlob,
  checkRelativePath,
  checkSetupCommand,
} from "./policy"

// Stage 7 (plan 106.11): the model handles the residue the deterministic
// stages can't — unknown ignored entries, generated outputs with no known
// command, ecosystems without a recipe — and may refine explanations. It sees
// the structured facts and bounded excerpts of setup docs, never .env contents
// or arbitrary source. Every model finding must cite evidence from its input;
// the main process validates paths and commands, and rejected findings are
// kept for diagnostics.

export type Complete = (
  system: string,
  user: string,
  signal: AbortSignal
) => Promise<string>

export interface InterpretResult {
  drafts: FindingDraft[]
  // Replacement commands for generated groups (by finding key).
  generatedCommands: Array<{ key: string; command: string; evidence: string }>
  explanations: Record<string, string>
  rejected: Array<{ title: string; reason: string }>
}

const SYSTEM = `You help set up a software project so AI agents can work on it in parallel Git worktrees.
A worktree has only tracked files. North Star already ran deterministic checks; you handle what they couldn't classify.
Answer with ONE JSON object and nothing else, matching this TypeScript type:
{
  "ignored": Array<{ "path": string, "action": "link" | "setup" | "ignore", "setup"?: { "label": string, "command": string, "cwd": string }, "reason": string, "evidence": string[] }>,
  "generated": Array<{ "key": string, "command": string, "reason": string, "evidence": string[] }>,
  "findings": Array<{ "category": "toolchain" | "main-environment" | "worktree-environment" | "generated-files" | "local-config" | "database", "severity": "warning" | "info", "title": string, "explanation": string, "confidence": "likely" | "guess", "fix": { "kind": "manual", "steps": string[] } | { "kind": "setup-step", "label": string, "command": string, "cwd": string } | { "kind": "generated-rule", "paths": string[], "command": string }, "evidence": string[] }>,
  "explanations": Record<string, string>
}
Rules:
- "evidence" lists ids from the EVIDENCE section (e.g. "E3"). A claim without evidence is discarded.
- "ignored": classify only paths listed under UNKNOWN IGNORED. "link" = share the main checkout's copy (config, caches that don't embed the checkout path). "setup" = each worktree must build its own (give ONE simple command, no && or pipes, cwd relative to the workspace). "ignore" = not needed to work.
- "generated": for each GENERATED WITHOUT COMMAND entry you can pair, give the command (run from the workspace root; you may prefix "cd <dir> && ").
- "findings": only for things the checks missed and the evidence shows: an ecosystem without a recipe, a setup step the README/CI requires. Plain language, one or two sentences. No secrets.
- "explanations": optional clearer wording for existing findings, keyed by finding key, at most 300 characters each.
- Commands must be single commands a developer would run; never install system packages, never curl | sh, never sudo.
- If there is nothing to add, return empty arrays.`

interface EvidenceItem {
  id: string
  text: string
  path?: string
}

export function buildPrompt(
  facts: AnalysisFacts,
  drafts: FindingDraft[],
  intent: string
): {
  user: string
  evidence: Map<string, EvidenceItem>
} {
  const evidence = new Map<string, EvidenceItem>()
  const add = (text: string, p?: string) => {
    const id = `E${evidence.size + 1}`
    evidence.set(id, { id, text, ...(p ? { path: p } : {}) })
    return id
  }
  const lines: string[] = []
  lines.push(`FEATURE INTENT: ${intent.slice(0, 600)}`)
  lines.push(
    `GIT: ${facts.git.isRepo ? `repository at ${facts.git.root}, workspace subpath "${facts.git.subpath}"${facts.git.unborn ? ", no commits" : ""}` : "not a repository"}`
  )
  lines.push("PROJECTS:")
  for (const root of facts.inventory.roots)
    lines.push(
      `- ${root.dir || "(workspace root)"}: ${root.ecosystems.join(", ")}${root.members.length ? ` (members: ${root.members.slice(0, 6).join(", ")})` : ""}`
    )
  lines.push("EXISTING FINDINGS (key | category | title | fix):")
  for (const d of drafts.slice(0, 60))
    lines.push(`- ${d.key} | ${d.category} | ${d.title} | ${d.fix.summary}`)
  lines.push(
    "UNKNOWN IGNORED (present in the workspace, missing in worktrees):"
  )
  for (const p of facts.unknownIgnored.slice(0, 40))
    lines.push(`- ${p} [${add(`${p} exists and is ignored`, p)}]`)
  lines.push("GENERATED WITHOUT COMMAND:")
  for (const g of facts.generated.filter((g) => !g.command).slice(0, 20))
    lines.push(
      `- key=${g.key} paths=${g.paths.join(", ")} [${add(`${g.paths.join(", ")}: ${g.evidence.map((e) => e.label).join("; ")}`, g.paths[0])}]`
    )
  lines.push("ECOSYSTEMS WITHOUT A RECIPE:")
  for (const u of facts.unsupported)
    lines.push(
      `- ${u.ecosystem}: ${u.file} [${add(`${u.file} exists`, u.file)}]`
    )
  lines.push("EVIDENCE FILES (excerpts):")
  for (const excerpt of facts.excerpts) {
    const id = add(`${excerpt.path} (excerpt)`, excerpt.path)
    lines.push(`--- ${excerpt.path} [${id}] ---`)
    lines.push(excerpt.text)
  }
  lines.push("EVIDENCE:")
  for (const item of evidence.values()) lines.push(`${item.id}: ${item.text}`)
  return { user: lines.join("\n").slice(0, 60_000), evidence }
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start)
    throw new Error("The model didn't return JSON.")
  return JSON.parse(text.slice(start, end + 1))
}

const CATEGORIES: FindingCategory[] = [
  "toolchain",
  "main-environment",
  "worktree-environment",
  "generated-files",
  "local-config",
  "database",
]

const str = (v: unknown, max = 400) =>
  typeof v === "string" ? v.trim().slice(0, max) : ""

export async function interpret(input: {
  facts: AnalysisFacts
  drafts: FindingDraft[]
  intent: string
  workspace: string
  complete: Complete
  signal: AbortSignal
}): Promise<InterpretResult> {
  const { user, evidence } = buildPrompt(
    input.facts,
    input.drafts,
    input.intent
  )
  const nothingToDo =
    !input.facts.unknownIgnored.length &&
    !input.facts.generated.some((g) => !g.command) &&
    !input.facts.unsupported.length &&
    !input.facts.excerpts.length
  const empty: InterpretResult = {
    drafts: [],
    generatedCommands: [],
    explanations: {},
    rejected: [],
  }
  if (nothingToDo) return empty
  const raw = await input.complete(SYSTEM, user, input.signal)
  const parsed = extractJson(raw) as Record<string, unknown>
  const result: InterpretResult = { ...empty, rejected: [] }
  const cite = (
    ids: unknown
  ): Array<{ kind: "doc" | "file"; label: string; path?: string }> =>
    (Array.isArray(ids) ? ids : [])
      .map((id) => evidence.get(String(id)))
      .filter((e): e is EvidenceItem => !!e)
      .map((e) => ({
        kind:
          e.path && /README|workflows|Makefile|justfile/i.test(e.path)
            ? "doc"
            : "file",
        label: e.text,
        ...(e.path ? { path: e.path } : {}),
      }))
  const reject = (title: string, reason: string) =>
    result.rejected.push({ title: title || "(untitled)", reason })
  const unknown = new Set(input.facts.unknownIgnored)
  const knownKeys = new Set(input.drafts.map((d) => d.key))

  for (const item of Array.isArray(parsed.ignored) ? parsed.ignored : []) {
    const entry = item as Record<string, unknown>
    const p = str(entry.path, 300).replace(/\/$/, "")
    const title = `Classify ${p}`
    if (!unknown.has(p)) {
      reject(title, "not one of the unknown ignored paths")
      continue
    }
    const ev = cite(entry.evidence)
    if (!ev.length) {
      reject(title, "no evidence cited")
      continue
    }
    const reason = str(entry.reason, 300)
    const root = input.facts.ignored.find((e) => e.path === p)?.root ?? ""
    if (entry.action === "ignore") continue
    if (entry.action === "link") {
      if (!checkRelativePath(p).ok) {
        reject(title, "path leaves the workspace")
        continue
      }
      result.drafts.push({
        key: `worktree-env:model:${p}`,
        category: "worktree-environment",
        severity: "info",
        title: `New worktrees won't have ${p}`,
        explanation: `${reason || `${p} is ignored, so worktrees start without it.`} Link it from this checkout if agents need it.`,
        evidence: ev,
        confidence: "guess",
        source: "model",
        root,
        fix: {
          kind: "apply-settings",
          summary: `Link ${p} into each worktree`,
          patch: { worktreeLinkPaths: { add: [p] } },
        },
      })
      continue
    }
    if (entry.action === "setup") {
      const setup = (entry.setup ?? {}) as Record<string, unknown>
      const command = str(setup.command, 300)
      const cwd = str(setup.cwd, 200).replace(/^\.\/?/, "")
      const cwdOk = checkRelativePath(cwd)
      const verdict = cwdOk.ok
        ? checkSetupCommand(command, path.join(input.workspace, cwd))
        : cwdOk
      if (!verdict.ok) {
        reject(title, `setup command rejected: ${verdict.reason}`)
        continue
      }
      result.drafts.push({
        key: `worktree-env:model:${p}`,
        category: "worktree-environment",
        severity: "info",
        title: `New worktrees won't have ${p}`,
        explanation: `${reason || `${p} is ignored, so worktrees start without it.`} Each worktree can build its own.`,
        evidence: ev,
        confidence: "guess",
        source: "model",
        root,
        fix: {
          kind: "apply-settings",
          summary: `Run \`${command}\` in each new worktree`,
          patch: {
            worktreeSetupSteps: {
              add: [
                {
                  id: `analysis:model:${p}`,
                  label: str(setup.label, 80) || `Prepare ${p}`,
                  command,
                  cwd,
                },
              ],
            },
          },
        },
      })
      continue
    }
    reject(title, "unknown action")
  }

  for (const item of Array.isArray(parsed.generated) ? parsed.generated : []) {
    const entry = item as Record<string, unknown>
    const key = str(entry.key, 300)
    const command = str(entry.command, 300)
    const title = `Regeneration command for ${key}`
    const group = input.facts.generated.find((g) => g.key === key && !g.command)
    if (!group) {
      reject(title, "not a generated group without a command")
      continue
    }
    const ev = cite(entry.evidence)
    if (!ev.length) {
      reject(title, "no evidence cited")
      continue
    }
    const verdict = checkGeneratedCommand(command, input.workspace)
    if (!verdict.ok) {
      reject(title, `command rejected: ${verdict.reason}`)
      continue
    }
    result.generatedCommands.push({
      key,
      command,
      evidence: ev.map((e) => e.label).join("; "),
    })
  }

  for (const item of Array.isArray(parsed.findings) ? parsed.findings : []) {
    const entry = item as Record<string, unknown>
    const title = str(entry.title, 140)
    const category = entry.category as FindingCategory
    if (!title) {
      reject("(untitled)", "missing title")
      continue
    }
    if (!CATEGORIES.includes(category)) {
      reject(title, "unknown category")
      continue
    }
    const ev = cite(entry.evidence)
    if (!ev.length) {
      reject(title, "no evidence cited")
      continue
    }
    const fixIn = (entry.fix ?? {}) as Record<string, unknown>
    let fix: Finding["fix"] | null = null
    if (fixIn.kind === "manual") {
      const steps = (Array.isArray(fixIn.steps) ? fixIn.steps : [])
        .map((s) => str(s, 300))
        .filter(Boolean)
        .slice(0, 6)
      if (steps.length)
        fix = { kind: "manual", summary: "Do this by hand", steps }
    } else if (fixIn.kind === "setup-step") {
      const command = str(fixIn.command, 300)
      const cwd = str(fixIn.cwd, 200).replace(/^\.\/?/, "")
      const cwdOk = checkRelativePath(cwd)
      const verdict = cwdOk.ok
        ? checkSetupCommand(command, path.join(input.workspace, cwd))
        : cwdOk
      if (!verdict.ok) {
        reject(title, `setup command rejected: ${verdict.reason}`)
        continue
      }
      fix = {
        kind: "apply-settings",
        summary: `Run \`${command}\` in each new worktree`,
        patch: {
          worktreeSetupSteps: {
            add: [
              {
                id: `analysis:model:${title.slice(0, 40)}`,
                label: str(fixIn.label, 80) || title,
                command,
                cwd,
              },
            ],
          },
        },
      }
    } else if (fixIn.kind === "generated-rule") {
      const paths = (Array.isArray(fixIn.paths) ? fixIn.paths : [])
        .map((p) => str(p, 200))
        .filter(Boolean)
      const command = str(fixIn.command, 300)
      const badGlob = paths
        .map((p) => [p, checkGlob(p)] as const)
        .find(([, v]) => !v.ok)
      const verdict = checkGeneratedCommand(command, input.workspace)
      if (!paths.length || badGlob || !verdict.ok) {
        reject(
          title,
          badGlob
            ? `glob ${badGlob[0]} rejected: ${badGlob[1].reason}`
            : `command rejected: ${verdict.reason ?? "no paths"}`
        )
        continue
      }
      fix = {
        kind: "apply-settings",
        summary: `Regenerate with \`${command}\` after merging`,
        patch: { generatedFiles: { add: [{ paths, command }] } },
      }
    }
    if (!fix) {
      reject(title, "no usable fix")
      continue
    }
    const severity: FindingSeverity =
      entry.severity === "warning" ? "warning" : "info"
    result.drafts.push({
      key: `model:${category}:${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 60)}`,
      category,
      severity,
      title,
      explanation: str(entry.explanation, 500),
      evidence: ev,
      confidence: entry.confidence === "likely" ? "likely" : "guess",
      source: "model",
      fix,
    })
  }

  const explanations = (parsed.explanations ?? {}) as Record<string, unknown>
  for (const [key, text] of Object.entries(explanations)) {
    const value = str(text, 300)
    if (knownKeys.has(key) && value) result.explanations[key] = value
  }
  return result
}
