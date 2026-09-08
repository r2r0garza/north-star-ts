# PR71: Inspectable Process approvals

> Status: **DONE**. Turn Process approval gates into self-contained review
> checkpoints: a concise completion explanation by default, with an in-app detail
> drawer for plans, artifacts, diffs, validation evidence, and the worker transcript.

## Problem

A Process can correctly pause after an approval-gated phase, but the decision surface
does not carry enough evidence to make the decision comfortably. The gate card says
that the phase is done and offers **Approve**, **Deny**, and **Request changes**. The
user must then reconstruct what happened from several separate affordances:

- changed-file chips with small hover previews;
- the phase worker's transcript;
- files opened in an external IDE by the Process monitor's current **Review all**
  behavior; and
- any validation output buried in tool calls or the final agent response.

That makes the least informed action—the approval click—the easiest action. A useful
human gate should instead put the decision and its evidence in the same place.

The review also cannot depend on knowing that a phase is a "planning phase" or an
"implementation phase." Processes are user-authored, names are unconstrained, a phase
may produce both prose and code, and sub-processes can introduce definitions the parent
does not understand. Classification would be heuristic and eventually wrong.

## Product decision

Use **progressive disclosure with an evidence-driven detail view**:

1. Every pending phase approval shows the same bounded completion explanation.
2. **View details** opens an in-app split-pane/drawer without leaving the run monitor.
3. The drawer prioritizes the evidence the phase actually produced rather than a
   declared or inferred phase type.
4. Approval actions remain visible while the user reviews that evidence.

The concise explanation answers, at minimum:

- What outcome did this phase produce?
- What materially changed or was decided?
- What checks were performed?
- What remains uncertain or needs attention?
- What work will approval release next?

This explanation is a review aid, not evidence by itself. The detail view must always
make its supporting artifacts and provenance reachable.

## Experience

### Compact gate card

Replace the current one-line gate prompt with a compact approval summary:

```text
┌─ Ready for approval: Define implementation plan ────────────────┐
│ Produced a six-step implementation plan covering persistence,   │
│ IPC, renderer state, and focused tests. Two rollout questions    │
│ remain open; no source files were changed.                       │
│                                                                 │
│ 1 document · 2 open questions                 [View details]     │
│                                                                 │
│ [Request changes] [Deny]                            [Approve]     │
└─────────────────────────────────────────────────────────────────┘
```

For a code-producing phase, the same shell might read:

```text
Implemented the approval persistence path and renderer recovery state. Changed
5 files; 18 focused tests and typecheck passed. No known issues were reported.

5 files · 18 tests passed · typecheck passed       [View details]
```

The summary should be short enough to scan in the run monitor: approximately three
sentences plus evidence counts. It must not hide failed checks, missing evidence,
truncated output, or reported caveats behind **View details**.

### Approval review drawer

**View details** opens a roomy drawer or split pane beside the still-visible Process
run. It does not navigate away from the run or require an IDE.

The drawer contains:

1. **Overview** — the completion explanation, phase/agent identity, timing, rework
   round, and the downstream phases that approval will release.
2. **Artifacts** — files and other durable outputs attributed to the phase.
3. **Validation** — tests, diagnostics, builds, validator findings, and their actual
   status. Failures and unavailable evidence are visually distinct from success.
4. **Activity** — the existing read-only worker transcript as the complete audit
   trail, available without making it the default reading experience.

The right/detail side shows the selected evidence:

- Markdown and other readable planning/document artifacts render as documents, with
  a **Diff** toggle when a meaningful patch exists.
- Source files show the full in-app diff, reusing the existing diff renderer.
- HTML artifacts may use the existing sandboxed preview.
- Validation entries show the command/tool, scope, result, duration when available,
  and bounded output.
- Transcript selection shows the existing `TaskTranscriptSheet` content in the
  review surface or composes that component without duplicating transcript logic.

A sticky footer keeps **Request changes**, **Deny**, and **Approve** visible. Requesting
changes accepts feedback in the same drawer and sends it through the existing bounded
rework path. Closing the drawer does not resolve the gate.

### Evidence-driven ordering

Do not add a required `phaseType` field and do not infer behavior solely from phase
names. Populate and order the drawer from observed evidence:

- If the phase produced one or more documents, open the primary document first.
- Otherwise, if it changed source files, open the most relevant diff first.
- Otherwise, if it produced validation or structured findings, open those findings.
- Otherwise, open the completion explanation and make the transcript prominent.

All other evidence remains available in the same drawer. A phase that writes a plan
and a prototype naturally exposes both.

## Approval packet

Create a durable, immutable review snapshot associated with each individual approval
request. A fresh packet is produced after every request-changes/rework round so the
user never reviews stale evidence under a new gate.

Likely shape:

```ts
interface ProcessApprovalPacket {
  requestId: string
  processRunId: string
  phaseRunId: string
  reworkRound: number
  createdAt: number

  summary: {
    outcome: string
    materialChanges: string[]
    validationSummary: string
    caveats: string[]
  }

  artifacts: ApprovalArtifact[]
  validations: ApprovalValidation[]
  downstream: Array<{ phaseId: string; name: string }>
  evidenceWarnings: string[]
  transcriptTaskId: string | null
}
```

The exact storage may be a dedicated table or a versioned blob referenced by the
durable approval row. Whichever representation is chosen must support:

- crash/restart restoration of the same packet and gate;
- historical inspection after the approval is resolved;
- multiple approval packets for successive rework rounds;
- nested sub-process and fan-out phase-run identities; and
- bounded payloads, with large content fetched through existing file/diff/transcript
  APIs rather than duplicated into SQLite.

### Completion explanation generation

At phase completion, build a bounded structured explanation from the phase objective,
worker final response, recorded tool activity, artifacts, and validation records. The
generation step may summarize; it may not invent tests, files, or outcomes that are
not present in recorded evidence.

Prefer deterministic facts for counts and statuses. For example, the application—not
the summarizing model—should compute "5 files changed" and "18 tests passed." The model
may explain why those changes matter and identify caveats from the worker's result.

If summary generation fails, the approval gate still works. Render a deterministic
fallback containing the phase name, available artifacts, validation states, and a link
to the transcript. An unavailable explanation must never block or silently auto-approve
the run.

## Evidence provenance and trust

The existing Process file chips derive changed paths from the worker conversation's
tool calls, while the displayed Git diff is the workspace's current state relative to
the last commit. In a shared dirty workspace—or when parallel phases touch the same
file—that diff is not necessarily the exact patch authored by the phase.

The review UI must distinguish:

- **Phase-attributed evidence** — directly recorded against this worker/phase, such as
  a native file mutation's captured patch, an artifact explicitly written by the
  worker, or a structured test result produced by the worker.
- **Workspace evidence** — current file/diff state that is relevant but cannot be
  proven to belong exclusively to this phase.

Never label a current workspace diff as "changes made by this phase" unless provenance
supports that claim. Show a concise warning when evidence may include overlapping or
subsequent edits.

For v1, reuse available tool-call attribution and current Git diffs with honest labels.
Where native mutation tools already expose bounded before/after diffs, retain or link
those records to the phase task so the drawer can show a phase-attributed patch.
External CLI providers and broad shell commands may initially fall back to workspace
evidence plus transcript provenance. Reliable attribution for concurrent arbitrary
filesystem mutation may eventually require stronger per-phase snapshots or isolation;
that is not a prerequisite for delivering the in-app review experience.

## Runtime flow

1. A phase worker finishes.
2. Main gathers deterministic evidence from the phase task, messages/tool records,
   artifact paths, structured validation results, and graph dependents.
3. Main creates the bounded completion explanation and persists the approval packet.
4. The scheduler creates/raises the durable approval request referencing that packet.
5. The monitor renders the compact packet summary and can open the detail drawer.
6. Approve/deny/request-changes resolve the existing durable gate semantics.
7. Request changes preserves the reviewed packet, increments the rework round, reruns
   the worker with feedback, and produces a new packet before the next gate.

Packet creation and gate creation must be ordered transactionally or made idempotent so
a crash cannot leave a pending approval with the wrong round's evidence. Recovery must
reuse an existing matching packet rather than ask a model to regenerate a possibly
different summary.

## Renderer integration

Build on the current Process monitor rather than adding a separate review destination:

- Extend `GateCard` with the bounded summary, evidence counts, warnings, and
  **View details**.
- Add one review-drawer state at the `RunMonitor` level so top-level, fan-out, and
  nested sub-process gates open the same surface.
- Reuse `DiffView`, the safe HTML preview behavior, changed-file metadata, and the
  read-only transcript components.
- Change Process **Review all** from "open every file in the IDE" to opening the
  in-app drawer scoped to the phase. Keep an explicit **Open in editor** action for
  users who want it.
- Preserve the run monitor and selected phase while the drawer is open.
- Support keyboard review without making Enter approve while focus is inside the
  drawer, a document, diff, transcript, or feedback field.

## Delivery split

### 071.1 — In-app review surface using existing evidence

- Approval drawer/split pane and compact gate summary shell.
- Document preview, full file diffs, validation/tool evidence, and transcript access.
- Existing evidence sources with accurate phase-attributed/workspace labels.
- Sticky approval/rework controls and nested/fan-out gate support.
- Process **Review all** routes into the drawer; IDE opening remains explicit.

This slice removes the forced IDE detour even before generated explanations are
durable.

### 071.2 — Durable approval packets and bounded explanations

- Packet persistence/versioning and preload/IPC types.
- Deterministic evidence aggregation and downstream impact.
- Bounded structured explanation with a deterministic fallback.
- Rework-round history, recovery/idempotency, and resolved-gate inspection.

### 071.3 — Stronger phase-attributed evidence

- Retain/link native mutation patches and structured validation records by phase task.
- Provenance badges and overlap/staleness warnings.
- Evaluate snapshot or isolation requirements for external CLI/shell mutations based
  on real gaps observed after 071.1/071.2.

## Verification

- A user can understand and resolve a pending gate without opening an IDE or browsing
  the workspace manually.
- Every gate presents a concise explanation or deterministic fallback before approval.
- A document-producing phase opens its primary rendered artifact by default.
- A code-producing phase opens a full in-app diff by default.
- A mixed-output phase exposes documents, diffs, validation, and transcript together.
- No authored `phaseType` or name heuristic is required for correct behavior.
- Failed, missing, stale, truncated, and workspace-scoped evidence is never presented
  as verified phase success.
- Approving explains which downstream phases will be released.
- Request changes creates a new packet for the new round while preserving history.
- Restart restores the same pending packet and gate without regenerating the summary.
- Top-level, fan-out child, validator-exhaustion, and nested sub-process gates open the
  correct phase-run review.
- Keyboard interaction cannot accidentally approve while the user is reviewing or
  writing feedback.
- Focused repository/service/IPC/renderer tests, `pnpm typecheck`, and `pnpm build`
  pass.

## Out of scope

- Requiring Process authors to classify phases as planning or implementation.
- Replacing the full worker transcript or external IDE integration.
- Treating an LLM-generated summary as proof that work is correct.
- Automatically approving based on tests, validator results, or summary confidence.
- Solving arbitrary concurrent filesystem attribution through per-phase worktrees in
  the first delivery slice.
- Changing the existing Process gate/rework policy itself.

## Open questions before implementation

1. Should the drawer occupy a fixed side width, be resizable, or take over the main
   panel at narrow widths? Lean resizable on desktop and main-panel takeover when the
   run monitor would otherwise become unusable.
2. How should a phase identify its "primary" artifact? Lean explicit worker metadata
   when available, falling back deterministically to document-first evidence ordering.
3. Should resolved approval packets remain reachable from every completed phase or
   only from run history? Lean keep them on the phase as the review/audit history.
4. Which validation tool records are structured enough for the first slice? Start with
   native `run_tests`/diagnostics plus clearly labeled command evidence; do not parse
   arbitrary transcript prose into a green checkmark.
5. Is a generated explanation created by the phase worker itself or by a separate
   bounded summarization call? Lean deterministic evidence aggregation plus a separate
   bounded explanation step, so the worker cannot self-report unverified counts and a
   failed summary has a clean fallback.
