// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
  GateCard,
  ProcessBuilder,
  PhaseCompletionEvidence,
  RunCompletionSummary,
  PhaseAttemptHistory,
  recoverProcessMonitorGates,
} from "./process-screen"
import type {
  Approval,
  ProcessRun,
  ProcessPhaseAttempt,
  TaskEventPayload,
} from "@/types"

let container: HTMLDivElement
let root: Root

const handlers = () => ({
  onApprove: vi.fn(),
  onDeny: vi.fn(),
  onRequestChanges: vi.fn(),
  onRetryReview: vi.fn(),
  onViewDetails: vi.fn(),
})

function clickByText(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((el) =>
    el.textContent?.includes(text)
  )
  expect(button).toBeTruthy()
  act(() => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve()
  })
}

function approval(input: {
  id: string
  taskId?: string
  status: Approval["status"]
  request: unknown
  decision?: unknown
}): Approval {
  return {
    id: input.id,
    taskId: input.taskId ?? "task-1",
    status: input.status,
    request: input.request,
    decision: input.decision ?? null,
    requestedAt: 1,
    resolvedAt: input.status === "pending" ? null : 2,
  }
}

function gateEvent(input: {
  phaseRunId: string
  requestId: string
  gateKind: "phase" | "validator" | "flag"
}): TaskEventPayload {
  return {
    type: "process_phase",
    runId: "run-1",
    phaseRunId: input.phaseRunId,
    phaseKey: "impl",
    agentName: "impl-agent",
    status: "waiting_for_approval",
    requestId: input.requestId,
    gateKind: input.gateKind,
  }
}

function phaseAttempt(
  input: Partial<ProcessPhaseAttempt> = {}
): ProcessPhaseAttempt {
  return {
    id: input.id ?? "attempt-1",
    runId: input.runId ?? "run-1",
    phaseRunId: input.phaseRunId ?? "phase-run-1",
    phaseId: input.phaseId ?? "phase-1",
    taskId: input.taskId ?? "task-parent",
    workerTaskId: input.workerTaskId ?? "task-worker",
    agentName: input.agentName ?? "impl-agent",
    stage: input.stage ?? "tool_execution",
    status: "failed",
    attempt: input.attempt ?? 1,
    maxAttempts: input.maxAttempts ?? 3,
    error: input.error ?? "tool failed",
    failure: input.failure ?? {
      code: "tool_failed",
      stage: "tool_execution",
      message: "Tool execution failed",
      retryable: true,
      attempt: input.attempt ?? 1,
      maxAttempts: input.maxAttempts ?? 3,
      runId: input.runId ?? "run-1",
      phaseRunId: input.phaseRunId ?? "phase-run-1",
      phaseId: input.phaseId ?? "phase-1",
      taskId: input.taskId ?? "task-parent",
      workerTaskId: input.workerTaskId ?? "task-worker",
      agentName: input.agentName ?? "impl-agent",
      occurredAt: input.createdAt ?? Date.UTC(2026, 8, 2, 12, 0),
    },
    createdAt: input.createdAt ?? Date.UTC(2026, 8, 2, 12, 0),
  }
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { cowork?: unknown }).cowork
  vi.restoreAllMocks()
})

describe("PhaseAttemptHistory", () => {
  it("stays hidden when a legacy phase row has no attempt records", async () => {
    const list = vi.fn().mockResolvedValue([])
    ;(window as unknown as { cowork: unknown }).cowork = {
      db: {
        processes: {
          phaseAttempts: { list },
        },
      },
    }

    await act(async () => {
      root.render(
        <PhaseAttemptHistory phaseRunId="phase-run-1" onOpenTask={vi.fn()} />
      )
    })
    await flushPromises()

    expect(list).toHaveBeenCalledWith({ phaseRunId: "phase-run-1" })
    expect(container.textContent).not.toContain("Attempt history")
  })

  it("renders durable failed attempts and opens the worker transcript", async () => {
    const list = vi.fn().mockResolvedValue([
      phaseAttempt({
        id: "attempt-1",
        attempt: 1,
        maxAttempts: 3,
        workerTaskId: "worker-task-1",
      }),
    ])
    const onOpenTask = vi.fn()
    ;(window as unknown as { cowork: unknown }).cowork = {
      db: {
        processes: {
          phaseAttempts: { list },
        },
      },
    }

    await act(async () => {
      root.render(
        <PhaseAttemptHistory phaseRunId="phase-run-1" onOpenTask={onOpenTask} />
      )
    })
    await flushPromises()

    expect(container.textContent).toContain("Attempt history")
    clickByText("Attempt history")

    expect(container.textContent).toContain("attempt 1/3")
    expect(container.textContent).toContain("tool_execution")
    expect(container.textContent).toContain("tool_failed")
    expect(container.textContent).toContain("retryable")
    expect(container.textContent).toContain("Tool execution failed")

    clickByText("Transcript")
    expect(onOpenTask).toHaveBeenCalledWith("worker-task-1")
  })
})

describe("GateCard", () => {
  it("renders a normal phase approval gate without validator retry controls", () => {
    const props = handlers()
    act(() => {
      root.render(
        <GateCard
          name="Implement"
          requestId="req-1"
          phaseRunId="phase-run-1"
          gateKind="phase"
          reworkRound={0}
          maxReworkRounds={0}
          isContainer={false}
          {...props}
        />
      )
    })

    expect(container.textContent).toContain(
      "approve to release its downstream phases"
    )
    expect(container.textContent).toContain("Approve")
    expect(container.textContent).not.toContain("Retry review")
    expect(container.textContent).not.toContain("Manual override")
  })

  it("renders validator-unavailable gates with retry and manual override actions", () => {
    const props = handlers()
    act(() => {
      root.render(
        <GateCard
          name="Implement"
          requestId="req-2"
          phaseRunId="phase-run-2"
          gateKind="validator"
          reworkRound={0}
          maxReworkRounds={3}
          isContainer={false}
          packet={
            {
              summary: {
                outcome:
                  "Implement could not be validated: validator returned an unparseable verdict",
                materialChanges: [],
                validationSummary: "No validation commands were recorded.",
                caveats: [],
              },
              artifacts: [],
              validations: [],
              evidenceWarnings: [],
            } as never
          }
          {...props}
        />
      )
    })

    expect(container.textContent).toContain("validator review is unavailable")
    expect(container.textContent).toContain(
      "validator returned an unparseable verdict"
    )
    expect(container.textContent).toContain("Retry review")
    expect(container.textContent).toContain("Manual override")

    clickByText("Retry review")
    expect(props.onRetryReview).toHaveBeenCalledWith("req-2", "phase-run-2")
    expect(props.onApprove).not.toHaveBeenCalled()

    clickByText("Manual override")
    expect(props.onApprove).toHaveBeenCalledWith("req-2", "phase-run-2")
  })

  it("renders exhausted validator gates with retry and manual override actions", () => {
    const props = handlers()
    act(() => {
      root.render(
        <GateCard
          name="Implement"
          requestId="req-3"
          phaseRunId="phase-run-3"
          gateKind="validator"
          reworkRound={0}
          maxReworkRounds={3}
          isContainer={false}
          packet={
            {
              summary: {
                outcome: "Implement exhausted validator review rounds.",
                materialChanges: [],
                validationSummary: "No validation commands were recorded.",
                caveats: [],
              },
              artifacts: [],
              validations: [],
              evidenceWarnings: [],
            } as never
          }
          {...props}
        />
      )
    })

    expect(container.textContent).toContain("exhausted validator review rounds")
    expect(container.textContent).toContain("Retry review")
    expect(container.textContent).toContain("Manual override")
  })
})

describe("recoverProcessMonitorGates", () => {
  it("recovers pending validator-unavailable actions from durable rows after reload", () => {
    const request = {
      kind: "process_validator_gate",
      phaseKey: "impl",
      phaseRunId: "phase-run-1",
      requestId: "req-1",
      approvalPacket: {
        summary: {
          outcome:
            "Implement could not be validated: validator returned an unparseable verdict",
        },
      },
    }

    const recovered = recoverProcessMonitorGates({
      events: [
        gateEvent({
          phaseRunId: "phase-run-1",
          requestId: "req-1",
          gateKind: "validator",
        }),
      ],
      approvals: [approval({ id: "approval-1", status: "pending", request })],
    })

    expect(recovered.gates).toEqual({
      "phase-run-1": { requestId: "req-1", gateKind: "validator" },
    })
    expect(recovered.requests["req-1"]).toBe(request)
  })

  it("keeps a fresh pending retry-review gate when an older gate is settled", () => {
    const oldRequest = {
      kind: "process_validator_gate",
      phaseKey: "impl",
      phaseRunId: "phase-run-1",
      requestId: "old-req",
    }
    const freshRequest = {
      kind: "process_validator_gate",
      phaseKey: "impl",
      phaseRunId: "phase-run-1",
      requestId: "fresh-req",
    }

    const recovered = recoverProcessMonitorGates({
      events: [
        gateEvent({
          phaseRunId: "phase-run-1",
          requestId: "old-req",
          gateKind: "validator",
        }),
        gateEvent({
          phaseRunId: "phase-run-1",
          requestId: "fresh-req",
          gateKind: "validator",
        }),
      ],
      approvals: [
        approval({
          id: "approval-old",
          status: "denied",
          request: oldRequest,
          decision: { retryReview: true },
        }),
        approval({
          id: "approval-fresh",
          status: "pending",
          request: freshRequest,
        }),
      ],
    })

    expect(recovered.gates).toEqual({
      "phase-run-1": { requestId: "fresh-req", gateKind: "validator" },
    })
    expect(recovered.requests).toMatchObject({
      "old-req": oldRequest,
      "fresh-req": freshRequest,
    })
  })

  it("drops a validator gate after manual override approval is durable", () => {
    const request = {
      kind: "process_validator_gate",
      phaseKey: "impl",
      phaseRunId: "phase-run-1",
      requestId: "req-1",
    }

    const recovered = recoverProcessMonitorGates({
      events: [
        gateEvent({
          phaseRunId: "phase-run-1",
          requestId: "req-1",
          gateKind: "validator",
        }),
      ],
      approvals: [
        approval({
          id: "approval-1",
          status: "approved",
          request,
          decision: {
            manualOverride: true,
            gateKind: "process_validator_gate",
          },
        }),
      ],
    })

    expect(recovered.gates).toEqual({})
    expect(recovered.requests["req-1"]).toBe(request)
  })
})

describe("completion policy rollout", () => {
  const definition = {
    id: "process",
    name: "Example",
    description: null,
    requireFlagApproval: true,
    createdAt: 1,
    updatedAt: 1,
  }
  const phase = {
    id: "phase",
    processId: "process",
    key: "work",
    name: "Work",
    routing: "single",
    gatePolicy: "auto",
    fanOut: false,
    maxReworkRounds: 0,
    dotFolder: false,
    validator: false,
    validatorMaxIterations: 0,
    validatorAgent: null,
    subprocessId: null,
    position: 0,
  } as const
  it("creates new builder phases with validated v1 completion", async () => {
    const create = vi.fn().mockResolvedValue(phase)
    ;(window as unknown as { cowork: unknown }).cowork = {
      db: {
        processes: {
          get: vi.fn().mockResolvedValue({
            definition,
            phases: [],
            agents: [],
            edges: [],
          }),
          phases: { create },
        },
      },
    }
    act(() => {
      root.render(
        <ProcessBuilder
          definition={definition}
          agents={[]}
          definitions={[definition]}
          onDefinitionChanged={() => {}}
        />
      )
    })
    await flushPromises()
    clickByText("Add phase")
    await flushPromises()
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        completionContract: {
          policy: "validated",
          version: 1,
          requiredArtifacts: [],
        },
      })
    )
  })
  it("shows legacy compatibility and allows explicit opt-in in the builder", async () => {
    const update = vi.fn().mockResolvedValue(phase)
    ;(window as unknown as { cowork: unknown }).cowork = {
      db: {
        processes: {
          get: vi.fn().mockResolvedValue({
            definition,
            phases: [phase],
            agents: [],
            edges: [],
          }),
          phases: { update },
        },
      },
    }
    act(() => {
      root.render(
        <ProcessBuilder
          definition={definition}
          agents={[]}
          definitions={[definition]}
          onDefinitionChanged={() => {}}
        />
      )
    })
    await flushPromises()
    clickByText("Work")
    await flushPromises()
    expect(container.textContent).toContain("Legacy completion")
    const toggle = container.querySelector(
      '[aria-label="Validated completion"]'
    )!
    expect(toggle).toBeTruthy()
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await flushPromises()
    expect(update).toHaveBeenCalledWith("phase", {
      completionContract: {
        policy: "validated",
        version: 1,
        requiredArtifacts: [],
      },
    })
  })
  it("shows the recorded run policy instead of a changed definition, and actionable outcome evidence", () => {
    const run: Pick<ProcessRun, "completionContracts"> = {
      completionContracts: {
        phase: {
          policy: "validated",
          version: 1,
          requiredArtifacts: ["report.txt"],
        },
      },
    }
    act(() => {
      root.render(
        <>
          <RunCompletionSummary run={run} phases={[phase]} />
          <PhaseCompletionEvidence
            receipt={{
              outcome: {
                version: 1,
                attemptId: "attempt",
                status: "blocked",
                output: "Cannot finish",
                evidence: "Input missing",
                reason: "Missing input",
                nextAction: "Supply input",
              },
              checkedArtifacts: [],
              checkedAt: 1,
            }}
          />
        </>
      )
    })
    expect(container.textContent).toContain("Work: Validated v1")
    expect(container.textContent).toContain("report.txt")
    expect(container.textContent).toContain("blocked")
    expect(container.textContent).toContain("Supply input")
    act(() => {
      root.render(
        <RunCompletionSummary
          run={{ completionContracts: null }}
          phases={[phase]}
        />
      )
    })
    expect(container.textContent).toContain(
      "Legacy (ended turn counts as success)"
    )
  })
})
