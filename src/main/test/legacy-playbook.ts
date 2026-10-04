import * as playbooks from "../db/repositories/playbooks"
import * as processes from "../db/repositories/processes"
import { createDefaultPlaybook } from "../mission-control/playbook-defaults"

// The user story default from plan 109.02, as a workspace created it before
// plan 110.04: QA's checks step between the spec and the build. Installs keep
// it until the user resets the playbook to default.
export const LEGACY_PLAYBOOK_NAME = "Spec → Author checks → Build → Test"

export function createLegacyChecksPlaybook() {
  const playbook = createDefaultPlaybook("user_story")
  const processId = playbook.hooks[0].processId
  const [spec, build, test] = processes
    .listPhases(processId)
    .sort((a, b) => a.position - b.position)
  for (const edge of processes.listEdges(processId))
    processes.deleteEdge(edge.id)
  processes.updatePhase(build.id, {
    name: "Build the user story to its acceptance criteria; make the QA checks pass without editing them",
    position: 2,
  })
  processes.updatePhase(test.id, {
    name: "Run the QA checks, test the running app against each criterion, and record the proof",
    position: 3,
  })
  const checks = processes.createPhase({
    processId,
    key: "checks",
    name: "Write acceptance checks for each criterion from the spec (do not read or wait for the implementation; edit only the checks directory)",
    contextScope: "user_story",
    position: 1,
  })
  processes.createPhaseAgent({
    phaseId: checks.id,
    seatRole: "qa",
    position: 0,
  })
  const order = [spec, checks, build, test]
  for (let i = 1; i < order.length; i++)
    processes.createEdge({
      processId,
      fromPhaseId: order[i - 1].id,
      toPhaseId: order[i].id,
    })
  playbooks.updatePlaybook(playbook.id, { name: LEGACY_PLAYBOOK_NAME })
  return playbooks.getPlaybook(playbook.id)!
}
