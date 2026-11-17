# PR136: Kanban board fed by external work trackers

> Status: 136.1 built 2026-11-12 (`b0ba775`), verified against real GitHub Issues via `gh`. 136.2 built
> 2026-11-12, unit-tested, not yet run in the app. 136.3 built 2026-11-16, unit-tested, not yet run in the
> app or against a live tracker. 136.4 not started. 136.5 built 2026-11-16, unit-tested, not yet run in the app. Open decisions settled 2026-11-12 (see **Decisions**).

## Objective

Let a user bring work items from an external tracker (Azure DevOps, Jira, GitHub Issues, others) onto a North Star
kanban board, have agents work each item column by column, and write a user-defined outcome back to
the tracker when the item leaves the last column.

## The brief, restated

1. **Sources through tools the user already has.** Either a CLI (`az boards`, `jira`, `gh`) or an MCP
   server (ADO MCP, Atlassian MCP, GitHub MCP). North Star never holds tracker credentials; the CLI or MCP server does.
2. **User-defined intake filter.** Multiple tags plus the assignee. E.g. ADO: "tagged `agent-go`
   **and** assigned to me". Without the assignee filter, a shared tag would pull teammates' items onto
   your machine. See **Intake filter** below.
3. **User-defined columns.** Any number, any names, ordered.
4. **Agent per column.** North Star by default on every column; the user may pick a named agent per column.
5. **User-defined exit action.** When an item reaches the end of the board, do something upstream:
   set state `Closed`, set `Ready to Deploy`, add a comment, etc.

## What the brief is missing (the "am I missing something" list)

These are the gaps; each becomes a decision below.

- **What each column asks the agent to do.** An agent alone isn't enough. A column needs instructions
  ("write a plan", "implement", "review") and a definition of done, or every column does the same thing.
- **Who moves the card.** When the agent finishes, does the card auto-advance, or wait for a human to
  approve? Most columns probably want an optional **human gate** (e.g. review before "Done").
- **Failure and blocked states.** An agent run can fail, get stuck, or ask a question. The card needs
  visible `running / waiting on you / failed` states, plus retry and send-back-to-previous-column.
- **Where the code lives.** An item has to map to a workspace (ADO project / Jira project / GitHub repo → local repo).
  Parallel items need isolation in separate worktrees. Mission Control (and its merge queue) was retired
  in `8443ec3`. What remains is the subagent writer-worktree code. See **Worktrees** below.
- **Concurrency.** A WIP limit per column (and/or board-wide) so twenty tagged items don't start
  twenty agents at once, plus a cost/budget cap.
- **Sync frequency and drift.** How often to pull? What if an item is untagged, closed, or edited
  upstream while an agent is working on it? (Proposal: untagged/closed pauses the card and asks; edits
  show a "changed upstream" badge and are not injected into a running turn.)
- **Intermediate write-backs, not just the final one.** Users will likely want per-column upstream
  effects: move ADO state to `Active` when work starts, post the PR link as a comment, assign to self.
  Model the exit action as one case of a general **on-enter / on-exit column action**.
- **Write-back safety.** Upstream writes are outward-facing. They need a preview, an approval mode
  (always ask / auto after the first approval per board), idempotency (don't post the same comment twice
  on retry), and an audit log.
- **Prompt-injection boundary.** Ticket titles, descriptions, and comments are written by other people.
  They must enter the agent as untrusted data via the existing provenance envelopes
  (`src/shared/context-provenance.ts`), never as instructions. This matters more here than anywhere else
  in the app, because the board runs unattended.
- **Normalized item shape.** Pick one internal shape (id, url, title, body, type, state, tags, assignee,
  updatedAt) that every source maps into, so the board and agents never care whether it came from ADO, Jira, or GitHub.
- **Reassignment.** If an item is reassigned away from you mid-run, the card should stop at the next
  safe point and never write upstream on someone else's item.
- **Multiple boards.** Settled: many per workspace, user's choice. See Decision 6.

## What exists today (reuse, don't rebuild)

- **Dashboards recipes** (`src/main/dashboards/service.ts`, plan `033`): an agent authors a fetch
  recipe once (`command` or `url`), and refresh **replays it without an LLM**, re-authorized through the
  shared PolicyEngine, with fail-closed `stale` results. This is the right model for intake: author the
  ADO/Jira query once with the agent's help, then replay it deterministically on each sync.
  Gap: recipes support `command` and `url` only. Intake needs a third kind, **MCP tool call**
  (server + tool + args), executed through the existing MCP client in `src/main/agent/mcp/`.
- **MCP client + per-agent MCP access** (`src/main/agent/mcp/`, `src/main/agent/agents/mcp-access.ts`):
  agents can already be granted MCP servers, so a column agent can use the Atlassian/ADO MCP directly
  for its own reads.
- **Durable task runner** (`src/main/tasks/runner.ts`, `enqueueKind`): register `kanban_sync` and
  `kanban_card_run` kinds for restart-safe, retryable background work.
- **Named agents** (`src/main/agent/agents/`): the per-column agent picker is a selection from this
  catalog; empty means the built-in North Star agent.
- **Workflows** (`src/main/workflows/`): a column could run a workflow instead of a single agent turn.
  See Decision 2. (The older Processes orchestration was retired with Mission Control.)
- **Worktree helpers** (`src/main/agent/subagents/worktrees.ts`): `createWriterWorktree`,
  `collectWriterHandback`, `removeWriterWorktree`, `stageIntegrationBranch` (`merge --no-ff` in a
  throwaway worktree), `mergeability` (`merge-tree --write-tree` conflict probe), and
  `listWorktrees`/`addWorktree`/`removeWorktree`. Chat worktrees (plan `111`) also exist.
  **No merge queue survives**: Mission Control's `merge_queue` table was dropped by
  `src/main/db/retire-orchestration.ts`. The leftover `mc/` branch helpers there are cleanup-only.
- **No scheduler exists.** Dashboards v1 does manual refresh plus refresh while the screen is open.
  The board inherits the same constraint until the `cron` backlog item lands.

## Proposed shape

### Board configuration (per board)
- Write-back approval level (Decision 4), workspace, source (adapter kind `cli | mcp` + the intake recipe), intake filter (stored in the recipe:
  tags / labels / JQL / WIQL), sync interval.
- Ordered columns. Each has a name, an agent (default North Star), instructions, a done condition
  (`agent says done` or `human approves`), WIP limit, and optional on-enter/on-exit upstream actions.
- Upstream actions are recipes too: "set state = X", "add comment", "add tag", each authored and
  previewed once, then replayed with the item id bound in. **Never splice raw item text into a shell
  command**; bind it as a separate argument (same rule as `127` command iteration).

### Column outcomes and outcome-based exit actions (136.3)
A QA column needs a different write-back depending on the result: on passed, advance the state; on failed,
send the item back to the dev; on incomplete, write nothing and let a person look. The handoff `status`
can't carry this, because it describes the agent's task, not the work item's verdict. An agent that ran
the tests and saw them fail still reports `completed`. Handoff `failed` means "couldn't do the assignment".

- **Outcomes per column.** A column may declare a list of named outcomes (e.g. `passed`, `failed`,
  `incomplete`). Each outcome sets what happens next: `advance` (to the next column), `wait` (needs a
  person, whatever the column's gate), `end` (the card finishes on this column, e.g. a failed item
  that is going back to the dev), or `goto <column id>` (see below). A column with no outcomes behaves
  as in 136.2.
- **`goto` sends the card to a named column on the board.** It is for judging columns: a Code review
  column's `changes_requested` → goto Development, or QA's `failed` → goto Development, instead of
  `end` plus a tracker write-back. The target is a column id, not "previous", because the target isn't
  always the column just before (Dev → Tests → Review). It works like an automatic Send back: the
  target column reruns with the judging agent's handoff findings as the required feedback, on the same
  card worktree and branch, so the agent fixes its own work instead of starting over.
  - **Loop cap.** Each column with a `goto` outcome has `maxReturns` (default 2) per card. Once a card has
    used them all, that outcome becomes `wait` with the reason "return limit reached", so a card can't
    bounce between Dev and Review forever. Moving the card by hand resets the count.
  - **Exit actions.** Leaving by `goto` runs the on-exit actions whose `when` matches the outcome (e.g.
    post the review as a PR comment). This differs from manual send back, which runs none.
  - **Missing target.** If the target column no longer exists, the outcome falls back to `wait`. Saving
    the board rejects a `goto` to a column id that doesn't exist.
  - **Idempotency across passes.** A card that comes back through `goto` re-enters a column it already
    left, so the idempotency key also includes the card's pass number on that column. Otherwise its second
    exit would skip the actions it needs.
- **Reporting.** When a column has outcomes, the prompt lists them and the handoff carries a required
  `outcome` field that must be one of them. A missing or unknown outcome counts as an invalid handoff and
  gets the existing repair turn, then `wait`. The outcome is the agent's claim. Spot-checks and the
  approval levels are the backstop. The agent may base its outcome on tool output (e.g. the QA script's
  final status line), but ticket text never decides it.
- **Actions filtered by outcome.** Every on-exit action has `when: any | [outcomes]` (default `any`).
  Leaving the column runs only the actions that match the recorded outcome. For `advance`/`end`, the
  actions run when the card leaves. For `wait`, they run when the person approves, using the recorded
  outcome. The person can change the outcome first (e.g. turn `incomplete` into `failed` after looking).
  Reject, rerun, and send back run no exit actions.
- **Idempotency key** becomes card + column + action + outcome, so a rerun that flips the outcome can't
  run the action for the other outcome twice.
- **Pilot without this:** passes run the exit action; fails and incompletes both stop as `waiting`, and
  the user moves failed items upstream by hand.

Example: QA board on ADO (`Ready to Test` → `--env dev`):

| Outcome | Next | On-exit actions |
|---|---|---|
| `passed` | advance | set state `Passed QA` |
| `failed` | end | set state `Active`, assign to the PR author / dev |
| `incomplete` | wait | none |

Example: board-internal review loop (`Development` → `Code review` → `QA`). Development has no
outcomes. Code review:

| Outcome | Next | On-exit actions |
|---|---|---|
| `approved` | advance | none |
| `changes_requested` | goto `development` (maxReturns 2) | post findings as a PR comment |

### Intake filter
A structured filter, not a free-form query, so the UI can show and edit it:
- **Tags**: a list plus a match mode, `any` (default) or `all`. Optional excluded tags (e.g. `agent-skip`).
- **Assigned to**: `me` (default), a specific person, or `anyone`. `me` is resolved by the tracker's
  own identity for the signed-in CLI/MCP user (ADO WIQL `@Me`, Jira JQL `currentUser()`, GitHub `assignee:@me`), never by
  asking for or storing the user's email. If the source can't resolve `me`, intake fails closed.
- Optional: work item types, states (e.g. only `New`/`Active`), area/iteration path, Jira project, or GitHub repo.
- An **advanced** escape hatch: a raw WIQL/JQL/GitHub search query instead of the structured fields.

GitHub Issues notes: tags are **labels**. `gh issue list --label a --label b` is `all`; `any` needs the
search syntax (`label:a,b`), and excluded tags use `-label:x`. Issues only have `open`/`closed` (with
reason `completed`/`not planned`), so a state such as `Ready to Deploy` is expressed as an upstream action
that adds a label or sets a GitHub Projects status field. Pull requests are filtered out of intake
(`is:issue`).

The filter compiles into the intake recipe's query. On every sync, the normalized result is also
**re-checked locally** against the structured filter (tags present, assignee still matches), so a recipe
that drifts or a source that ignores a clause can't pull in someone else's item. Before any upstream
action, the item is re-fetched and the assignee re-checked. If the item no longer matches, the action
does not run and the card pauses.

### Intake column
Items land in an implicit **Inbox** (not worked) and the user drags or auto-promotes them into the first
real column. This gives a cheap human checkpoint before agents spend money on newly tagged items.
Auto-promote is a board setting, off by default.

### Card run
Entering a column with an agent enqueues `kanban_card_run`: builds the prompt from column instructions
plus the item (as untrusted data) plus prior columns' bounded results (same bounding as recent
`fix(workflows): bound prior results in step prompts`), runs in the card's worktree, and records the
result on the card. The done condition then advances the card or flags it as waiting on the user.

### Worktrees
In a git workspace, each card gets one branch and worktree for its whole life on the board (e.g.
`ns/kanban/<board-id>/<item-id>`), created with the writer-worktree helpers on its first column that writes code and
removed when the card leaves the board. Columns share that worktree, so later columns see earlier work.
Landing is a column action, not automatic: open a PR (`gh pr create`, `az repos pr create`) or a local
merge checked first with `mergeability`. **No merge queue in v1.** WIP limits plus PR-based landing make
one unnecessary. Revisit only if users land many local merges in parallel. Non-git workspaces run one card at a time.

### Storage (additive migration)
`kanban_boards`, `kanban_columns`, `kanban_cards` (external id + url + normalized snapshot + column +
status + worktree), `kanban_card_runs` (per column attempt, links to the conversation/task), and
`kanban_upstream_actions` (audit log with idempotency key = card + column + action).

### UI
A full-screen board view in the renderer (same takeover pattern as dashboards/process screens): columns,
cards with status chips and a link to the upstream item, a card drawer with run history and transcripts,
a board settings sheet for columns, agents, and actions. All main access goes through new `window.cowork.kanban.*` IPC.

## Decisions (settled 2026-11-12)

1. **Landing.** PR per card via a column action (`gh pr create`, `az repos pr create`). Local merge is
   also allowed as a column action, checked with `mergeability` first. No merge queue.
2. **Column = agent turn** in v1. Workflow-per-column is a v2 option.
3. **Recipe authoring.** Agent-authored, probing the real CLI/MCP output first (like dashboards).
   ADO/Jira/GitHub presets are only starting prompts. No hardcoded per-tracker adapters in v1.
4. **Write-back approval is a board setting with four levels**, chosen by the user:
   - `always` — every upstream write waits for approval.
   - `once_per_action` (default) — the first run of each action recipe asks, later runs are automatic.
   - `once_per_board` — one approval covers every action on the board.
   - `auto` — no approval prompts.
   Every level keeps the audit log, the board-level kill switch, idempotency keys, and the pre-action
   re-fetch + assignee re-check. A changed action recipe counts as a new action and needs approval again
   under `once_per_action`; under `once_per_board`, adding or changing any action re-asks.
5. **Sync.** Manual Sync button plus polling at the board's interval while the board screen is open.
   Card runs continue in the background; only intake waits for the screen. Revisit when `cron` lands.
6. **Board scope.** Many boards per workspace, user's choice: one board holding bugs and features, or a
   Bugs board and a Features board with different filters and columns. `kanban_boards` has no unique
   constraint on workspace; the UI adds a board picker. An item that matches two boards' filters appears
   on each; the per-item worktree branch includes the board id (`ns/kanban/<board-id>/<item-id>`) so the
   two cards never share a branch.

## Out of scope for v1

Two-way field sync beyond the defined actions, webhooks from trackers, moving cards back upstream from
tracker changes (only North Star → tracker writes via actions; on-board moves back use the `goto`
outcome), cross-workspace boards, per-card agent override.

## Suggested slicing

- `136.1` **Done.** Storage, IPC, and a read-only board: MCP-tool recipe kind, structured intake filter (tags +
  assignee), `kanban_sync`, inbox populated from a real ADO, Jira, or GitHub source.
- `136.2` **Built.** Columns with agents: `kanban_card_run`, human gate, statuses, worktrees. Also: the board
  settings sheet, including editing the intake filter in the UI (136.1 shows it read-only; the agent
  edits it via `kanban_write`), and keying columns by id (136.1 replaces all columns when names change,
  sending their cards back to the Inbox).
- `136.3` **Built.** Upstream actions: on-enter/on-exit recipes, preview, approval, idempotency, audit log. Column
  outcomes with `advance | wait | end | goto <column>` (with `maxReturns`) and on-exit actions filtered by `when` (see **Column outcomes and
  outcome-based exit actions**).
- `136.4` WIP limits, budget caps, upstream drift handling.
- `136.5` User-column commands: a user column can run a command the user wrote on each card that enters
  (see **136.5 User-column commands**).

## 136.5 User-column commands (built 2026-11-16; decisions settled the same day)

A user column (`owner: "user"`) can carry a shell command that the user writes in the settings sheet. When
a card enters, the command runs for that card instead of the card waiting for the person to mark it done.
The user wrote it, so it skips the approval prompt and can run with no timeout. The agent can never write it.

**Decisions**

- **Who writes it:** only the user, through the settings sheet (IPC). The agent never sees or sets it.
- **Kind of command:** finite jobs only (build, test, deploy), not long-running services. The exit code
  decides the outcome.
- **Concurrency:** one run at a time **per column**, first in, first out. Other columns keep working in
  parallel.
- **Card context:** every run is tied to one card. Its environment has the card's values (below), and it
  gets its own run record.
- **Card leaves the column:** a queued run is dropped and a running one is stopped.
- **Where it runs:** through `createEnvironment` with the user's execution settings, like the board's
  other commands. No approval prompt, but the policy engine still runs first: a `hard_block` command fails
  the run with that reason (the same check as `defaultRunCall` in `src/main/kanban/service.ts`).
- **Timeout:** a column setting: Off, or On with 5–90 minutes. Main checks it again before each run and
  refuses anything else (the setting is saved data, not only UI).

**Agent and user columns (changes to `kanban_write`)**

- `owner` is removed from the tool's description and parameters. Every column the agent writes is an
  agent column.
- The agent sees user columns **read-only** (name and position), so its outcomes can `goto` them and an
  `advance` can land in one.
- On save, user columns stay where they are: each one stays right after the agent column it followed
  (first, if it was first). If the agent removed that column, it stays after as many agent columns as
  before (`mergeAgentColumns` in `src/shared/kanban.ts`). The agent can add, reorder, rename and remove its own
  columns, but never moves, renames or removes a user column. A name in the agent's list that matches a
  user column is refused.
- Today `saveColumns` (`src/main/db/repositories/kanban.ts`) replaces the whole list and removes any
  column left out, so this merge needs to happen before it on the agent path. The settings sheet
  (user path) keeps full control.

**Shape**

- `KanbanColumn` gets `command: string | null` and `commandTimeoutMs: number | null` (null = Off). It's an
  additive migration with defaults `null` / `null`. `KanbanColumnInput` from the user path carries both
  fields; the agent path never does, and keeps the stored values.
- **Entering a user column with a command:** the enter actions run as today. Then, instead of `waiting`,
  the card goes into that column's queue (`runState: "running"`, shown as *Queued* until it starts). A new
  `kanban_card_runs` row records the run (with a kind that marks it as a command run, not an agent run).
- **Working folder:** the card's working folder (`workdir`: its own worktree in a git workspace, otherwise
  the workspace). The existing one-at-a-time lock for non-git workspaces still applies.
- **Environment variables:** `KANBAN_BOARD_ID`, `KANBAN_CARD_ID`, `KANBAN_ITEM_ID`, `KANBAN_ITEM_TITLE`,
  `KANBAN_ITEM_URL`, `KANBAN_BRANCH`. They're passed as environment variables, never substituted into the
  command text, so a tracker title can't change what the command runs.
- **Outcome:** exit 0 reports `passed`, anything else `failed`. If the column has outcome rules, they take
  over from there (advance, wait, end, goto). If it has none, 0 means done (the card advances) and a failure
  sets the card to `failed` with the end of the output as `runError`. A timeout sets `failed` ("timed out
  after N min").
- **Output:** the end of the output is kept on the run record, bounded by the existing output cap.
- **Stop:** the card's existing Stop (`stop()` in `card-runs.ts`) gets a command-run branch. Moving a card
  out of the column calls the same path for a running card and removes a queued one.
- **Restart:** the startup sweep that marks `running` cards `failed` ("interrupted") already covers this.
  Queued cards are marked the same way. Nothing reruns on its own; the user reruns by moving the card back
  in.

**Engine changes**

- `ExecOptions.timeoutMs` is a required number today (`src/main/agent/env/types.ts`). For Off it becomes
  optional (no timer). Only the board command path may leave it out; the agent tools keep passing a capped
  number. Check both `local.ts` and `container.ts`.
- `exec` needs an `env` option for the card variables (`ExecFileOptions` already has one).
- The per-column queue: check whether the task runner can limit a column to one run at a time. If it
  can't, add a small in-memory queue keyed by column id in `card-runs.ts`.

**UI**

- Settings sheet, user columns only: a command field, and a timeout control (Off / On + 5–90 min).
- Card: *Queued*, *Running* (with Stop), and on finish the outcome or `failed` reason, with the end of the
  output.

**Tests**

- `kanban_write`: `owner` is not accepted, user columns keep their position across agent updates, a name
  clash with a user column is refused, and user columns appear read-only in what the agent can read.
- `card-runs`: enter → queued → running → passed/failed → outcome routing; one at a time per column, while
  another column runs in parallel; leaving the column drops a queued run and stops a running one; timeout;
  a hard-blocked command fails the run without running it; the env vars reach the command.
- Repository: migration defaults; the user path saves `command`/`commandTimeoutMs` and the agent path keeps
  them.
- Settings sheet: the command and timeout fields show only on user columns, and the timeout is limited to
  Off or 5–90 min.

## 136.3 as built

- **Code:** `src/main/kanban/card-runs.ts` (outcomes, `goto`, the action pipeline), `src/main/db/kanban-schema.ts`
  (`ensureKanbanActions`, v82), `kanban_upstream_actions` in `src/main/db/repositories/kanban.ts`,
  `KanbanService.stillMatches`/`runAction`, outcome/action helpers in `src/shared/kanban.ts`.
- **Outcomes** live on the column (`advance | wait | end | goto`, `target` = column id, `maxReturns`
  default 2). The outcome list goes into the handoff instruction (so repair and continuation turns
  see it), and the handoff carries `outcome`. A missing or unknown one gets the existing repair turn,
  then the card waits with "pick an outcome". A human gate waits whatever the outcome. Approve takes an
  optional outcome override, and approving a `wait` outcome advances. A person approving a `goto` isn't
  limited by `maxReturns`. Any move by hand (move, send back, rerun, reject) resets the return counts.
- **goto findings** reach the target column as an untrusted-data envelope ("column X sent this back with
  outcome Y"), not as user feedback, because they're another agent's output and may quote the ticket.
- **Actions** are column recipes `{ name, phase: enter|exit, when?, command | tool+args }` with
  `{{id}} {{url}} {{branch}} {{result}}` bound per card (shell-quoted in commands). They are authored by
  the agent (`kanban_write`) and shown read-only in the settings sheet. On-enter actions run before the
  column's agent. Exit actions run on advance/end/goto/approve, filtered by `when`. Reject, rerun, send
  back, and manual moves run no exit actions (they do run the target's on-enter actions on a new visit).
- **Idempotency:** key = card + column + phase + action name + outcome + the card's visit number on that
  column. A rerun of the same visit skips what already ran; a goto back is a new visit, so it runs again.
- **Approval:** board settings choose the level and the kill switch (Settings → General → Tracker writes).
  `kanban_write` can't set them. A write needing approval parks the move on the card (state saved as the
  card's `continuation`) with a preview of the bound call: Approve and run, or Skip this write. Approval is
  answered by action id, so a write that changed between display and click isn't approved blind. While
  paused, every write waits (an explicit per-write approval still runs it).
- **Before writing,** the intake recipe is replayed once per batch and the item must still match the
  filter. If not (or the re-check fails), the card is `blocked` and nothing is written. A failed write
  marks the card `failed`, and Retry resumes the parked move.
- **User columns** (added 2026-11-16, v83): a column's `owner` is `agent` (default) or `user`, for a step the
  user does themselves (deploy, sign-off, device test). No agent runs there. On-enter actions still run,
  then the card waits as "your turn", with the column's instructions shown as what to do. "Done" (picking
  an outcome if the column has any) leaves it like an approval: exit actions, `advance`/`end`/`goto`.
- **Known limits:** actions and the re-check run inline in the IPC call or the card-run task, with up to
  2 minutes each and no Stop for an in-flight write. The re-check replays the whole intake query rather
  than one item. Actions are added or edited only through the agent. There's no live tracker run yet.

## Verification (when built)

- Unit: filter compilation for ADO, Jira, and GitHub (multiple tags any/all, excluded tags, `me`); local re-check
  drops an item whose tag was removed or assignee changed; upstream action refuses on a reassigned item.
- Unit: recipe replay for each kind (command/mcp) and fail-closed paths; item normalization; idempotent
  action keys; each approval level (and re-ask when an action recipe changes); done-condition transitions; WIP enforcement.
- Unit: column outcomes. A handoff with a missing or unknown outcome gets repaired, then waits; only
  actions whose `when` matches run; a person changing the outcome on a waiting card runs the matching
  actions on approve; reject/rerun run none; a rerun that flips the outcome doesn't run either side twice.
- Unit: `goto`. The target column reruns with the findings as feedback on the same worktree; matching
  exit actions run; the attempt after `maxReturns` waits with "return limit reached"; a manual move
  resets the count; a deleted target falls back to `wait` and saving a board with a dangling target is
  rejected; a column re-entered via `goto` runs its exit actions again on its next pass.
- Injection test: an item body containing instructions does not change agent behavior or trigger tool calls
  beyond the column's scope.
- Manual: real ADO board via `az boards` and via ADO MCP; real Jira via Atlassian MCP; real GitHub Issues via `gh` and via GitHub MCP; tag an item, see it in
  the inbox (and confirm a teammate's item with the same tag does not appear), promote, watch it run through columns, approve the exit action, confirm the upstream state changed once.

## 136.1 as built

- **Code:** `src/shared/kanban.ts` (types, normalization, filter re-check, filter → query compiler,
  `{{query}}` binding), `src/main/kanban/service.ts` (`kanban_sync`), `src/main/db/kanban-schema.ts`
  (v80: `kanban_boards`, `kanban_columns`, `kanban_cards`), `src/main/agent/tools/kanban_write.ts`,
  `src/main/ipc/kanban-handlers.ts`, `src/renderer/src/components/kanban-screen.tsx`.
- **Recipe kinds:** `command` and `mcp` only. `url` was dropped: trackers need auth a plain fetch can't
  carry, and the brief routes sources through a CLI or MCP server.
- **Query binding:** the recipe sets `tracker` and writes `{{query}}` in its command (shell-quoted as one
  argument) or string MCP args; each sync fills in the compiled filter, or `filter.query` when the raw
  escape hatch is set. The structured filter is always re-checked locally.
- **Approval:** a board-level hash of the recipe plus the call it resolves to. Editing the recipe, or a
  filter edit that changes the query, re-asks. Needed because MCP calls are explicit-approval-only, so
  the dashboards allowlist path can't cover them.
- **"me":** resolved each sync by a `whoami` recipe (GitHub `gh api user` → `login`); never stored.
  `kanban_write` steers to `me`; `anyone` gets a warning on the approval banner.
- **Known limits:** compiled WIQL excludes the default process states (`Closed`, `Done`, `Removed`);
  custom processes need the raw query. GitHub search can't escape `"`, so such labels can't be matched.
  Jira and ADO compilation is unit-tested only (no live tracker run).
- **Tables left for later slices:** `kanban_card_runs` (136.2), `kanban_upstream_actions` (136.3).

## 136.2 as built

- **Code:** `src/main/kanban/card-runs.ts` (`kanban_card_run` executor + card moves),
  `src/main/db/kanban-schema.ts` (`ensureKanbanRuns`, v81), `src/main/tasks/bounded-results.ts` (prior-result
  bounding shared with workflow steps), `src/renderer/src/components/kanban-settings-sheet.tsx`.
- **Columns:** name, agent (null = North Star), instructions, gate (`agent` | `human`). Empty instructions
  = no run; the card just sits there (e.g. a final Done column). Columns keep their id across edits; the
  agent tool matches by name. Removing a column that holds cards is refused.
- **Card states:** `idle | running | waiting | blocked | failed | done`. `blocked` = the agent's handoff
  reported an obstacle only the user can clear (credentials, login, permissions); shown as "needs you",
  not as a failure. Entering a column with instructions creates
  a `kanban_card_runs` row and enqueues `kanban_card_run` (work lane). A completed handoff advances the
  card (agent gate) or waits (human gate); `done` after the last column. Actions: move to any column,
  approve, reject (back to the Inbox), reject with feedback (rerun the same column with required
  feedback), rerun, send back (rerun the previous column with feedback), stop, remove. Approve / Reject /
  Reject with feedback show as buttons on a waiting card, not only in its menu.
- **Run:** one unattended Auto-mode turn per column attempt in a new conversation (no questions, hard
  blocks apply), with one handoff repair turn and up to 3 automatic continuation turns for an
  `unfinished` handoff (workflow steps' budget). Unlike workflow steps, a tool call that still needs an
  explicit yes in Auto mode (e.g. an MCP call) does not end the run: the agent waits on it, the card
  shows "needs approval" with the call's summary, and Allow / Deny on the card answer it. The wait is
  in memory, so a quit ends the run (marked interrupted at startup). The item enters the prompt as a `DATA:`-prefixed untrusted envelope after the column
  instructions; prior columns' results are bounded like workflow steps. The agent is told not to write
  to the tracker unless the column's instructions explicitly say to (e.g. a QA script that comments
  and uploads test cases); item text can never authorize it. Those writes bypass approval and audit
  until 136.3, the same as running the script by hand.
- **Worktrees:** git workspaces get one worktree per card under `userData/kanban-worktrees/<board>/<card>`
  on branch `ns/kanban/<board-id>/<item-id>`, created on the first run and shared by all columns; a
  workspace subdirectory maps to the same subdirectory in the worktree. Removing a card or board removes
  worktrees and keeps branches. Non-git workspaces run one card at a time (in-memory lock).
- **Restart:** runs don't auto-resume; at startup a card left `running` is marked `failed` ("interrupted").
- **Known limits:** continuation turns don't summarize the transcript between turns the way workflow
  steps do (in-turn compaction still applies); moves are by menu, not drag-and-drop; no per-column model choice; any
  number of cards can run at once until 136.4's WIP limits (the work lane caps it at 6).

**136.5 as built**

- **Code:** `mergeAgentColumns` and `commandTimeoutProblem` in `src/shared/kanban.ts`;
  `ensureKanbanColumnCommands` (v84) in `src/main/db/kanban-schema.ts`; `listColumnCommandRuns` in the
  repository; `KanbanService.runCommand`; the queue (`startNextCommand`, `dropCommand`) and
  `executeCommand` in `src/main/kanban/card-runs.ts`, registered as the `kanban_command_run` task kind
  (work lane).
- **Queue:** kept in the database. A column's unfinished command runs are the queue; the one with a task
  is running. The next one starts when a run finishes, is stopped, or its card moves away. A quit marks
  them all interrupted (the existing startup sweep).
- **No time limit:** `ExecOptions.timeoutMs` stays a required number; `Infinity` means no timer. Only
  this path passes it. `exec` gained an `env` option (local and container).
- **Card:** a waiting card shows *queued*; a command card can be moved or sent back while it runs. A
  failure shows the exit code and the last three output lines; the run history keeps the last 4,000
  characters.
- **Fixed alongside:** `workdir()` used to compute the worktree subfolder with `path.relative` between git's
  resolved top folder and the workspace as given, which broke when the workspace path went through a
  symlink (macOS `/var` → `/private/var`). It now asks git (`rev-parse --show-prefix`). The tests run on
  unresolved temp paths to cover it.

