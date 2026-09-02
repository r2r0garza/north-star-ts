import { describe, expect, it } from "vitest"
import type { FailureContext } from "../../db/types"
import {
  FAILURE_CAUSE_MAX_BYTES,
  FAILURE_MESSAGE_MAX_BYTES,
  sanitizeFailureContext,
} from "./failure-sanitizer"

function failure(patch: Partial<FailureContext> = {}): FailureContext {
  return {
    code: "model_request_failed",
    stage: "model_request",
    message: "failed",
    retryable: false,
    attempt: null,
    maxAttempts: null,
    runId: "run-1",
    phaseRunId: "phase-run-1",
    phaseId: "phase-1",
    taskId: "task-1",
    workerTaskId: "worker-1",
    agentName: "builder",
    cause: null,
    occurredAt: 123,
    ...patch,
  }
}

describe("process failure sanitization", () => {
  it("redacts provider credentials, authorization headers, and response bodies while preserving identity", () => {
    const sanitized = sanitizeFailureContext(
      failure({
        code: "provider_unauthorized",
        stage: "model_request",
        message:
          "Provider failed Authorization: Bearer sk-live-secret-token x-api-key=raw-secret response body: {\"error\":\"bad\",\"api_key\":\"nested-secret\"}",
        cause:
          "GatewayError cookie: sessionid=secret; OPENAI_API_KEY=sk-other-secret",
      })
    )

    expect(sanitized).toMatchObject({
      code: "provider_unauthorized",
      stage: "model_request",
      runId: "run-1",
      phaseRunId: "phase-run-1",
      phaseId: "phase-1",
      taskId: "task-1",
      workerTaskId: "worker-1",
      agentName: "builder",
    })
    expect(sanitized.message).toContain("Authorization: Bearer [redacted]")
    expect(sanitized.message).toContain("x-api-key=[redacted]")
    expect(sanitized.message).not.toContain("sk-live-secret-token")
    expect(sanitized.message).not.toContain("raw-secret")
    expect(sanitized.message).not.toContain("\"bad\"")
    expect(sanitized.cause).toContain("cookie=[redacted]")
    expect(sanitized.cause).not.toContain("sk-other-secret")
  })

  it("redacts tool arguments, tool results, and sensitive absolute paths", () => {
    const sanitized = sanitizeFailureContext(
      failure({
        stage: "tool_execution",
        message:
          "tool arguments: {\"path\":\"/Users/alice/private/project/.env\",\"token\":\"abc123\"}\ntool result: wrote /private/var/folders/yj/cache/out.txt",
        cause:
          "failed reading /home/alice/.ssh/id_rsa and C:\\Users\\alice\\AppData\\secret.txt",
      })
    )

    expect(sanitized.stage).toBe("tool_execution")
    expect(sanitized.message).not.toContain("/Users/alice")
    expect(sanitized.message).not.toContain("/private/var")
    expect(sanitized.message).not.toContain("abc123")
    expect(sanitized.message).toContain("[redacted]")
    expect(sanitized.cause).not.toContain("/home/alice")
    expect(sanitized.cause).not.toContain("C:\\Users\\alice")
  })

  it("caps message and cause sizes with documented byte limits", () => {
    const sanitized = sanitizeFailureContext(
      failure({
        message: `prefix ${"x".repeat(FAILURE_MESSAGE_MAX_BYTES * 2)}`,
        cause: `cause ${"y".repeat(FAILURE_CAUSE_MAX_BYTES * 2)}`,
      })
    )

    expect(Buffer.byteLength(sanitized.message, "utf8")).toBeLessThanOrEqual(
      FAILURE_MESSAGE_MAX_BYTES
    )
    expect(Buffer.byteLength(sanitized.cause ?? "", "utf8")).toBeLessThanOrEqual(
      FAILURE_CAUSE_MAX_BYTES
    )
    expect(sanitized.message).toContain("[truncated]")
    expect(sanitized.cause).toContain("[truncated]")
  })
})
