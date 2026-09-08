import { describe, expect, it } from "vitest"
import { RegexCommandClassifier } from "./regex-classifier"
import { shellActionForCommand } from "./shell-analyzer"

const classifier = new RegexCommandClassifier()
const workspace = "/w"

function decide(command: string) {
  return classifier.classify(
    shellActionForCommand(command, { cwd: workspace, workspace })
  )
}

const STAGING = ".cowork/skills/memory-recent/staging.md"

describe("shell writes to automatic-memory files", () => {
  // The demonstrated vector: an agent that reverse-engineers the staging format
  // and appends its own bullets. require_approval is not enough — Auto mode
  // approves that tier without prompting.
  it("hard-blocks redirects into memory files", () => {
    for (const command of [
      `echo "- an invented fact" >> ${STAGING}`,
      `echo "- an invented fact" > ${STAGING}`,
      `cat notes.txt >> .cowork/skills/memory-knowledge/SKILL.md`,
    ]) {
      const decision = decide(command)
      expect(decision?.level, command).toBe("hard_block")
      expect(decision?.reason, command).toContain("background service")
    }
  })

  it("hard-blocks mutating commands that carry the path in argv", () => {
    for (const command of [
      `echo "- fact" | tee -a ${STAGING}`,
      `sed -i '' 's/x/y/' ${STAGING}`,
      `cp /tmp/facts.md ${STAGING}`,
      `rm ${STAGING}`,
    ]) {
      const decision = decide(command)
      expect(decision?.level, command).toBe("hard_block")
    }
  })

  it("leaves reads of the reference log alone", () => {
    // memory-recent's own description tells the agent to grep reference/.
    const decision = decide(
      `grep -r "migration" .cowork/skills/memory-recent/reference/`
    )
    expect(decision?.level).not.toBe("hard_block")
  })

  it("does not block writes to ordinary workspace files", () => {
    const decision = decide('echo "hello" >> notes.md')
    expect(decision?.level).not.toBe("hard_block")
  })
})
