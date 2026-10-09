import { readFile } from "node:fs/promises"
import readline from "node:readline"

const args = process.argv.slice(2)
if (args[0] === "--version") {
  console.log("2.1.286 (Claude Code)")
  process.exit(0)
}
const option = (name) => args[args.indexOf(name) + 1]
const settings = JSON.parse(await readFile(option("--settings"), "utf8"))
const extra = JSON.parse(settings.env.CLAUDE_CODE_EXTRA_BODY)
const system = await readFile(option("--system-prompt-file"), "utf8")
const emit = (event) => console.log(JSON.stringify(event))
emit({
  type: "system",
  subtype: "init",
  tools: extra.tools.map((tool) => tool.name),
  skills: [],
  plugins: [],
  agents: ["claude"],
  mcp_servers: Object.keys(
    JSON.parse(await readFile(option("--mcp-config"), "utf8")).mcpServers
  ).map((name) => ({ name, status: "connected" })),
})
const messages = []
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line)
  messages.push(frame.message)
  if (frame.type === "assistant") continue
  if (frame.shouldQuery === false) {
    emit({ type: "result", subtype: "success", is_error: false, num_turns: 0 })
    continue
  }
  const response = await fetch(
    process.env.ANTHROPIC_BASE_URL + "/v1/messages",
    {
      method: "POST",
      body: JSON.stringify({
        ...extra,
        model: option("--model"),
        system,
        messages,
      }),
    }
  )
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
  const text = events
    .filter(
      (event) =>
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
    )
    .map((event) => event.delta.text)
    .join("")
  const stop = events.find((event) => event.type === "message_delta")?.delta
    .stop_reason
  const tool = stop === "tool_use"
  emit({
    type: "assistant",
    message: { content: text ? [{ type: "text", text }] : [] },
  })
  emit({
    type: "result",
    subtype: tool ? "error_max_turns" : "success",
    is_error: tool,
    num_turns: tool ? 2 : 1,
    ...(tool ? {} : { result: text }),
  })
  process.exitCode = tool ? 1 : 0
}
