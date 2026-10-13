import { makePolicyEngine } from "../../agent/approval/engine"
import { createEnvironment } from "../../agent/env/factory"
import { repositoryDelegationLeases } from "../../agent/subagents/repository-lease"
import * as settingsService from "../../settings/service"
import type { CommandExecutorDeps } from "./command-executor"

// The production wiring for executeProcessCommand (plan 104): the configured
// execution backend, the shared approval engine, and the repository-lease
// check. Command phases and the check form's Try it use the same deps, so a
// trial run behaves exactly like the run that follows.
export function productionCommandDeps(
  policy = makePolicyEngine()
): CommandExecutorDeps {
  return {
    getExecutionConfig: () => settingsService.getExecutionConfig(),
    createEnvironment: (workspace, id, cfg) =>
      createEnvironment(workspace, id, cfg),
    decide: (action, ctx) => policy.decide(action, ctx),
    repositoryBlocker: (cwd) => repositoryDelegationLeases.blocker(cwd),
  }
}
