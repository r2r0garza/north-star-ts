// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import type { Message } from "../../../main/db/types"
import type { WorkflowRun } from "../../../shared/workflow-runs"
import type { Task } from "@/types"
import { EXAMPLE_WORKFLOWS } from "../../../main/db/workflow-schema"
import { TaskTranscriptSheet } from "./task-transcript-sheet"
import { RunDetail } from "./run-detail"
vi.mock("@/components/markdown", () => ({
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
}))
vi.mock("@/components/conversation-artifact", () => ({
  ConversationArtifact: ({
    reference,
    conversationId,
  }: {
    reference: { artifactId: string; revision: number }
    conversationId: string
  }) => (
    <div data-testid="artifact">
      {conversationId}:{reference.artifactId}:{reference.revision}
    </div>
  ),
}))

it.each(["task", "workflow"])(
  "renders exact %s snapshots outside collapsed traces without duplicating results",
  async (reader) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    const message = (id: string, fields: Partial<Message>): Message => ({
      id,
      conversationId: "private-conversation",
      seq: 0,
      role: "assistant",
      content: null,
      toolCalls: null,
      toolCallId: null,
      toolName: null,
      tokenEstimate: null,
      createdAt: 0,
      ...fields,
    })
    const reference = {
      schemaVersion: 1 as const,
      artifactId: "saved-table",
      revision: 2,
      kind: "table" as const,
      title: "Results",
      rowCount: 2,
    }
    const messages = [
      message("before", {
        content: "Before",
        toolCalls: [{ id: "present", name: "present_table", arguments: "{}" }],
      }),
      message("result", {
        role: "tool",
        toolCallId: "present",
        toolName: "present_table",
        content: "saved_for_presentation",
        artifact: reference,
      }),
      message("after", { content: "After" }),
    ]
    const list = vi.fn(async () => messages)
    vi.stubGlobal("cowork", {
      providers: { listWithModels: vi.fn(async () => []) },
      tasks: { onEvent: () => () => {} },
      db: { messages: { list } },
    })
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    const workflow = EXAMPLE_WORKFLOWS[0]
    const run = {
      id: "run",
      title: "Artifact run",
      objective: "Show results",
      status: "Completed",
      workflowId: workflow.id,
      workflow,
      steps: [
        {
          ...workflow.steps[0],
          status: "completed",
          conversationId: "private-conversation",
          result: null,
          error: null,
        },
      ],
    } as WorkflowRun
    try {
      await act(async () =>
        root.render(
          reader === "task" ? (
            <TaskTranscriptSheet
              task={
                {
                  id: "task",
                  title: "Artifact task",
                  conversationId: "private-conversation",
                  status: "completed",
                } as Task
              }
              open
              onOpenChange={() => {}}
            />
          ) : (
            <RunDetail
              run={run}
              workflow={workflow}
              onBack={() => {}}
              onClose={() => {}}
            />
          )
        )
      )
      if (reader === "workflow") {
        const transcript =
          container.querySelector<HTMLButtonElement>("nav ol button")!
        await act(async () => transcript.click())
      }
      const artifacts = document.querySelectorAll('[data-testid="artifact"]')
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0].textContent).toBe(
        "private-conversation:saved-table:2"
      )
      expect(
        artifacts[0].closest('[data-slot="trace-collapsible-content"]')
      ).toBeNull()
      expect(list).toHaveBeenCalledWith("private-conversation")
      const text = artifacts[0].parentElement?.parentElement?.textContent ?? ""
      expect(text).not.toContain("saved_for_presentation")
    } finally {
      act(() => root.unmount())
      container.remove()
      vi.unstubAllGlobals()
    }
  }
)
