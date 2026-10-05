import { describe, expect, it } from "vitest"
import { RegexCommandClassifier } from "./regex-classifier"
import { shellActionForCommand } from "./shell-analyzer"

const classifier = new RegexCommandClassifier()
const workspace = "/w"
const SKILL = "/home/u/.cowork/skills/demo"
const WORKSPACE_SKILL = "/w/.github/skills/local"

function decide(
  command: string,
  skillResources: Array<{ uri: string; path: string }> = []
) {
  return classifier.classify(
    shellActionForCommand(command, {
      cwd: workspace,
      workspace,
      readOnlyRoots: [SKILL, WORKSPACE_SKILL],
      skillResources,
    })
  )
}

describe("shell writes to activated skill resources", () => {
  // Hard-blocked rather than gated: Auto mode approves require_approval.
  it("hard-blocks redirects and mutating commands into a skill root", () => {
    for (const command of [
      `echo x > ${SKILL}/scripts/tool.py`,
      `echo x >> ${WORKSPACE_SKILL}/SKILL.md`,
      `echo x | tee ${SKILL}/notes.md`,
      `sed -i '' 's/a/b/' ${SKILL}/SKILL.md`,
      `cp payload.py ${SKILL}/scripts/tool.py`,
      `cp -t ${SKILL}/scripts payload.py`,
      `mv ${SKILL}/scripts/tool.py out.py`,
      `rm -rf ${WORKSPACE_SKILL}`,
      `chmod +x ${SKILL}/scripts/tool.py`,
      `touch .github/skills/local/new.md`,
      `dd if=payload of=${SKILL}/bin`,
    ]) {
      const decision = decide(command)
      expect(decision?.level, command).toBe("hard_block")
      expect(decision?.reason, command).toContain("read-only")
    }
  })

  it("allows running and copying out of a skill, behind approval", () => {
    for (const command of [
      `python3 ${SKILL}/scripts/tool.py --out result.json`,
      `cp ${SKILL}/templates/a.md docs/a.md`,
      `sed 's/a/b/' ${SKILL}/SKILL.md`,
    ]) {
      const decision = decide(command)
      expect(decision?.level, command).toBe("require_approval")
      expect(decision?.reason, command).toContain("activated skill")
    }
  })

  it("gates skill:// commands even when the analyzer sees no skill path", () => {
    // Leading assignments aren't path candidates, and a workspace skill's paths
    // are inside the workspace; the rewrite record still requires approval.
    for (const command of [
      `PYTHONPATH='${SKILL}' python3 -m scripts.run`,
      `python3 '${WORKSPACE_SKILL}/scripts/tool.py'`,
    ]) {
      expect(decide(command)?.level, command).toBe("allow")
      const decision = decide(command, [{ uri: "skill://demo/", path: SKILL }])
      expect(decision?.level, command).toBe("require_approval")
      expect(decision?.reason, command).toContain("activated skill")
    }
  })

  it("still flags unrelated outside paths as outside the workspace", () => {
    const decision = decide(`cat ${SKILL}/SKILL.md /etc/hosts`)
    expect(decision?.reason).toBe(
      "command references paths outside the workspace"
    )
  })

  it("does not hard-block when no skill is active", () => {
    const decision = classifier.classify(
      shellActionForCommand(`touch ${SKILL}/x`, { cwd: workspace, workspace })
    )
    expect(decision?.level).toBe("require_approval")
  })
})
