// Orphan process probes (plan 112.1/112.3): whether a service's process or
// anything in its process group outlived teardown. Pure Node, so the
// scorecard CLI can use it without Electron.

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, it's just not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

// The PIDs still alive, or whose process group still has a member (a dev
// server's watcher outliving its shell). Each service is its own group
// leader, so -pid probes what it spawned. Windows has no groups to probe.
export function orphanProcesses(pids: number[]): number[] {
  return pids.filter(
    (pid) => alive(pid) || (process.platform !== "win32" && alive(-pid))
  )
}

// Wait up to `ms` for teardown to finish, then report what's left.
export async function waitForOrphans(
  pids: number[],
  ms = 3000
): Promise<number[]> {
  const deadline = Date.now() + ms
  let left = orphanProcesses(pids)
  while (left.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    left = orphanProcesses(pids)
  }
  return left
}
