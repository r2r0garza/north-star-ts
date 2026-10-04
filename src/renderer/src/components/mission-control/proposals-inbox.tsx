import { useCallback, useEffect, useState } from "react"
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Inbox,
  Play,
  Reply,
  Send,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { describePlanChange } from "../../../../shared/mission-control/plan-changes"
import type { UserStoryDraft } from "../../../../shared/mission-control/plan-changes"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { proposalOverlapEstimates } from "@/lib/overlap-schedule"
import { addedStoryImpacts, type AddedStoryImpact } from "@/lib/proposal-impact"
import { OverlapEstimates } from "./overlap-estimate"
import type {
  Decision,
  FeatureGraph,
  FollowupTarget,
  PlanChange,
  PlanProposal,
  Position,
  SeatMessage,
} from "@/types"

// Everything waiting on the user (plan 106.6): plan proposals from seats (with
// the exact changes applying them makes), escalations, and the Navigator's
// other user-owned decisions — landing a milestone, a stuck merge, a failed hook.

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
}

function UserStoryLines({ userStory }: { userStory: UserStoryDraft }) {
  return (
    <div className="pl-4 text-xs text-muted-foreground">
      {userStory.goal && <div>Goal: {userStory.goal}</div>}
      {userStory.acceptance?.length ? (
        <ul className="list-disc pl-4">
          {userStory.acceptance.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : (
        <div className="text-amber-600">No acceptance criteria</div>
      )}
      {userStory.dependsOn?.length ? (
        <div>After: {userStory.dependsOn.join(", ")}</div>
      ) : null}
      {userStory.touchHints?.length ? (
        <div>Touches: {userStory.touchHints.join(", ")}</div>
      ) : null}
    </div>
  )
}

function ChangeView({ change }: { change: PlanChange }) {
  const tone = describePlanChange(change).startsWith("+")
    ? "text-emerald-600 dark:text-emerald-400"
    : describePlanChange(change).startsWith("−")
      ? "text-destructive"
      : ""
  if (change.op === "add_milestone")
    return (
      <div className="space-y-1">
        <div className={`font-medium ${tone}`}>
          + Milestone {change.milestone.name}
          {change.milestone.key ? (
            <code className="ml-1 text-xs">{change.milestone.key}</code>
          ) : null}
        </div>
        <div className="pl-4 text-xs text-muted-foreground">
          {change.milestone.outcome}
        </div>
        {change.milestone.definitionOfDone && (
          <div className="pl-4 text-xs text-muted-foreground">
            Done when: {change.milestone.definitionOfDone}
          </div>
        )}
        {(change.milestone.userStories ?? []).map((userStory, index) => (
          <div key={index} className="pl-4">
            <div className="text-sm">
              + {userStory.title}
              {userStory.key ? (
                <code className="ml-1 text-xs">{userStory.key}</code>
              ) : null}
            </div>
            <UserStoryLines userStory={userStory} />
          </div>
        ))}
      </div>
    )
  if (change.op === "add_user_story")
    return (
      <div>
        <div className={tone}>{describePlanChange(change)}</div>
        <UserStoryLines userStory={change.userStory} />
      </div>
    )
  if (change.op === "split_user_story")
    return (
      <div>
        <div>{describePlanChange(change)}</div>
        {change.into.map((userStory, index) => (
          <div key={index} className="pl-4">
            <div>+ {userStory.title}</div>
            <UserStoryLines userStory={userStory} />
          </div>
        ))}
      </div>
    )
  return (
    <div className={tone}>
      {describePlanChange(change)}
      {"patch" in change && (
        <div className="pl-4 text-xs text-muted-foreground">
          {Object.entries(change.patch).map(([field, value]) => (
            <div key={field}>
              {field}: {Array.isArray(value) ? value.join("; ") : String(value)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const listed = (keys: string[]) =>
  keys.length > 5
    ? `${keys.slice(0, 5).join(", ")} and ${keys.length - 5} more`
    : keys.join(", ")

// How an added user story fits the stories already planned: waves come from
// dependencies, so stories in later waves don't wait for a new story unless
// it blocks them (or they run last).
function AddedStoryImpacts({ impacts }: { impacts: AddedStoryImpact[] }) {
  if (!impacts.length) return null
  return (
    <div className="space-y-1 text-xs">
      {impacts.map((impact) =>
        impact.runsLast ? (
          <p key={impact.key} className="text-muted-foreground">
            <code>{impact.key}</code> runs last: it waits for every other user
            story in the milestone, including ones added later.
          </p>
        ) : (
          <div key={impact.key} className="space-y-0.5">
            {impact.notWaiting.length > 0 && (
              <p className="flex gap-1 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span>
                  Nothing makes {listed(impact.notWaiting)} wait for{" "}
                  <code>{impact.key}</code>: they're in later waves but may
                  start before it finishes. If they need it, reject with a note
                  asking for <code>blocks</code>.
                </span>
              </p>
            )}
            {impact.waiting.length > 0 && (
              <p className="text-muted-foreground">
                {listed(impact.waiting)} will wait for <code>{impact.key}</code>
                .
              </p>
            )}
          </div>
        )
      )}
    </div>
  )
}

function ProposalCard({
  proposal,
  graph,
  onGraph,
  onResolved,
}: {
  proposal: PlanProposal
  // For the schedule estimate and the effect of added user stories on the
  // stories already planned.
  graph: FeatureGraph
  onGraph: (graph: FeatureGraph) => void
  onResolved: () => Promise<void>
}) {
  const feature = graph.feature
  const impacts = addedStoryImpacts(proposal, graph)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState("")
  const [pending, setPending] = useState(false)
  const act = async (work: () => Promise<FeatureGraph>, done: string) => {
    setPending(true)
    try {
      onGraph(await work())
      toast.success(done)
      await onResolved()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
    }
  }
  const proposals = window.cowork.missionControl.proposals
  // Changes that no longer apply to the plan as it is now (it moved on).
  const problems = new Map(
    (proposal.problems ?? []).map((p) => [p.index, p.error])
  )
  const applicable = proposal.changes.length - problems.size
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="secondary">
          {proposal.kind === "plan"
            ? "Planning proposal"
            : proposal.kind === "user_story"
              ? "New user story"
              : "Plan change"}
        </Badge>
        {problems.size > 0 && (
          <Badge
            variant="outline"
            className="border-amber-500/60 text-amber-700 dark:text-amber-400"
          >
            {applicable
              ? `${problems.size} change${problems.size === 1 ? "" : "s"} stale`
              : "stale"}
          </Badge>
        )}
        <span className="text-muted-foreground">
          from <code>{proposal.proposer}</code> ·{" "}
          {new Date(proposal.createdAt).toLocaleString()}
        </span>
      </div>
      {proposal.reason && <p className="text-sm">{proposal.reason}</p>}
      <OverlapEstimates
        estimates={proposalOverlapEstimates(proposal.changes, feature)}
      />
      <AddedStoryImpacts impacts={impacts} />
      <div className="space-y-2 rounded bg-muted/40 p-2 text-sm">
        {proposal.changes.map((change, index) => (
          <div key={index} className={problems.has(index) ? "opacity-60" : ""}>
            <ChangeView change={change} />
            {problems.has(index) && (
              <div className="mt-0.5 flex gap-1 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                No longer applies: {problems.get(index)}
              </div>
            )}
          </div>
        ))}
      </div>
      {rejecting ? (
        <div className="space-y-2">
          <Textarea
            rows={2}
            value={note}
            placeholder="Why? The seat that proposed it reads this."
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() =>
                void act(
                  () => proposals.reject(proposal.id, note),
                  "Proposal rejected"
                )
              }
            >
              Reject
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRejecting(false)}
            >
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {problems.size === 0 ? (
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                void act(() => proposals.apply(proposal.id), "Proposal applied")
              }
            >
              <Check className="size-4" /> Apply
            </Button>
          ) : applicable > 0 ? (
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                void act(
                  () => proposals.apply(proposal.id, { partial: true }),
                  `Applied ${applicable} change${applicable === 1 ? "" : "s"}; the proposer was told what was skipped`
                )
              }
            >
              <Check className="size-4" /> Apply the {applicable} that still
              appl
              {applicable === 1 ? "ies" : "y"}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">
              Nothing in it applies anymore.
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setRejecting(true)}
          >
            <X className="size-4" /> Reject…
          </Button>
        </div>
      )}
    </div>
  )
}

const NEW_MILESTONE = "__new_milestone__"

// A follow-up idea (plan 106.7): an out-of-scope idea a seat parked instead of
// building. Applying it lands it where the user picks — a later milestone by
// default; the milestone in flight only when chosen explicitly.
function FollowupCard({
  proposal,
  graph,
  onGraph,
  onResolved,
}: {
  proposal: PlanProposal
  graph: FeatureGraph
  onGraph: (graph: FeatureGraph) => void
  onResolved: () => Promise<void>
}) {
  const followup = proposal.followup!
  const open = graph.milestones.filter(
    (m) => !["completed", "cancelled"].includes(m.status)
  )
  const active = open[0] ?? null
  const initial =
    proposal.defaultTarget?.kind === "user_story"
      ? proposal.defaultTarget.milestone
      : NEW_MILESTONE
  const [target, setTarget] = useState(initial)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState("")
  const [pending, setPending] = useState(false)
  const act = async (work: () => Promise<FeatureGraph>, done: string) => {
    setPending(true)
    try {
      onGraph(await work())
      toast.success(done)
      await onResolved()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
    }
  }
  const proposals = window.cowork.missionControl.proposals
  const choice: FollowupTarget =
    target === NEW_MILESTONE
      ? { kind: "milestone" }
      : { kind: "user_story", milestone: target }
  const current = !!active && target === active.key
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline">Follow-up idea</Badge>
        <span className="text-muted-foreground">
          from <code>{proposal.proposer}</code>
          {followup.anchor
            ? ` while on ${followup.anchor.kind.replace("_", " ")} ${followup.anchor.key}`
            : ""}{" "}
          · suggested as a {followup.altitude.replace("_", " ")}
        </span>
      </div>
      <p className="text-sm font-medium">{followup.title}</p>
      <p className="text-sm whitespace-pre-wrap text-muted-foreground">
        {followup.rationale}
      </p>
      {rejecting ? (
        <div className="space-y-2">
          <Textarea
            rows={2}
            value={note}
            placeholder="Why not? The seat that proposed it reads this."
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() =>
                void act(
                  () => proposals.reject(proposal.id, note),
                  "Follow-up dropped"
                )
              }
            >
              Drop
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRejecting(false)}
            >
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger size="sm" className="h-8 w-64 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {open.map((m) => (
                <SelectItem key={m.id} value={m.key}>
                  User story in {m.key}
                  {m.id === active?.id ? " (in flight)" : ""}
                </SelectItem>
              ))}
              <SelectItem value={NEW_MILESTONE}>As a new milestone</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              void act(
                () =>
                  proposals.applyFollowup(proposal.id, choice, {
                    allowCurrent: current,
                  }),
                "Follow-up added to the plan"
              )
            }
          >
            <Check className="size-4" /> Add to plan
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setRejecting(true)}
          >
            <X className="size-4" /> Drop…
          </Button>
          {current && (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              Adds work to the milestone in flight.
            </span>
          )}
        </div>
      )}
    </div>
  )
}

const HOOK_LABELS: Record<string, string> = {
  plan: "planning",
  before_user_stories: "the planning review",
  after_each_wave: "the acceptance gate",
  after_all_user_stories: "the milestone review",
  between_milestones: "the release",
  on_complete: "completion",
}

export interface InboxNavigation {
  openMilestone: (milestoneId: string) => void
  openUserStory: (userStoryId: string) => void
  openComms: () => void
  editBudgets: () => void
}

function DecisionCard({
  graph,
  decision,
  navigation,
  onGraph,
}: {
  graph: FeatureGraph
  decision: Decision
  navigation: InboxNavigation
  onGraph: (graph: FeatureGraph) => void
}) {
  const [judging, setJudging] = useState(false)
  const [summary, setSummary] = useState("")
  const [pending, setPending] = useState(false)
  const action = decision.action
  const run = async (work: () => Promise<unknown>, done: string) => {
    setPending(true)
    try {
      const result = await work()
      if (result && typeof result === "object" && "feature" in result)
        onGraph(result as FeatureGraph)
      toast.success(done)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
    }
  }
  const milestoneKey = (id: string) =>
    graph.milestones.find((m) => m.id === id)?.key ?? "milestone"
  // A decision without an inline action still gets a destination: its target,
  // or Comms, with the kind shown for diagnosis — never a dead card.
  const fallback = !action
  const target = decision.target
  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <div>{decision.summary}</div>
      {fallback && (
        <div className="flex flex-wrap items-center gap-2">
          {target.kind === "milestone" &&
          graph.milestones.some((m) => m.id === target.id) ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigation.openMilestone(target.id)}
            >
              Open milestone {milestoneKey(target.id)}
            </Button>
          ) : target.kind === "user_story" &&
            graph.userStories.some((s) => s.id === target.id) ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigation.openUserStory(target.id)}
            >
              Open user story{" "}
              {graph.userStories.find((s) => s.id === target.id)?.key ?? ""}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={navigation.openComms}>
              Open Comms
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            No direct action for this here ({decision.kind.replace(/_/g, " ")}).
          </span>
        </div>
      )}
      {action?.kind === "judge_milestone" && judging && (
        <Textarea
          rows={2}
          value={summary}
          placeholder="How does the merged work meet the milestone's definition of done? (recorded with the judgment)"
          onChange={(e) => setSummary(e.target.value)}
        />
      )}
      {action && (
        <div className="flex flex-wrap gap-2">
          {action.kind === "run_hook" && (
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                void run(
                  () =>
                    window.cowork.missionControl.execution.runHook({
                      featureId: graph.feature.id,
                      milestoneId: action.milestoneId,
                      hook: action.hook,
                    }),
                  `Started ${HOOK_LABELS[action.hook] ?? action.hook}`
                )
              }
            >
              <Play className="size-4" /> Run{" "}
              {HOOK_LABELS[action.hook] ?? action.hook}
            </Button>
          )}
          {action.kind === "judge_milestone" &&
            (judging ? (
              <>
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    void run(
                      () =>
                        window.cowork.missionControl.proposals.judgeMilestone(
                          action.milestoneId,
                          summary
                        ),
                      `Milestone ${milestoneKey(action.milestoneId)} judged done`
                    )
                  }
                >
                  <Check className="size-4" /> Milestone is done
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setJudging(false)}
                >
                  Back
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setJudging(true)}>
                <Check className="size-4" /> Complete milestone…
              </Button>
            ))}
          {(action.kind === "judge_milestone" ||
            action.kind === "open_milestone") && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigation.openMilestone(action.milestoneId)}
            >
              Open milestone {milestoneKey(action.milestoneId)}
            </Button>
          )}
          {action.kind === "open_user_story" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigation.openUserStory(action.userStoryId)}
            >
              Open user story{" "}
              {graph.userStories.find((s) => s.id === action.userStoryId)
                ?.key ?? ""}
            </Button>
          )}
          {action.kind === "edit_budgets" && (
            <Button
              size="sm"
              variant="outline"
              onClick={navigation.editBudgets}
            >
              Edit budgets
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function EscalationCard({
  message,
  navigation,
  onChanged,
}: {
  message: SeatMessage
  navigation: InboxNavigation
  onChanged: () => Promise<void>
}) {
  const [replying, setReplying] = useState(false)
  const [body, setBody] = useState("")
  const [pending, setPending] = useState(false)
  const run = async (work: () => Promise<unknown>, done: string) => {
    setPending(true)
    try {
      await work()
      toast.success(done)
      await onChanged()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
    }
  }
  const comms = window.cowork.missionControl.comms
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant="destructive">Escalation</Badge>
        <span className="text-muted-foreground">
          from <code>{message.fromAddress}</code>
        </span>
      </div>
      <p className="whitespace-pre-wrap">{message.body}</p>
      <p className="text-xs text-muted-foreground">
        An escalation doesn't stop the drive. Answer it here, act on what it
        asks for (the items above), or mark it handled.
      </p>
      {replying && (
        <Textarea
          rows={3}
          value={body}
          placeholder={`Your answer to ${message.fromAddress}. It arrives as your words, in the same thread.`}
          onChange={(e) => setBody(e.target.value)}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {replying ? (
          <>
            <Button
              size="sm"
              disabled={pending || !body.trim()}
              onClick={() =>
                void run(
                  () => comms.reply(message.id, body),
                  `Reply sent to ${message.fromAddress}`
                )
              }
            >
              <Send className="size-4" /> Send reply
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setReplying(false)}
            >
              Back
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => setReplying(true)}>
            <Reply className="size-4" /> Reply…
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            void run(() => comms.acknowledge(message.id), "Marked handled")
          }
        >
          <Check className="size-4" /> Mark handled
        </Button>
        <Button size="sm" variant="ghost" onClick={navigation.openComms}>
          Open in Comms
        </Button>
      </div>
    </div>
  )
}

// Everything waiting on the user, from one source (plan 106.11): the count
// the Feature home shows and the cards Waiting on you renders are the same
// list, so they can't disagree.
export interface WaitingItems {
  proposals: PlanProposal[]
  resolved: PlanProposal[]
  escalations: SeatMessage[]
  // Navigator decisions the inbox doesn't already show as a proposal or
  // escalation.
  decisions: Decision[]
  count: number
  // The highest-priority item: decisions (they block the drive) first,
  // then proposals, then escalations.
  top:
    | { kind: "decision"; decision: Decision }
    | { kind: "proposal"; proposal: PlanProposal }
    | { kind: "escalation"; message: SeatMessage }
    | null
  reload: () => Promise<void>
}

export function useWaitingItems(
  featureId: string,
  position: Position | null
): WaitingItems {
  const [proposals, setProposals] = useState<PlanProposal[]>([])
  const [escalations, setEscalations] = useState<SeatMessage[]>([])
  const reload = useCallback(async () => {
    const [nextProposals, mail] = await Promise.all([
      window.cowork.missionControl.proposals.list(featureId),
      window.cowork.missionControl.comms.list(featureId),
    ])
    setProposals(nextProposals)
    setEscalations(
      mail.messages.filter(
        (m) =>
          m.toAddress === "user@rig" &&
          m.kind === "escalation" &&
          m.status === "delivered"
      )
    )
  }, [featureId])
  useEffect(() => {
    setProposals([])
    setEscalations([])
    void reload().catch(() => {})
    const refresh = (changed: string) => {
      if (changed === featureId) void reload().catch(() => {})
    }
    const offNavigator =
      window.cowork.missionControl.navigator.onChanged(refresh)
    const offComms = window.cowork.missionControl.comms.onChanged(refresh)
    return () => {
      offNavigator()
      offComms()
    }
  }, [featureId, reload])
  const pending = proposals.filter((p) => p.status === "pending")
  const decisions = (position?.pendingDecisions ?? []).filter(
    (d) =>
      d.owner === "user" &&
      !["proposal", "plan_proposal", "escalation"].includes(d.kind)
  )
  const top = decisions[0]
    ? ({ kind: "decision", decision: decisions[0] } as const)
    : pending[0]
      ? ({ kind: "proposal", proposal: pending[0] } as const)
      : escalations[0]
        ? ({ kind: "escalation", message: escalations[0] } as const)
        : null
  return {
    proposals: pending,
    resolved: proposals.filter((p) => p.status !== "pending"),
    escalations,
    decisions,
    count: pending.length + escalations.length + decisions.length,
    top,
    reload,
  }
}

export const WAITING_ANCHOR = "mission-control-waiting"

// Bring the first actionable item into view, focus it, and highlight it
// briefly. False when nothing is rendered to focus.
export function focusFirstWaiting(): boolean {
  const first = document.querySelector<HTMLElement>(
    `#${WAITING_ANCHOR} [data-waiting-item]`
  )
  if (!first) return false
  first.scrollIntoView({ behavior: "smooth", block: "center" })
  first.focus({ preventScroll: true })
  first.classList.add("ring-2", "ring-amber-500")
  window.setTimeout(
    () => first.classList.remove("ring-2", "ring-amber-500"),
    2000
  )
  return true
}

export function WaitingOnYou({
  graph,
  waiting,
  onGraph,
  navigation,
}: {
  graph: FeatureGraph
  waiting: WaitingItems
  onGraph: (graph: FeatureGraph) => void
  navigation: InboxNavigation
}) {
  const [history, setHistory] = useState(false)
  const {
    proposals: pending,
    resolved,
    escalations,
    decisions: others,
    reload,
  } = waiting
  // Announce new decisions for screen readers.
  const [announcement, setAnnouncement] = useState("")
  const [seen, setSeen] = useState(waiting.count)
  useEffect(() => {
    if (waiting.count > seen) {
      const top = waiting.top
      setAnnouncement(
        `New decision waiting on you: ${
          top?.kind === "decision"
            ? top.decision.summary
            : top?.kind === "proposal"
              ? `a ${top.proposal.kind} proposal from ${top.proposal.proposer}`
              : top?.kind === "escalation"
                ? `an escalation from ${top.message.fromAddress}`
                : ""
        }`
      )
    }
    setSeen(waiting.count)
    // Only a change in the count announces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting.count])
  const empty = !pending.length && !escalations.length && !others.length
  if (empty && !resolved.length)
    return (
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    )

  return (
    <div id={WAITING_ANCHOR} className="space-y-3 rounded-lg border p-4">
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
      <div className="flex items-center gap-2">
        <Inbox className="size-4" />
        <h3 className="font-medium">
          {empty ? "Decisions" : "Waiting on you"}
        </h3>
        {!empty && <Badge variant="secondary">{waiting.count}</Badge>}
      </div>
      {others.map((decision) => (
        <div
          key={decision.key}
          data-waiting-item
          tabIndex={-1}
          className="rounded-md outline-none"
        >
          <DecisionCard
            graph={graph}
            decision={decision}
            navigation={navigation}
            onGraph={onGraph}
          />
        </div>
      ))}
      {pending.map((proposal) => (
        <div
          key={proposal.id}
          data-waiting-item
          tabIndex={-1}
          className="rounded-md outline-none"
        >
          {proposal.kind === "followup" && proposal.followup ? (
            <FollowupCard
              proposal={proposal}
              graph={graph}
              onGraph={onGraph}
              onResolved={reload}
            />
          ) : (
            <ProposalCard
              proposal={proposal}
              graph={graph}
              onGraph={onGraph}
              onResolved={reload}
            />
          )}
        </div>
      ))}
      {escalations.map((message) => (
        <div
          key={message.id}
          data-waiting-item
          tabIndex={-1}
          className="rounded-md outline-none"
        >
          <EscalationCard
            message={message}
            navigation={navigation}
            onChanged={reload}
          />
        </div>
      ))}
      {resolved.length > 0 && (
        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground"
            onClick={() => setHistory((value) => !value)}
            aria-expanded={history}
          >
            {history ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            Resolved proposals ({resolved.length})
          </button>
          {history &&
            resolved.map((proposal) => (
              <div
                key={proposal.id}
                className="mt-2 border-l pl-3 text-xs text-muted-foreground"
              >
                <span className="capitalize">{proposal.status}</span> ·{" "}
                {proposal.kind} from <code>{proposal.proposer}</code>
                {proposal.resolutionNote
                  ? ` — “${proposal.resolutionNote}”`
                  : ""}
                <div>
                  {proposal.followup && !proposal.changes.length
                    ? `Follow-up: ${proposal.followup.title}`
                    : proposal.changes.map(describePlanChange).join("; ")}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

// The feature's revision log with seat actors (plan 106.6): every
// structural change, who made it (user, seat, or Navigator), and why.
export function PlanHistory({ graph }: { graph: FeatureGraph }) {
  const [open, setOpen] = useState(false)
  const label = (kind: string, id: string) => {
    if (kind === "user_story")
      return graph.userStories.find((s) => s.id === id)?.key ?? "user story"
    if (kind === "milestone" || kind === "edge")
      return graph.milestones.find((m) => m.id === id)?.key ?? kind
    return "feature"
  }
  const revisions = graph.revisions.filter((r) => r.change.op !== "execute")
  if (!revisions.length) return null
  return (
    <div className="rounded-lg border p-4">
      <button
        type="button"
        className="flex items-center gap-1 text-sm font-medium"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-4" />
        ) : (
          <ChevronRight className="size-4" />
        )}
        Plan changes ({revisions.length})
      </button>
      {open && (
        <div className="mt-3 space-y-1">
          {revisions.slice(0, 100).map((revision) => (
            <div key={revision.id} className="border-l pl-3 text-xs">
              <Badge
                variant={revision.actor === "user" ? "outline" : "secondary"}
                className="mr-1 font-normal"
              >
                {revision.actor}
              </Badge>
              <span className="text-muted-foreground">
                {revision.change.op.replace(/_/g, " ")}{" "}
                {label(revision.targetKind, revision.targetId)}
                {revision.reason ? ` — ${revision.reason}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
