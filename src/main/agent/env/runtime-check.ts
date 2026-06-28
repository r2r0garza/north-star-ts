import { spawn } from "child_process"

// Lightweight availability probe for a container runtime, so the Settings UI can
// show whether Docker/Podman can actually be selected. This is a UX aid, NOT a
// security control — the real gate is the turn-start validation in
// ContainerEnvironment.start() (via createEnvironment), which still runs.
//
//  - "available":      installed and the daemon (if any) is reachable.
//  - "not_installed":  the binary isn't on PATH (ENOENT).
//  - "unavailable":    installed but not usable right now (e.g. Docker Desktop
//                      not running). Podman is daemonless, so a successful
//                      `--version` is enough to call it available.

export type RuntimeStatus = "available" | "not_installed" | "unavailable"
export type Runtime = "docker" | "podman"

interface ProbeResult {
  code: number | null
  enoent: boolean
}

// Run `<runtime> <args>` and resolve its exit code; flag ENOENT (not installed)
// distinctly from a nonzero exit (installed but failed). stdio ignored — we only
// care about success/failure, with a short timeout so a wedged daemon can't hang.
function probe(runtime: Runtime, args: string[]): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(runtime, args, { stdio: "ignore" })
    let settled = false
    const done = (r: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done({ code: null, enoent: false })
    }, 5000)
    child.on("error", (err: NodeJS.ErrnoException) =>
      done({ code: null, enoent: err.code === "ENOENT" })
    )
    child.on("close", (code) => done({ code, enoent: false }))
  })
}

async function probeRuntime(runtime: Runtime): Promise<RuntimeStatus> {
  const version = await probe(runtime, ["--version"])
  if (version.enoent) return "not_installed"
  if (version.code !== 0) return "unavailable"
  // Docker has a daemon that can be down even when the CLI is installed; `info`
  // returns nonzero if it can't reach it. Podman is daemonless, so skip this.
  if (runtime === "docker") {
    const info = await probe("docker", ["info"])
    if (info.code !== 0) return "unavailable"
  }
  return "available"
}

// Cache results so the UI can re-render without re-spawning. `recheck` forces a
// fresh probe (e.g. the user started Docker Desktop and reopened Settings).
const cache = new Map<Runtime, RuntimeStatus>()

export async function checkRuntime(
  runtime: Runtime,
  recheck = false
): Promise<RuntimeStatus> {
  if (!recheck && cache.has(runtime)) return cache.get(runtime)!
  const status = await probeRuntime(runtime)
  cache.set(runtime, status)
  return status
}

export async function checkRuntimes(
  recheck = false
): Promise<Record<Runtime, RuntimeStatus>> {
  const [docker, podman] = await Promise.all([
    checkRuntime("docker", recheck),
    checkRuntime("podman", recheck),
  ])
  return { docker, podman }
}
