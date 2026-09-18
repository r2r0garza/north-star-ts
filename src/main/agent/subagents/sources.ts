import path from "path"
import { dataDirName } from "../../config/system-name"
import { loadAgents } from "../agents/loader"
import { userAgentsDir } from "../agents/sources"
import type { AgentDefinition } from "../agents/types"

export function spawnableAgentSources(workspace?: string): string[] {
  return [
    userAgentsDir(),
    ...(workspace
      ? [path.join(workspace, dataDirName(), "agents")]
      : []),
  ]
}

export async function loadSpawnableAgents(
  workspace?: string
): Promise<AgentDefinition[]> {
  return loadAgents(spawnableAgentSources(workspace))
}

export async function loadSpawnableAgent(
  name: string,
  workspace?: string
): Promise<AgentDefinition | null> {
  const agents = await loadSpawnableAgents(workspace)
  return [...agents].reverse().find((agent) => agent.name === name) ?? null
}
