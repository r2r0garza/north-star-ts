import { execFileSync } from "child_process"

export type ContainerTestRuntime = "docker" | "podman"

export interface ContainerTestProbeResult {
  code: number | null
  stderr: string
  enoent: boolean
  timedOut?: boolean
  timeoutMs?: number
}

export type ContainerTestProbe = (
  runtime: ContainerTestRuntime,
  args: string[]
) => ContainerTestProbeResult

export interface ContainerTestAvailability {
  available: boolean
  required: boolean
  shouldRun: boolean
  reason: string | null
}

export const CONTAINER_TEST_PROBE_TIMEOUT_MS = 5_000

function defaultProbe(
  runtime: ContainerTestRuntime,
  args: string[]
): ContainerTestProbeResult {
  try {
    execFileSync(runtime, args, {
      stdio: "ignore",
      timeout: CONTAINER_TEST_PROBE_TIMEOUT_MS,
    })
    return { code: 0, stderr: "", enoent: false }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      status?: number | null
      stderr?: Buffer
      signal?: NodeJS.Signals | null
    }
    const timedOut = e.code === "ETIMEDOUT"
    return {
      code: typeof e.status === "number" ? e.status : null,
      stderr: e.stderr?.toString("utf8").trim() ?? e.message ?? "",
      enoent: e.code === "ENOENT",
      timedOut,
      timeoutMs: timedOut ? CONTAINER_TEST_PROBE_TIMEOUT_MS : undefined,
    }
  }
}

function envEnabled(value: string | undefined): boolean | null {
  if (value == null || value.trim() === "") return null
  const normalized = value.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return true
}

function failedProbeReason(
  runtime: ContainerTestRuntime,
  command: string,
  result: ContainerTestProbeResult
): string {
  if (result.enoent) return `${runtime} is not installed or not on PATH`
  if (result.timedOut) {
    const deadline = result.timeoutMs ?? CONTAINER_TEST_PROBE_TIMEOUT_MS
    return `${runtime} ${command} timed out after ${deadline}ms`
  }
  const detail = result.stderr ? `: ${result.stderr}` : ""
  return `${runtime} ${command} failed${detail}`
}

export function checkContainerTestAvailability(
  runtime: ContainerTestRuntime,
  image: string,
  env: NodeJS.ProcessEnv = process.env,
  probe: ContainerTestProbe = defaultProbe
): ContainerTestAvailability {
  const enabled = envEnabled(env.COWORK_CONTAINER_TESTS)
  const required = enabled === true
  if (enabled === false) {
    return {
      available: false,
      required,
      shouldRun: false,
      reason: "container integration tests disabled by COWORK_CONTAINER_TESTS",
    }
  }

  const version = probe(runtime, ["--version"])
  if (version.code !== 0) {
    const reason = failedProbeReason(runtime, "--version", version)
    return { available: false, required, shouldRun: required, reason }
  }

  const info = probe(runtime, ["info"])
  if (info.code !== 0) {
    const reason = failedProbeReason(runtime, "info", info)
    return { available: false, required, shouldRun: required, reason }
  }

  const imageInspect = probe(runtime, ["image", "inspect", image])
  if (imageInspect.code !== 0) {
    const reason =
      failedProbeReason(runtime, `image inspect ${image}`, imageInspect) +
      "; pull the image first or set COWORK_ENV_IMAGE to a local image"
    return { available: false, required, shouldRun: required, reason }
  }

  return { available: true, required, shouldRun: true, reason: null }
}
