import { expect, it } from "vitest"
import { projectCommandOutcomes } from "./command-outcomes"
import {
  buildTimeline,
  projectTimelineCommandOutcomes,
  type ToolUse,
} from "./timeline"
import { renderContextEnvelope } from "../../../shared/context-provenance"
import type { Message } from "@/types"
const call = (
  id: string,
  sessionId: string,
  status = "running",
  conversationId = "c",
  exitCode: number | null = null
): ToolUse => ({
  id,
  name: "exec_command",
  label: "Same command",
  args: { command: "echo same" },
  rawArgs: "{}",
  status: "done",
  conversationId,
  result: JSON.stringify({
    status,
    sessionId,
    exitCode,
    signal: null,
    output: id,
  }),
})
it("joins by owned session, not identical command text; retains every original output", () => {
  const calls = [
    call("a", "s1"),
    call("b", "s2"),
    call("final", "s1", "completed", "c", 0),
  ]
  const projected = projectCommandOutcomes(calls)
  expect(projected[0].commandOutcome?.exitCode).toBe(0)
  expect(projected[1]).toBe(calls[1])
  expect(projected.map((c) => c.result)).toEqual(calls.map((c) => c.result))
  expect(calls[0].commandOutcome).toBeUndefined()
})
it("isolates owners, tolerates out of order and duplicate snapshots, and refuses conflicting finals", () => {
  const launch = call("launch", "s")
  const final = call("final", "s", "completed", "c", 0)
  expect(
    projectCommandOutcomes([final, final, launch])[2].commandOutcome?.exitCode
  ).toBe(0)
  expect(
    projectCommandOutcomes([
      call("other", "s", "completed", "other", 0),
      launch,
    ])[1].commandOutcome
  ).toBeUndefined()
  expect(
    projectCommandOutcomes([
      final,
      call("conflict", "s", "completed", "c", 1),
      launch,
    ])[2].commandOutcome
  ).toBeUndefined()
})
it("keeps unknown history neutral and uses identical projection across live and replay groups", () => {
  const launch = call("launch", "s")
  expect(projectCommandOutcomes([launch])[0]).toBe(launch)
  const groups = [
    { kind: "tools", calls: [launch] },
    { kind: "text" },
    { kind: "tools", calls: [call("end", "s", "completed", "c", 2)] },
  ]
  const live = projectTimelineCommandOutcomes(groups)
  const replay = projectTimelineCommandOutcomes(
    JSON.parse(JSON.stringify(groups))
  )
  expect(live).toEqual(replay)
  expect(live[0].calls?.[0].commandOutcome?.exitCode).toBe(2)
  expect(projectTimelineCommandOutcomes(live)).toEqual(live)
})

it("restores final output from hidden runtime completion envelopes without displaying runtime messages", () => {
  const launch = call("launch", "s")
  const completion = {
    eventId: "event",
    runId: "run",
    sessionId: "s",
    status: "completed",
    exitCode: 0,
    signal: null,
    output: "finished output\n",
  }
  const rows = [
    {
      id: "assistant",
      conversationId: "c",
      role: "assistant",
      content: null,
      toolCalls: [
        { id: launch.id, name: launch.name, arguments: launch.rawArgs },
      ],
    },
    {
      id: "result",
      conversationId: "c",
      role: "tool",
      toolCallId: launch.id,
      content: launch.result,
    },
    {
      id: "event",
      conversationId: "c",
      role: "system",
      content:
        "Runtime event: background command completion(s).\n\n" +
        renderContextEnvelope(
          {
            trust: "untrusted_data",
            channel: "command",
            source: "background_command_completion",
          },
          JSON.stringify(
            {
              type: "background_command_completions",
              completions: [completion],
            },
            null,
            2
          )
        ),
    },
  ].map((row) => ({
    seq: 0,
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    tokenEstimate: null,
    createdAt: 0,
    ...row,
    content: row.content ?? null,
  })) as Message[]
  const timeline = buildTimeline(rows)
  expect(timeline).toHaveLength(1)
  expect(
    timeline[0].kind === "tools" && timeline[0].calls[0].commandOutcome
  ).toMatchObject(completion)
  expect(timeline[0].kind === "tools" && timeline[0].calls[0].result).toBe(
    launch.result
  )
})
