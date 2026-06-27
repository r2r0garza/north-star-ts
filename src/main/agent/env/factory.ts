import { LocalEnvironment } from "./local"
import { ContainerEnvironment } from "./container"
import type { Environment } from "./types"

// Default image for the container backend (basics only — no build/pinning here).
const DEFAULT_CONTAINER_IMAGE = "node:20-bookworm"

export type EnvConfig =
  | { kind: "local" }
  | { kind: "container"; runtime: "docker" | "podman"; image: string }

// Build the execution backend for a turn. Local is the default; a container is
// constructed and started up front so a missing/broken runtime surfaces here
// (the caller catches and falls back to Local with a visible error).
export async function createEnvironment(
  workspace: string,
  conversationId: string,
  cfg: EnvConfig
): Promise<Environment> {
  if (cfg.kind === "container") {
    const env = new ContainerEnvironment({
      runtime: cfg.runtime,
      image: cfg.image,
      workspace,
      conversationId,
    })
    await env.start()
    return env
  }
  return new LocalEnvironment(workspace)
}

// Until the settings pane (.plan/004) lands, the backend is selected by a single
// env var so a dev can exercise both runtimes locally without any UI. Unset (the
// normal case) means Local, so production behavior is unchanged. Trivially
// removable once real settings drive this.
export function envConfigFromEnv(): EnvConfig {
  const runtime = process.env.COWORK_ENV_RUNTIME
  if (runtime === "docker" || runtime === "podman") {
    return {
      kind: "container",
      runtime,
      image: process.env.COWORK_ENV_IMAGE || DEFAULT_CONTAINER_IMAGE,
    }
  }
  return { kind: "local" }
}
