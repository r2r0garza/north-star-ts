import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const modeArg = process.argv.find((arg) => arg.startsWith("--mode="))
const mode = modeArg?.slice("--mode=".length) ?? "file"
if (mode !== "file" && mode !== "inline") {
  console.error("Usage: node scripts/probe-claude-agent-resume.mjs [--mode=file|inline]")
  process.exit(2)
}

const sessionId = randomUUID()
const suffix = sessionId.slice(0, 8)
const firstName = `north-star-probe-first-${suffix}`
const secondName = `north-star-probe-second-${suffix}`
const memoryToken = `remember-${randomUUID()}`
const probeRoot = await mkdtemp(join(tmpdir(), "north-star-claude-agent-resume-"))
const agentDir = join(probeRoot, ".claude", "agents")
const model = process.env.CLAUDE_PROBE_MODEL?.trim() || "sonnet"

const definitions = {
  [firstName]: {
    description: "First temporary agent for the North Star resume probe",
    prompt:
      "Begin every final answer with FIRST_AGENT. Follow the user's request after that marker.",
  },
  [secondName]: {
    description: "Second temporary agent for the North Star resume probe",
    prompt:
      "Begin every final answer with SECOND_AGENT. Follow the user's request after that marker.",
  },
}

function markdownAgent(name) {
  const definition = definitions[name]
  return `---\nname: ${name}\ndescription: ${definition.description}\nmodel: inherit\n---\n\n${definition.prompt}\n`
}

async function runClaude({ name, prompt, resume }) {
  const args = ["-p", prompt]
  if (resume) args.push("--resume", sessionId)
  else args.push("--session-id", sessionId)
  if (mode === "inline") {
    args.push("--agents", JSON.stringify({ [name]: definitions[name] }))
  }
  args.push("--agent", name, "--model", model, "--output-format", "json")

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("claude", args, {
      cwd: probeRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", rejectPromise)
    child.on("close", (code, signal) => {
      if (code !== 0) {
        rejectPromise(
          new Error(
            stderr.trim() ||
              `claude exited with ${code ?? signal ?? "unknown status"}`
          )
        )
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        resolvePromise({
          sessionId: parsed.session_id,
          result: parsed.result,
        })
      } catch {
        rejectPromise(new Error(`Claude returned invalid JSON:\n${stdout}`))
      }
    })
  })
}

try {
  if (mode === "file") {
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, `${firstName}.md`), markdownAgent(firstName))
  }

  const first = await runClaude({
    name: firstName,
    prompt: `Remember this exact token for the next turn: ${memoryToken}. Reply briefly.`,
    resume: false,
  })

  if (mode === "file") {
    await rm(join(agentDir, `${firstName}.md`))
    await writeFile(join(agentDir, `${secondName}.md`), markdownAgent(secondName))
  }

  const second = await runClaude({
    name: secondName,
    prompt:
      "State the exact token I asked you to remember in the previous turn. Do not omit it.",
    resume: true,
  })

  const checks = {
    firstAgentApplied: first.result?.includes("FIRST_AGENT") ?? false,
    secondAgentApplied: second.result?.includes("SECOND_AGENT") ?? false,
    historyPreserved: second.result?.includes(memoryToken) ?? false,
    sessionPreserved:
      first.sessionId === sessionId && second.sessionId === sessionId,
  }
  console.log(
    JSON.stringify(
      { mode, model, sessionId, memoryToken, first, second, checks },
      null,
      2
    )
  )
  if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1
} finally {
  const expectedPrefix = resolve(tmpdir(), "north-star-claude-agent-resume-")
  const resolvedProbeRoot = resolve(probeRoot)
  if (!resolvedProbeRoot.startsWith(expectedPrefix)) {
    throw new Error(`Refusing to clean unexpected probe path: ${resolvedProbeRoot}`)
  }
  await rm(resolvedProbeRoot, { recursive: true, force: true })
}
