import type { ProcessPhase } from "../../db/types"

// Kickoff builders for a Process phase (plan 025). A phase runs in its OWN forked
// worker conversation (like a subagent), so it cannot see the orchestrator's
// conversation — the kickoff must be self-contained: the run objective, this
// phase's role, and a digest of what upstream phases produced.

export interface UpstreamResult {
  phaseName: string
  // The upstream phase's stable key (unique per process) — the flag_for_rework
  // target vocabulary (plan 031.2). Display names can collide; keys don't.
  phaseKey: string
  // The upstream phase's final assistant content (its "output"), possibly null.
  content: string | null
}

// The "Phases you may flag for rework" section (plan 031.2): lists the upstream
// phases by KEY so a worker that finds an upstream-owned defect can name a valid
// flag_for_rework target. Returns "" when there's nothing upstream to flag.
function flagForReworkSection(upstream: UpstreamResult[]): string {
  if (upstream.length === 0) return ""
  const lines: string[] = []
  lines.push("## Phases you may flag for rework")
  lines.push(
    "If you find a defect that one of the EARLIER phases below owns, do NOT fix it " +
      "yourself — call `flag_for_rework` with that phase's key and a specific reason. " +
      "The engine will re-run that phase (and everything built on it). Prefer completing " +
      "your own work when the issue is yours to fix."
  )
  lines.push(
    "Problems with your own setup are yours, not a defect to flag: your test harness " +
      "and test config, ports, timeouts, a run that was killed or never finished. Fix " +
      "them within your own lane. Flag only with concrete evidence about the earlier " +
      "phase's output: the check you ran and what it observed."
  )
  lines.push(
    "Work your own phase owns is never a flag either: writing or extending tests, " +
      "and correcting your own report or verification notes. Do it yourself."
  )
  lines.push(
    "Call `flag_for_rework` only to ask for a specific change. If you conclude " +
      "that no rework is needed, do not call it: every flag re-runs that phase and " +
      "everything after it, and a run may raise only a limited number of flags. " +
      "If a flag is refused because that limit is reached and a real defect " +
      "remains, report it as unresolved; do not report your phase as complete."
  )
  for (const u of upstream) lines.push(`- \`${u.phaseKey}\` — ${u.phaseName}`)
  return lines.join("\n")
}

// The message seeded into a phase's worker conversation. Deliberately plain: the
// agent's own .agent.md body is the system prompt; this is the task briefing.
// Every Process worker runs headless: no ask_user_question tool, and nobody reads
// its final message live. Without saying so, models end with "want me to …?"
// offers that can never be answered. Appended to every worker briefing.
export const UNATTENDED_WORK_NOTE =
  "## Working unattended\n" +
  "No one will reply to you during this phase, and your final message is not " +
  "read as a conversation. Do not ask questions or offer optional follow-ups " +
  "(\"should I…?\", \"say the word and I'll…\"). Make reasonable decisions, do " +
  "everything your task asks, and state any assumptions in your final summary."

// The phase's own instructions (when set), the richer task text behind its name.
function phaseInstructionLines(phase: ProcessPhase): string[] {
  const text = phase.instructions?.trim()
  return text ? [text, ""] : []
}

export function kickoffPrompt(input: {
  phase: ProcessPhase
  objective: string
  upstream: UpstreamResult[]
  // A reviewer's "Request changes" feedback (plan 029): when this phase was
  // gated and sent back, the note is surfaced so the re-run addresses it.
  reworkNote?: string
  // Set when reworkNote came from a flag: this phase raised it ("flagger") or
  // was its target ("flagged"). Unset keeps the reviewer framing.
  reworkSource?: "flagger" | "flagged"
}): string {
  const { phase, objective, upstream, reworkNote, reworkSource } = input
  const lines: string[] = []
  lines.push(`# Process phase: ${phase.name}`)
  lines.push("")
  lines.push("You are executing one phase of a larger multi-phase process.")
  lines.push("")
  lines.push("## Overall objective")
  lines.push(objective.trim() || "(no objective provided)")
  lines.push("")
  if (upstream.length > 0) {
    lines.push("## Output of the phases that ran before you")
    for (const u of upstream) {
      lines.push(`### ${u.phaseName}`)
      lines.push(u.content?.trim() || "(no textual output)")
      lines.push("")
    }
  }
  if (reworkNote?.trim()) {
    if (reworkSource === "flagger") {
      lines.push("## Your earlier rework request")
      lines.push(
        "You previously identified these defects and requested upstream rework. " +
          "Re-evaluate the current implementation. Do not request rework for " +
          "findings that have been resolved."
      )
    } else if (reworkSource === "flagged") {
      lines.push("## Requested changes")
      lines.push(
        "A downstream phase identified defects in your previous work. Address " +
          "the following findings."
      )
    } else {
      lines.push("## Requested changes")
      lines.push(
        "A reviewer looked at your previous attempt at this phase and asked for " +
          "changes. Address this feedback before you finish:"
      )
    }
    lines.push("")
    lines.push(reworkNote.trim())
    lines.push("")
  }
  lines.push("## Your task")
  lines.push(...phaseInstructionLines(phase))
  lines.push(
    `Carry out the "${phase.name}" phase toward the overall objective. When done, ` +
      `summarize what you produced so the next phase can build on it.`
  )
  lines.push("")
  lines.push(UNATTENDED_WORK_NOTE)
  const flag = flagForReworkSection(upstream)
  if (flag) {
    lines.push("")
    lines.push(flag)
  }
  const dotFolder = dotFolderInstruction(phase)
  if (dotFolder) {
    lines.push("")
    lines.push(dotFolder)
  }
  return lines.join("\n")
}

// An optional artifact-location instruction (plan 030). When a phase has its
// dot-folder toggle on, steer its agent to write files under a `.<key>/` folder
// at the workspace root — a predictable location the run monitor's file chips
// and downstream phases can rely on. A convention (agent-followed), not enforced.
// Returns "" when the toggle is off.
function dotFolderInstruction(phase: ProcessPhase): string {
  if (!phase.dotFolder) return ""
  return (
    `## Where to write files\n` +
    `Write any files you create for this phase under a \`.${phase.key}/\` folder ` +
    `at the root of the workspace (create it if it doesn't already exist), so ` +
    `this phase's artifacts have a predictable location.`
  )
}

// The kickoff for an `on_each_subtask` consumer instance (plan 025.2). A phase V
// joined to a fan-out phase C by an `on_each_subtask` edge runs ONCE PER completed
// C sub-task — this briefing carries that single sub-task's output (not the whole
// phase's aggregate) so V works on exactly the piece that just landed. Like
// kickoffPrompt, it's self-contained (the worker can't see the orchestrator).
export function eachSubtaskKickoffPrompt(input: {
  phase: ProcessPhase
  objective: string
  sourcePhaseName: string
  // The source fan-out phase's key — the flag_for_rework target if this sub-task's
  // input turns out to be defective (plan 031.2). Optional (older callers omit it).
  sourcePhaseKey?: string
  // The triggering sub-task's final output (its worker's last assistant message).
  subtaskContent: string | null
}): string {
  const { phase, objective, sourcePhaseName, sourcePhaseKey, subtaskContent } =
    input
  const lines: string[] = []
  lines.push(`# Process phase: ${phase.name}`)
  lines.push("")
  lines.push(
    "You are executing one phase of a larger multi-phase process. You are being " +
      `run on a SINGLE sub-task produced by the "${sourcePhaseName}" phase — not ` +
      "its whole output. Focus only on the piece below."
  )
  lines.push("")
  lines.push("## Overall objective")
  lines.push(objective.trim() || "(no objective provided)")
  lines.push("")
  lines.push(`## The "${sourcePhaseName}" sub-task to act on`)
  lines.push(subtaskContent?.trim() || "(no textual output)")
  lines.push("")
  lines.push("## Your task")
  lines.push(...phaseInstructionLines(phase))
  lines.push(
    `Carry out the "${phase.name}" phase for this one sub-task toward the overall ` +
      `objective. When done, summarize what you produced.`
  )
  lines.push("")
  lines.push(UNATTENDED_WORK_NOTE)
  if (sourcePhaseKey) {
    lines.push("")
    lines.push(
      flagForReworkSection([
        { phaseName: sourcePhaseName, phaseKey: sourcePhaseKey, content: null },
      ])
    )
  }
  const dotFolder = dotFolderInstruction(phase)
  if (dotFolder) {
    lines.push("")
    lines.push(dotFolder)
  }
  return lines.join("\n")
}

// Upper bound on the number of sub-tasks a fan-out phase may spawn (plan 025.1,
// Open Q #3 — agent-decided but bounded, to prevent runaway spawning). A plan
// with more assignments is rejected, not truncated: truncating drops work.
export const MAX_FAN_OUT = 8

// An agent the fan-out planner may assign work to: a pool agent or a seat.
export interface PlannerAgentOption {
  name: string
  description: string
}

// The kickoff for a FAN-OUT phase's planning pass (plan 025.1). The built-in
// planner lists every work item of the round, then assigns each to exactly one
// worker with an agent and the files it owns, as ONE JSON object (parsePlan /
// validatePlan). Each assignment becomes a child phase-run with its own worker.
// Self-contained like kickoffPrompt (the planner can't see the orchestrator).
export function fanOutDecomposePrompt(input: {
  phase: ProcessPhase
  objective: string
  upstream: UpstreamResult[]
  // The agents assignments may name; empty when the phase has no agent pool.
  agents: PlannerAgentOption[]
  // A direct flag_for_rework reason, reviewer note, or generic downstream
  // re-check note stamped on the container phase-run before re-decomposition.
  reworkNote?: string
}): string {
  const { phase, objective, upstream, agents, reworkNote } = input
  const rework = !!reworkNote?.trim()
  const lines: string[] = []
  lines.push(`# Process phase (fan-out): ${phase.name}`)
  lines.push("")
  lines.push(
    "You are planning one phase of a larger multi-phase process. This phase " +
      "FANS OUT: instead of doing the work yourself, split it into assignments " +
      "that will each run in parallel in their own worker."
  )
  lines.push("")
  lines.push("## Overall objective")
  lines.push(objective.trim() || "(no objective provided)")
  lines.push("")
  if (upstream.length > 0) {
    lines.push("## Output of the phases that ran before you")
    for (const u of upstream) {
      lines.push(`### ${u.phaseName}`)
      lines.push(u.content?.trim() || "(no textual output)")
      lines.push("")
    }
  }
  if (rework) {
    lines.push("## Requested changes")
    lines.push(
      "This fan-out phase is being planned again because prior work was sent " +
        "back or upstream input changed. Each sub-task worker also receives this " +
        "feedback verbatim with its briefing:"
    )
    lines.push("")
    lines.push(reworkNote!.trim())
    lines.push("")
  }
  if (agents.length > 0) {
    lines.push("## Available agents")
    for (const a of agents)
      lines.push(`- \`${a.name}\`${a.description ? ` — ${a.description}` : ""}`)
    lines.push("")
  }
  lines.push("## Your task")
  lines.push(...phaseInstructionLines(phase))
  lines.push(
    `Plan the "${phase.name}" phase. You may inspect the workspace first to ` +
      "decide the split."
  )
  lines.push("")
  lines.push(
    rework
      ? "1. List the work items (reported defects) for this round: every defect " +
          "or requested change in the feedback above, plus any earlier requirement " +
          "it touches. Give each a short id (F1, F2, …) and a one-line summary."
      : "1. List the work items (requirements) for this round: every distinct " +
          "requirement or deliverable in the objective, the phase instructions and " +
          "the earlier phases' output. Give each a short id (F1, F2, …) and a " +
          "one-line summary."
  )
  lines.push(
    "2. Group the items into assignments. Each item goes to EXACTLY ONE " +
      "assignment: never drop an item, never give one item to two assignments."
  )
  lines.push(
    "3. Give each assignment the files and directories it will write (plain " +
      "workspace-relative paths, no globs). Two assignments must never write the " +
      "same file or anything inside a directory the other owns."
  )
  lines.push(
    agents.length > 0
      ? "4. Give each assignment the name of one available agent, chosen by its description."
      : '4. Set each assignment\'s "agent" to null (this phase has no agent pool).'
  )
  lines.push(
    "If the work cannot be split without workers writing the same files, return " +
      `a SINGLE assignment holding every item. Use at most ${MAX_FAN_OUT} assignments.`
  )
  lines.push("")
  lines.push(
    "Each assignment's \"task\" is a complete, self-contained briefing for its " +
      "worker (it cannot see this message or the other assignments)."
  )
  lines.push(
    "When you are done, reply with ONLY one JSON object in this shape. No " +
      "markdown code fences, no prose before or after it:"
  )
  lines.push("")
  lines.push(
    '{"findings": [{"id": "F1", "summary": "Login form rejects valid emails"}], ' +
      '"assignments": [{"agent": ' +
      (agents.length > 0 ? `"${agents[0].name}"` : "null") +
      ', "task": "Fix the email validation in the login form…", ' +
      '"findings": ["F1"], "writes": ["src/renderer/login-form.tsx"]}]}'
  )
  return lines.join("\n")
}

// Corrective coda appended to the planning prompt on a retry (plan: fan-out
// robustness), after a previous attempt's reply failed to parse or validate.
// Names the exact problem so the planner can fix it.
export function decompositionRetryNote(reason: string | null): string {
  return (
    "\n\n## Important\nYour previous plan was rejected" +
    (reason?.trim() ? `: ${reason.trim()}` : ".") +
    " Reply with ONLY the JSON object described above, with every work item " +
    "assigned exactly once and no overlapping write scopes."
  )
}

// One work item the planner listed for the round: a requirement on the first
// round, a reported defect on a rework round.
export interface PlanFinding {
  id: string
  summary: string
}

export interface PlanAssignment {
  agent: string | null
  task: string
  // Ids into FanOutPlan.findings.
  findings: string[]
  // Workspace-relative files/directories this assignment owns.
  writes: string[]
}

export interface FanOutPlan {
  findings: PlanFinding[]
  assignments: PlanAssignment[]
}

const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter(Boolean)
    : []

// Coerce one parsed candidate into a plan, or null if it isn't plan-shaped.
function objectToPlan(parsed: unknown): FanOutPlan | null {
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.assignments) || !Array.isArray(obj.findings))
    return null
  const findings = obj.findings.flatMap((f): PlanFinding[] => {
    if (!f || typeof f !== "object") return []
    const { id, summary } = f as Record<string, unknown>
    return typeof id === "string" && id.trim()
      ? [
          {
            id: id.trim(),
            summary: typeof summary === "string" ? summary.trim() : "",
          },
        ]
      : []
  })
  const assignments = obj.assignments.flatMap((a): PlanAssignment[] => {
    if (!a || typeof a !== "object") return []
    const r = a as Record<string, unknown>
    return [
      {
        agent:
          typeof r.agent === "string" && r.agent.trim() ? r.agent.trim() : null,
        task: typeof r.task === "string" ? r.task.trim() : "",
        findings: strings(r.findings),
        writes: strings(r.writes),
      },
    ]
  })
  return { findings, assignments }
}

// Extract the plan object from the planner's final message, tolerant of a
// fence or prose around it (same scan as parseVerdict). Null on a miss.
export function parsePlan(text: string): FanOutPlan | null {
  return scanJsonObjects(text, objectToPlan)
}

// Workspace-relative path normalised for overlap checks.
// shortcut: anything from the first glob char is cut, so a glob is treated as
// its directory prefix (conservative); upgrade if planners need real globs.
function normalizeScope(p: string): string {
  return p
    .replace(/[*?[{].*$/, "")
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "")
}

function scopesOverlap(a: string, b: string): boolean {
  if (a === "" || b === "") return true // the workspace root owns everything
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

// Checks a parsed plan before any child is created. Returns the problem as a
// message the planner can act on, or null when the plan is sound: every work
// item assigned exactly once, known agents, and no two assignments writing
// overlapping paths. `agentNames` empty means the phase has no pool.
export function validatePlan(
  plan: FanOutPlan,
  agentNames: string[]
): string | null {
  const { findings, assignments } = plan
  if (findings.length === 0) return "the plan lists no work items (findings)"
  if (assignments.length === 0) return "the plan has no assignments"
  if (assignments.length > MAX_FAN_OUT)
    return `the plan has ${assignments.length} assignments; the limit is ${MAX_FAN_OUT}`
  const ids = new Set<string>()
  for (const f of findings) {
    if (ids.has(f.id)) return `work item id "${f.id}" is listed twice`
    ids.add(f.id)
  }
  const owner = new Map<string, number>()
  for (const [i, a] of assignments.entries()) {
    const n = i + 1
    if (!a.task) return `assignment ${n} has no task`
    if (a.findings.length === 0) return `assignment ${n} covers no work items`
    if (agentNames.length > 0 && !(a.agent && agentNames.includes(a.agent)))
      return `assignment ${n} names agent "${a.agent ?? ""}", which is not one of: ${agentNames.join(", ")}`
    for (const id of a.findings) {
      if (!ids.has(id))
        return `assignment ${n} references work item "${id}", which is not in findings`
      const prev = owner.get(id)
      if (prev !== undefined)
        return `work item "${id}" is assigned to both assignment ${prev} and assignment ${n}`
      owner.set(id, n)
    }
  }
  const missing = findings.filter((f) => !owner.has(f.id)).map((f) => f.id)
  if (missing.length > 0)
    return `work items not assigned to any assignment: ${missing.join(", ")}`
  for (let i = 0; i < assignments.length; i++)
    for (let j = i + 1; j < assignments.length; j++)
      for (const a of assignments[i].writes)
        for (const b of assignments[j].writes)
          if (scopesOverlap(normalizeScope(a), normalizeScope(b)))
            return `assignments ${i + 1} and ${j + 1} both write "${a}"${a === b ? "" : ` / "${b}"`}`
  return null
}

// One validated assignment as its worker's briefing: the task, the work items it
// owns, and its write scope.
export function assignmentBriefing(
  plan: FanOutPlan,
  assignment: PlanAssignment
): string {
  const byId = new Map(plan.findings.map((f) => [f.id, f.summary]))
  const lines = [assignment.task, "", "## Work items you own"]
  for (const id of assignment.findings)
    lines.push(`- ${id}: ${byId.get(id) || "(no summary)"}`)
  lines.push("")
  lines.push("## Files you own")
  if (assignment.writes.length > 0) {
    lines.push(
      "Other workers are changing other files at the same time. Modify only " +
        "these; if you need to change anything else, say so in your summary instead."
    )
    for (const w of assignment.writes) lines.push(`- \`${w}\``)
  } else {
    lines.push(
      "None: this assignment should not modify files. If it needs to, say so in " +
        "your summary instead."
    )
  }
  return lines.join("\n")
}

// A fan-out sub-task's briefing plus the run's objective. The planner's
// briefing can leave out exact requirements (allowed values, field names), and
// the worker cannot see the planning conversation.
export function withObjective(briefing: string, objective: string): string {
  if (!objective.trim() || briefing.includes("## Overall objective"))
    return briefing
  return (
    `${briefing}\n\n## Overall objective\n` +
    "Your briefing above is your assignment; do only that share. The full " +
    "objective is below for reference: use its exact requirements (names, " +
    "allowed values, rules) wherever your briefing is silent or differs.\n\n" +
    objective.trim()
  )
}

// A re-decomposed sub-task's briefing plus the feedback that sent the phase
// back, verbatim: the planner's rewrite of it can drop items, and the worker
// cannot see the planning conversation.
export function withReworkFeedback(
  briefing: string,
  reworkNote: string | undefined
): string {
  if (!reworkNote?.trim()) return briefing
  return (
    `${briefing}\n\n## Why this work is being redone\n` +
    "This phase was sent back for rework. The full feedback is below; your " +
    "briefing above is your share of it. Make sure your part is addressed, and " +
    "say in your summary which items you fixed.\n\n" +
    reworkNote.trim()
  )
}

// ── validator (plan 031.1) ───────────────────────────────────────────────────

// The kickoff for a phase's VALIDATOR reviewer (plan 031.1). A second agent is
// forked (like the phase's own worker, so it can inspect the workspace/files) and
// asked to judge whether the phase's output meets the objective. It replies with
// ONLY a JSON verdict object — approve, or reject with actionable feedback that
// the engine injects into the phase's re-run kickoff (the 029 rework channel).
// Self-contained like kickoffPrompt (the reviewer can't see the orchestrator).
export function validatorPrompt(input: {
  phase: ProcessPhase
  objective: string
  upstream: UpstreamResult[]
  // The phase worker's final output (its last assistant message).
  phaseOutput: string | null
}): string {
  const { phase, objective, upstream, phaseOutput } = input
  const lines: string[] = []
  lines.push(`# Review the "${phase.name}" phase`)
  lines.push("")
  lines.push(
    "You are a REVIEWER for one phase of a larger multi-phase process. Another " +
      `agent just carried out the "${phase.name}" phase. Your job is to check its ` +
      "work — inspect the workspace and any files it produced — and decide whether " +
      "it satisfies the objective, or whether it must be sent back for changes."
  )
  lines.push("")
  lines.push("## Overall objective")
  lines.push(objective.trim() || "(no objective provided)")
  lines.push("")
  if (upstream.length > 0) {
    lines.push("## Output of the phases that ran before this one")
    for (const u of upstream) {
      lines.push(`### ${u.phaseName}`)
      lines.push(u.content?.trim() || "(no textual output)")
      lines.push("")
    }
  }
  const instructions = phaseInstructionLines(phase)
  if (instructions.length > 0) {
    lines.push("## Phase instructions")
    lines.push(...instructions)
  }
  lines.push(`## What the "${phase.name}" phase reported`)
  lines.push(phaseOutput?.trim() || "(no textual output)")
  lines.push("")
  lines.push("## Your verdict")
  lines.push(
    "Decide if this phase's work is acceptable. Be pragmatic: approve unless there " +
      "is a concrete, fixable problem — do not nitpick style or ask for gold-plating."
  )
  lines.push(
    "When done, reply with ONLY a JSON object — no markdown code fences, no prose " +
      "before or after it. One of:"
  )
  lines.push('  {"approved": true}')
  lines.push(
    '  {"approved": false, "feedback": "<specific, actionable changes the phase must make>"}'
  )
  return lines.join("\n")
}

// A validator reviewer's parsed verdict (plan 031.1). `approved` gates whether the
// phase settles completed; `feedback` (when rejected) is injected into the re-run.
export interface ValidatorVerdict {
  approved: boolean
  feedback?: string
}

// From `text` starting at `from`, find the balanced `}` matching the `{` at
// `from`, tracking string literals so braces inside strings don't miscount.
// Returns the index of the closing `}`, or -1 if unbalanced.
function matchBrace(text: string, from: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// Coerce one parsed candidate object into a verdict, or null if it carries no
// usable `approved` signal. Accepts a boolean `approved` (or a common string form
// like "yes"/"true"/"approved"); pulls `feedback`/`reason` when rejected.
function objectToVerdict(parsed: unknown): ValidatorVerdict | null {
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  if (!("approved" in obj)) return null
  const raw = obj.approved
  let approved: boolean
  if (typeof raw === "boolean") approved = raw
  else if (typeof raw === "string")
    approved = /^(true|yes|approve|approved|pass|ok)$/i.test(raw.trim())
  else return null
  if (approved) return { approved: true }
  const feedback =
    typeof obj.feedback === "string" && obj.feedback.trim()
      ? obj.feedback.trim()
      : typeof obj.reason === "string" && obj.reason.trim()
        ? obj.reason.trim()
        : undefined
  return { approved: false, feedback }
}

// Tolerant extraction of a validator verdict from the reviewer's final message
// (plan 031.1), mirroring parsePlan: scan every fenced block AND the raw
// text for the first brace-run that JSON-parses into an object carrying an
// `approved` field. Returns null on a genuine miss; callers must treat that as a
// failed review boundary, never as approval.
export function parseVerdict(text: string): ValidatorVerdict | null {
  return scanJsonObjects(text, objectToVerdict)
}

// Scan every fenced block AND the raw text for the first brace-run that
// JSON-parses and that `coerce` accepts. Null on a genuine miss.
function scanJsonObjects<T>(
  text: string,
  coerce: (parsed: unknown) => T | null
): T | null {
  if (!text) return null
  const candidates: string[] = []
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi
  let m: RegExpExecArray | null
  while ((m = fence.exec(text)) !== null) candidates.push(m[1])
  candidates.push(text)

  for (const candidate of candidates) {
    for (
      let start = candidate.indexOf("{");
      start !== -1;
      start = candidate.indexOf("{", start + 1)
    ) {
      const end = matchBrace(candidate, start)
      if (end === -1) break
      let parsed: unknown
      try {
        parsed = JSON.parse(candidate.slice(start, end + 1))
      } catch {
        continue
      }
      const value = coerce(parsed)
      if (value) return value
    }
  }
  return null
}
