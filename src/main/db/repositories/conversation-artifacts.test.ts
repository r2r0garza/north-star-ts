import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { sqliteLoadsForTests } from "../../test/sqlite"
import { runMigrations } from "../migrations"

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))
import { createConversation } from "./conversations"
import { appendMessage, listMessages } from "./messages"
import {
  getToolCallLifecycle,
  markToolCallSettled,
  markToolCallStarted,
  markToolCallUnknown,
  recordToolCallIntents,
} from "./tool-call-lifecycle"
import {
  readConversationArtifact,
  toolArtifactReference,
} from "./conversation-artifacts"
import {
  ARTIFACT_LIMITS,
  type ArtifactPresentation,
  validateTableSnapshot,
  validateChartSnapshot,
  validateUiConceptSnapshot,
} from "../../../shared/conversation-artifacts"
import { presentChartTool } from "../../agent/tools/present_chart"
import { runToolCallBatches } from "../../agent/tool-batch-scheduler"

import { validateVisualSnapshot } from "../../../shared/openui-visual"

const sqliteLoads = sqliteLoadsForTests()
const input = {
  title: "Revenue",
  chartKind: "line",
  xKey: "month",
  series: [{ key: "revenue", label: "Revenue" }],
  data: [
    { month: "Jan", revenue: 0 },
    { month: "Feb", revenue: null },
  ],
}
const snapshot = validateChartSnapshot(input)
function start(
  conversationId: string,
  toolCallId = "call-1",
  args: unknown = input,
  name = "present_chart"
) {
  const call = {
    id: toolCallId,
    name,
    arguments: JSON.stringify(args),
  }
  const assistant = appendMessage({
    conversationId,
    role: "assistant",
    content: null,
    toolCalls: [call],
  })
  recordToolCallIntents({
    conversationId,
    assistantMessageId: assistant.id,
    logicalRoundId: toolCallId,
    calls: [call],
  })
  return markToolCallStarted({ conversationId, toolCallId })!
}
function settle(conversationId: string, toolCallId = "call-1") {
  return markToolCallSettled({
    conversationId,
    toolCallId,
    state: "settled_success",
    result: "staged",
    presentationArtifact: snapshot,
  })!
}
function count() {
  return (
    db
      .prepare("SELECT count(*) AS n FROM conversation_artifact_revisions")
      .get() as { n: number }
  ).n
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})
afterEach(() => db?.close())

describe.skipIf(!sqliteLoads)("durable chart vertical slice", () => {
  it("stages a tool chart, atomically settles, reads exact content and replays the same invocation", async () => {
    const conversationId = createConversation({ mode: "chat" }).id
    const owner = start(conversationId)
    let staged: ArtifactPresentation | undefined
    await presentChartTool.execute(input, {
      workspace: "",
      conversationId,
      invocationId: owner.invocationId,
      emitArtifact: (s) => {
        staged = s
      },
    })
    expect(count()).toBe(0)
    const settled = markToolCallSettled({
      conversationId,
      toolCallId: owner.toolCallId,
      state: "settled_success",
      presentationArtifact: staged,
    })!
    const ref = toolArtifactReference(conversationId, owner.toolCallId)!
    expect(JSON.parse(settled.result!)).toEqual({
      ...ref,
      status: "saved_for_presentation",
    })
    expect(settled.result).not.toContain('"data"')
    expect(
      readConversationArtifact(conversationId, ref.artifactId, ref.revision)
        .artifact?.snapshot
    ).toEqual(snapshot)
    expect(
      readConversationArtifact(conversationId, ref.artifactId, ref.revision + 1)
        .error
    ).toMatch(/unavailable/)
    expect(settle(conversationId).result).toBe(settled.result)
    start(conversationId, "retry")
    expect(settle(conversationId, "retry").result).toBe(settled.result)
    expect(toolArtifactReference(conversationId, "retry")).toEqual(ref)
    expect(count()).toBe(1)
    const message = appendMessage({
      conversationId,
      role: "tool",
      toolCallId: owner.toolCallId,
      toolName: "present_chart",
      content: settled.result,
    })
    expect(message.artifact).toEqual(ref)
    expect(
      listMessages(conversationId).find((row) => row.id === message.id)
        ?.artifact
    ).toEqual(ref)
    const unrelated = appendMessage({
      conversationId,
      role: "tool",
      toolCallId: "unrelated",
      toolName: "other",
      content: settled.result,
    })
    expect(unrelated.artifact).toBeUndefined()
    runMigrations(db)
    expect(toolArtifactReference(conversationId, owner.toolCallId)).toEqual(ref)
  })
  it("publishes only recoverable acknowledgements after scheduler settlement", async () => {
    const conversationId = createConversation({ mode: "chat" }).id
    const owner = start(conversationId)
    const done = vi.fn((_call, result: string) => {
      const ref = JSON.parse(result)
      expect(
        readConversationArtifact(conversationId, ref.artifactId, ref.revision)
          .artifact?.snapshot
      ).toEqual(snapshot)
    })
    await runToolCallBatches(
      [
        {
          id: owner.toolCallId,
          name: "present_chart",
          arguments: JSON.stringify(input),
        },
      ],
      {
        effectsFor: () => presentChartTool.effects,
        execute: async (_call, _index, signal) => {
          let presentationArtifact: ArtifactPresentation | undefined
          const result = await presentChartTool.execute(input, {
            workspace: "",
            conversationId,
            invocationId: owner.invocationId,
            signal,
            emitArtifact: (s) => {
              presentationArtifact = s
            },
          })
          return { result, presentationArtifact }
        },
        onSettled: (result) => {
          const saved = markToolCallSettled({
            conversationId,
            toolCallId: owner.toolCallId,
            state: "settled_success",
            presentationArtifact: result.presentationArtifact,
          })!
          result.result = saved.result!
        },
        onDone: done,
      }
    )
    expect(done).toHaveBeenCalledOnce()
  })
  it("rolls back artifact content, association and completion together on transaction failure", () => {
    const conversationId = createConversation({ mode: "chat" }).id
    start(conversationId)
    db.exec(
      `CREATE TRIGGER fail_chart_settlement BEFORE UPDATE ON tool_call_lifecycle WHEN NEW.state = 'settled_success' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`
    )
    expect(() => settle(conversationId)).toThrow("injected failure")
    expect(count()).toBe(0)
    expect(toolArtifactReference(conversationId, "call-1")).toBeUndefined()
    expect(getToolCallLifecycle(conversationId, "call-1")?.state).toBe(
      "started"
    )
    db.exec("DROP TRIGGER fail_chart_settlement")
    expect(settle(conversationId).state).toBe("settled_success")
  })
  it("rejects cross-conversation reads and cleans up with conversation deletion", () => {
    const conversationId = createConversation({ mode: "chat" }).id
    const otherId = createConversation({ mode: "chat" }).id
    start(conversationId)
    settle(conversationId)
    const ref = toolArtifactReference(conversationId, "call-1")!
    expect(
      readConversationArtifact(otherId, ref.artifactId, ref.revision).error
    ).toMatch(/not owned/)
    expect(toolArtifactReference(otherId, "call-1")).toBeUndefined()
    db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId)
    expect(count()).toBe(0)
    expect(
      readConversationArtifact(conversationId, ref.artifactId, ref.revision)
        .error
    ).toBeDefined()
  })
  it("rejects removed/spoofed invocation owners and never saves failed or interrupted output", () => {
    const conversationId = createConversation({ mode: "chat" }).id
    const owner = start(conversationId)
    db.prepare("UPDATE messages SET tool_calls = '[]' WHERE id = ?").run(
      owner.assistantMessageId
    )
    expect(() => settle(conversationId)).toThrow(/owner/)
    expect(count()).toBe(0)
    markToolCallSettled({
      conversationId,
      toolCallId: "call-1",
      state: "settled_error",
      presentationArtifact: snapshot,
    })
    start(conversationId, "interrupted")
    markToolCallUnknown({ conversationId, toolCallId: "interrupted" })
    expect(settle(conversationId, "interrupted").state).toBe("unknown")
    expect(count()).toBe(0)
  })
  it("revalidates host emissions and requires snapshot on successful completion", () => {
    const conversationId = createConversation({ mode: "chat" }).id
    start(conversationId)
    expect(() =>
      markToolCallSettled({
        conversationId,
        toolCallId: "call-1",
        state: "settled_success",
      })
    ).toThrow(/requires/)
    expect(() =>
      markToolCallSettled({
        conversationId,
        toolCallId: "call-1",
        state: "settled_success",
        presentationArtifact: { ...snapshot, schemaVersion: 2 } as never,
      })
    ).toThrow(/version/)
    expect(count()).toBe(0)
  })
  it("returns bounded fallbacks for unknown versions and corrupt content", () => {
    const conversationId = createConversation({ mode: "chat" }).id
    start(conversationId)
    settle(conversationId)
    const ref = toolArtifactReference(conversationId, "call-1")!
    for (const bad of ['{"kind":"chart","schemaVersion":2}', "not json"]) {
      db.prepare("UPDATE conversation_artifact_revisions SET snapshot = ?").run(
        bad
      )
      expect(
        readConversationArtifact(conversationId, ref.artifactId, 1).error
      ).toMatch(/unsupported or corrupt/)
    }
  })
  it("enforces per-conversation count and byte quotas without partial writes", () => {
    const conversationId = createConversation({ mode: "chat" }).id
    for (let i = 0; i < ARTIFACT_LIMITS.conversationRevisions; i++) {
      const args = { ...input, title: `Chart ${i}` }
      start(conversationId, `call-${i}`, args)
      markToolCallSettled({
        conversationId,
        toolCallId: `call-${i}`,
        state: "settled_success",
        presentationArtifact: validateChartSnapshot(args),
      })
    }
    start(conversationId, "overflow")
    expect(settle(conversationId, "overflow")).toMatchObject({
      state: "settled_error",
      result: expect.stringContaining("artifact_quota"),
    })
    expect(count()).toBe(ARTIFACT_LIMITS.conversationRevisions)
    const otherId = createConversation({ mode: "chat" }).id
    const large = validateChartSnapshot({
      ...input,
      data: Array(900).fill({ month: "x".repeat(250), revenue: 1 }),
    })
    for (let i = 0; i < 40; i++) {
      const args = { ...large, title: `Large ${i}` }
      start(otherId, `large-${i}`, args)
      markToolCallSettled({
        conversationId: otherId,
        toolCallId: `large-${i}`,
        state: "settled_success",
        presentationArtifact: args,
      })
    }
    expect(getToolCallLifecycle(otherId, "large-39")?.state).toBe(
      "settled_error"
    )
  })
})

describe.skipIf(!sqliteLoads)("table storage and revision conflicts", () => {
  const table = validateTableSnapshot({
    title: "Scores",
    source: "Supplied results",
    columns: [{ key: "score", label: "Score", valueType: "number" }],
    data: [{ score: 0 }, { score: null }],
  })
  function complete(
    conversationId: string,
    toolCallId: string,
    presentationArtifact: ArtifactPresentation
  ) {
    return markToolCallSettled({
      conversationId,
      toolCallId,
      state: "settled_success",
      presentationArtifact,
    })!
  }
  it("stores tables, projects references and preserves exact old revisions", () => {
    const c = createConversation({ mode: "chat" }).id
    start(c, "table-1", table, "present_table")
    complete(c, "table-1", table)
    const original = toolArtifactReference(c, "table-1")!
    expect(original).toMatchObject({ kind: "table", revision: 1, rowCount: 2 })
    const updated = {
      ...table,
      title: "Updated scores",
      data: [{ score: 4 }],
      artifactId: original.artifactId,
      expectedBaseRevision: 1,
    }
    start(c, "table-2", updated, "present_table")
    complete(c, "table-2", updated)
    const next = toolArtifactReference(c, "table-2")!
    expect(next).toMatchObject({
      artifactId: original.artifactId,
      revision: 2,
      rowCount: 1,
    })
    expect(
      readConversationArtifact(c, original.artifactId, 1).artifact?.snapshot
    ).toEqual(table)
    expect(
      readConversationArtifact(c, next.artifactId, 2).artifact?.snapshot.title
    ).toBe("Updated scores")
    expect(count()).toBe(2)
    complete(c, "table-2", updated)
    expect(count()).toBe(2)
    expect(
      JSON.parse(getToolCallLifecycle(c, "table-2")!.result!).revision
    ).toBe(2)
  })
  it("settles stale, foreign, missing and cross-kind revision requests as recoverable errors", () => {
    const c = createConversation({ mode: "chat" }).id
    const other = createConversation({ mode: "chat" }).id
    start(c)
    settle(c)
    const ref = toolArtifactReference(c, "call-1")!
    const revision = {
      ...snapshot,
      artifactId: ref.artifactId,
      expectedBaseRevision: 1,
    }
    start(c, "winner", revision)
    const competing = { ...revision, title: "Competing revision" }
    start(c, "stale", competing)
    expect(complete(c, "winner", revision).state).toBe("settled_success")
    expect(complete(c, "stale", competing).result).toContain(
      "ERROR[artifact_conflict]"
    )
    start(other, "foreign", revision)
    expect(complete(other, "foreign", revision).state).toBe("settled_error")
    const crossKind = {
      ...table,
      artifactId: ref.artifactId,
      expectedBaseRevision: 2,
    }
    start(c, "cross-kind", crossKind, "present_table")
    expect(complete(c, "cross-kind", crossKind).state).toBe("settled_error")
    const missing = { ...revision, artifactId: "missing" }
    start(c, "missing", missing)
    expect(complete(c, "missing", missing).state).toBe("settled_error")
    expect(toolArtifactReference(c, "stale")).toBeUndefined()
    expect(count()).toBe(2)
    expect(
      readConversationArtifact(c, ref.artifactId, 1).artifact?.snapshot
    ).toEqual(snapshot)
  })
})

describe.skipIf(!sqliteLoads)("UI concept storage", () => {
  const concept = validateUiConceptSnapshot({
    title: "Settings concept",
    tree: { type: "stack", children: [{ type: "text", text: "Draft" }] },
  })
  function complete(id: string, toolCallId: string, artifact: unknown) {
    return markToolCallSettled({
      conversationId: id,
      toolCallId,
      state: "settled_success",
      presentationArtifact: artifact as ArtifactPresentation,
    })!
  }
  it("stores concepts through the shared revision path and rejects cross-kind updates", () => {
    const c = createConversation({ mode: "chat" }).id
    start(c, "ui-1", concept, "present_ui")
    complete(c, "ui-1", concept)
    const ref = toolArtifactReference(c, "ui-1")!
    expect(ref).toMatchObject({ kind: "ui_concept", revision: 1, rowCount: 0 })
    const revised = {
      ...concept,
      title: "Settings concept v2",
      artifactId: ref.artifactId,
      expectedBaseRevision: 1,
    }
    start(c, "ui-2", revised, "present_ui")
    complete(c, "ui-2", revised)
    expect(toolArtifactReference(c, "ui-2")).toMatchObject({ revision: 2 })
    expect(
      readConversationArtifact(c, ref.artifactId, 1).artifact?.snapshot
    ).toEqual(concept)
    // A chart cannot revise a concept, and a concept tool cannot save a chart.
    const asChart = {
      ...snapshot,
      artifactId: ref.artifactId,
      expectedBaseRevision: 2,
    }
    start(c, "chart-x", asChart)
    expect(complete(c, "chart-x", asChart).state).toBe("settled_error")
    start(c, "ui-x", snapshot, "present_ui")
    expect(() => complete(c, "ui-x", snapshot)).toThrow()
    expect(count()).toBe(2)
  })
})

describe.skipIf(!sqliteLoads)("durable visual answer vertical slice", () => {
  const visual = validateVisualSnapshot({
    title: "Summary",
    library: "north-star-static-v1",
    document: 'root = Text("Synthetic evidence");',
    datasets: [],
  })
  it("settles, reloads exact revisions, rejects conflicts and preserves idempotency", () => {
    const conversationId = createConversation({ mode: "chat" }).id
    const owner = start(conversationId, "visual-1", visual, "present_visual")
    const first = markToolCallSettled({
      conversationId,
      toolCallId: owner.toolCallId,
      state: "settled_success",
      presentationArtifact: visual,
    })!
    const ref = toolArtifactReference(conversationId, owner.toolCallId)!
    expect(
      readConversationArtifact(conversationId, ref.artifactId, 1).artifact
        ?.snapshot
    ).toEqual(visual)
    expect(
      markToolCallSettled({
        conversationId,
        toolCallId: owner.toolCallId,
        state: "settled_success",
        presentationArtifact: visual,
      })?.result
    ).toBe(first.result)
    const revised = {
      ...visual,
      title: "Revision two",
      artifactId: ref.artifactId,
      expectedBaseRevision: 1,
    }
    start(conversationId, "visual-2", revised, "present_visual")
    markToolCallSettled({
      conversationId,
      toolCallId: "visual-2",
      state: "settled_success",
      presentationArtifact: revised,
    })
    expect(
      readConversationArtifact(conversationId, ref.artifactId, 1).artifact
        ?.snapshot.title
    ).toBe("Summary")
    expect(
      readConversationArtifact(conversationId, ref.artifactId, 2).artifact
        ?.snapshot.title
    ).toBe("Revision two")
    const stale = { ...revised, title: "Stale distinct revision" }
    start(conversationId, "visual-conflict", stale, "present_visual")
    expect(
      markToolCallSettled({
        conversationId,
        toolCallId: "visual-conflict",
        state: "settled_success",
        presentationArtifact: stale,
      })?.result
    ).toContain("ERROR[artifact_conflict]")
    const message = appendMessage({
      conversationId,
      role: "tool",
      toolCallId: owner.toolCallId,
      toolName: "present_visual",
      content: first.result,
    })
    expect(
      listMessages(conversationId).find((m) => m.id === message.id)?.artifact
    ).toEqual(ref)
    expect(
      readConversationArtifact(
        createConversation({ mode: "chat" }).id,
        ref.artifactId,
        1
      ).error
    ).toMatch(/unavailable/)
  })
  it("does not persist cancelled or malformed visual results", () => {
    const conversationId = createConversation({ mode: "chat" }).id
    start(conversationId, "cancelled-visual", visual, "present_visual")
    markToolCallSettled({
      conversationId,
      toolCallId: "cancelled-visual",
      state: "settled_error",
      result: "ERROR[cancelled]: cancelled",
      presentationArtifact: visual,
    })
    expect(count()).toBe(0)
    start(conversationId, "invalid-visual", visual, "present_visual")
    expect(() =>
      markToolCallSettled({
        conversationId,
        toolCallId: "invalid-visual",
        state: "settled_success",
        presentationArtifact: { ...visual, library: "future" } as never,
      })
    ).toThrow()
    expect(count()).toBe(0)
  })
})
