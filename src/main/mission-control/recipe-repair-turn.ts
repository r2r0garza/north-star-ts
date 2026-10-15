import type { AgentDefinition } from "../agent/agents/types"
import type { ContextSection } from "../agent/context/context-builder"
import type { AppLaunchRepairContext } from "../agent/tools/types"
import { createConversation } from "../db/repositories/conversations"
import * as features from "../db/repositories/features"
import { getRigGraph } from "../db/repositories/rigs"
import { createTask } from "../db/repositories/tasks"
import { getWorkspace } from "../db/repositories/workspaces"
import { appLaunchContextSection, stopServices } from "./app-launch"
import type { RepairTurn } from "./app-recipe"
import { renderIntentChain } from "./intent-chain"
import { narrowedSeatAgent, seatContextSection } from "./seat-context"
import { resolveSeatBindings } from "./seat-resolver"
import type { SeatTurnIdentity } from "./seat-turns"

// The repair seat (plan 112.3, open question 4): the builder seat with a
// recipe-only objective, as a `work` turn in a fresh conversation through
// the existing seat machinery. It already knows the stack, and no rig role
// is added. Its tools are narrowed to reading, diagnostic commands, and the
// app tools (app_launch_save among them): it repairs the recipe, not the
// product. Writing recipe-adjacent files (an .env.example) waits for 112.4's
// write scope; until then a key only the user has becomes a question.

// Read, search, and run diagnostics. No file writes, no delegation.
export const REPAIR_TOOL_NAMES = new Set([
  "read_file_tool",
  "list_files_tool",
  "search_tool",
  "stat_path",
  "index_query_tool",
  "read_document",
  "exec_command",
  "run_shell_tool",
  "poll_command",
  "write_stdin",
  "terminate_command",
])

export interface RepairTurnDeps {
  loadAgents(workspace: string): Promise<AgentDefinition[]>
  runTurn(input: {
    conversationId: string
    taskId: string
    workspace: string
    objective: string
    agentOverride: AgentDefinition
    contextSections: ContextSection[]
    seat: SeatTurnIdentity
    repair: AppLaunchRepairContext
    allowedToolNames: Set<string>
    signal?: AbortSignal
  }): Promise<unknown>
}

export function createRepairTurn(deps: RepairTurnDeps): RepairTurn {
  return async (input) => {
    const feature = features.getFeature(input.featureId)
    // A draft has no rig snapshot yet (Start takes it): use the live rig, as
    // the analysis does, so "Check now" can repair before the feature starts.
    const rig =
      feature?.rigSnapshot ??
      (feature?.rigId ? getRigGraph(feature.rigId) : null)
    if (!feature || !rig)
      throw new Error("The feature has no rig to repair the recipe with.")
    const story = input.userStoryId
      ? features.getUserStory(input.userStoryId)
      : null
    const milestone = story ? features.getMilestone(story.milestoneId) : null
    const agents = await deps.loadAgents(input.mainRoot)
    const bindings = resolveSeatBindings({
      rig,
      podKey: story?.podKey ?? feature.defaultPodKey,
      roles: ["builder"],
      agents,
      intentChain: renderIntentChain({
        feature,
        milestone: milestone ?? null,
        userStory: story ?? null,
      }),
    })
    const address = bindings.roles.builder?.[0]
    const seat = address ? bindings.seats[address] : undefined
    if (!seat)
      throw new Error("The rig has no builder seat to repair the recipe.")
    const agent = agents.find(
      (a) => a.name === seat.agentName || a.refId === seat.agentName
    )
    if (!agent)
      throw new Error(
        `Seat ${seat.address}'s agent (${seat.agentLabel}) is no longer available.`
      )
    const workspace = feature.workspaceId
      ? getWorkspace(feature.workspaceId)
      : null
    const conversation = createConversation({
      mode: "interactive",
      workspaceId: feature.workspaceId,
      workingDirectory: input.root === input.mainRoot ? null : input.root,
      accountId: seat.runtime?.accountId ?? null,
      modelId: seat.runtime?.modelId ?? null,
      agentName: seat.agentName,
      title: `Recipe repair: ${seat.address}`,
    })
    // Backed by a task row, like a phase worker, so it isn't a standalone chat.
    const task = createTask({
      conversationId: conversation.id,
      status: "completed",
      title: "Recipe repair",
      input: { kind: "recipe_repair", featureId: feature.id },
    })
    try {
      await deps.runTurn({
        conversationId: conversation.id,
        taskId: task.id,
        workspace: input.root,
        objective: input.objective,
        agentOverride: narrowedSeatAgent(agent, seat),
        contextSections: [
          seatContextSection(bindings, seat),
          appLaunchContextSection(
            workspace?.appLaunch ?? { services: [] },
            "builder"
          ),
        ],
        seat: {
          featureId: feature.id,
          address: seat.address,
          profile: "work",
          anchor: story ? { kind: "user_story", id: story.id } : null,
          wakeHop: null,
        },
        repair: {
          featureId: feature.id,
          userStoryId: input.userStoryId,
          owner: input.owner,
          mainRoot: input.mainRoot,
        },
        allowedToolNames: REPAIR_TOOL_NAMES,
        signal: input.signal,
      })
    } finally {
      await stopServices({ owner: input.owner }).catch(() => {})
    }
  }
}
