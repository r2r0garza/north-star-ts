import { beforeEach, describe, expect, it, vi } from "vitest"

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}))

vi.mock("child_process", () => ({
  execFileSync: execFileSyncMock,
}))

import {
  checkContainerTestAvailability,
  CONTAINER_TEST_PROBE_TIMEOUT_MS,
  type ContainerTestProbe,
} from "./container-test-availability"

const ok = { code: 0, stderr: "", enoent: false }

function probeWith(
  failures: Record<string, Partial<ReturnType<ContainerTestProbe>>> = {}
): ContainerTestProbe {
  return (_runtime, args) => {
    const key = args.join(" ")
    const failure = failures[key]
    if (!failure) return ok
    return {
      code: failure.code === undefined ? 1 : failure.code,
      stderr: failure.stderr ?? "",
      enoent: failure.enoent ?? false,
      timedOut: failure.timedOut,
      timeoutMs: failure.timeoutMs,
    }
  }
}

describe("checkContainerTestAvailability", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset()
  })

  it("skips when the runtime CLI is missing", () => {
    const availability = checkContainerTestAvailability(
      "docker",
      "node:20-bookworm",
      {},
      probeWith({ "--version": { code: null, enoent: true } })
    )

    expect(availability).toMatchObject({
      available: false,
      required: false,
      shouldRun: false,
    })
    expect(availability.reason).toContain("docker is not installed")
  })

  it("skips when the daemon or socket is unavailable", () => {
    const availability = checkContainerTestAvailability(
      "podman",
      "node:20-bookworm",
      {},
      probeWith({ info: { code: 125, stderr: "cannot connect to socket" } })
    )

    expect(availability).toMatchObject({
      available: false,
      shouldRun: false,
    })
    expect(availability.reason).toContain("podman info failed")
  })

  it("skips when the configured image is not locally available", () => {
    const availability = checkContainerTestAvailability(
      "docker",
      "node:20-bookworm",
      {},
      probeWith({
        "image inspect node:20-bookworm": {
          code: 1,
          stderr: "No such image",
        },
      })
    )

    expect(availability).toMatchObject({
      available: false,
      shouldRun: false,
    })
    expect(availability.reason).toContain("image inspect node:20-bookworm")
    expect(availability.reason).toContain("pull the image first")
  })

  it("runs when the runtime and configured image are usable", () => {
    expect(
      checkContainerTestAvailability(
        "docker",
        "node:20-bookworm",
        {},
        probeWith()
      )
    ).toEqual({
      available: true,
      required: false,
      shouldRun: true,
      reason: null,
    })
  })

  it("respects explicit opt-out", () => {
    const availability = checkContainerTestAvailability(
      "docker",
      "node:20-bookworm",
      { COWORK_CONTAINER_TESTS: "0" },
      probeWith()
    )

    expect(availability).toMatchObject({
      available: false,
      required: false,
      shouldRun: false,
    })
    expect(availability.reason).toContain("disabled")
  })

  it("turns an unusable runtime into a failing suite when explicitly required", () => {
    const availability = checkContainerTestAvailability(
      "docker",
      "node:20-bookworm",
      { COWORK_CONTAINER_TESTS: "1" },
      probeWith({ info: { code: 1, stderr: "daemon down" } })
    )

    expect(availability).toMatchObject({
      available: false,
      required: true,
      shouldRun: true,
    })
    expect(availability.reason).toContain("docker info failed")
  })

  it.each([
    ["--version", "--version"],
    ["info", "info"],
    ["image inspect node:20-bookworm", "image inspect node:20-bookworm"],
  ])(
    "skips by default when the %s probe times out",
    (_label, failingCommand) => {
      const availability = checkContainerTestAvailability(
        "podman",
        "node:20-bookworm",
        {},
        probeWith({
          [failingCommand]: {
            code: null,
            timedOut: true,
            timeoutMs: 1234,
          },
        })
      )

      expect(availability).toMatchObject({
        available: false,
        required: false,
        shouldRun: false,
      })
      expect(availability.reason).toContain("podman")
      expect(availability.reason).toContain(failingCommand)
      expect(availability.reason).toContain("timed out after 1234ms")
    }
  )

  it("turns a timed-out probe into a failing suite when explicitly required", () => {
    const availability = checkContainerTestAvailability(
      "docker",
      "node:20-bookworm",
      { COWORK_CONTAINER_TESTS: "1" },
      probeWith({
        info: {
          code: null,
          timedOut: true,
          timeoutMs: 1234,
        },
      })
    )

    expect(availability).toMatchObject({
      available: false,
      required: true,
      shouldRun: true,
    })
    expect(availability.reason).toContain("docker info timed out after 1234ms")
  })

  it.each(["docker", "podman"] as const)(
    "runs each %s subprocess probe with a hard timeout",
    (runtime) => {
      execFileSyncMock.mockReturnValue(Buffer.from(""))

      const availability = checkContainerTestAvailability(
        runtime,
        "node:20-bookworm"
      )

      expect(availability.available).toBe(true)
      expect(execFileSyncMock).toHaveBeenCalledTimes(3)
      expect(execFileSyncMock).toHaveBeenNthCalledWith(
        1,
        runtime,
        ["--version"],
        {
          stdio: "ignore",
          timeout: CONTAINER_TEST_PROBE_TIMEOUT_MS,
          killSignal: "SIGKILL",
        }
      )
      expect(execFileSyncMock).toHaveBeenNthCalledWith(2, runtime, ["info"], {
        stdio: "ignore",
        timeout: CONTAINER_TEST_PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
      })
      expect(execFileSyncMock).toHaveBeenNthCalledWith(
        3,
        runtime,
        ["image", "inspect", "node:20-bookworm"],
        {
          stdio: "ignore",
          timeout: CONTAINER_TEST_PROBE_TIMEOUT_MS,
          killSignal: "SIGKILL",
        }
      )
    }
  )
})
