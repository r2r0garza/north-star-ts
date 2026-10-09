import readline from "node:readline"
const lines = readline.createInterface({ input: process.stdin })
const mode = process.env.NS_FIXTURE_MODE
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n")
let generation = false
const init = {
  type: "system",
  subtype: "init",
  tools: mode === "native-tool" ? ["Bash"] : ["mcp__north_star__read_file"],
  skills: mode === "native-skill" ? ["unexpected"] : [],
  plugins: mode === "native-plugin" ? [{ name: "unexpected" }] : [],
  agents:
    mode === "native-agent"
      ? ["fixture-agent"]
      : ["claude", "Explore", "general-purpose", "Plan", "statusline-setup"],
  mcp_servers: [
    {
      name: mode === "native-mcp" ? "unexpected" : "north_star",
      status: "connected",
    },
  ],
}
if (mode !== "missing-init") emit(init)
for await (const line of lines) {
  const frame = JSON.parse(line)
  if (frame.type === "control_request") {
    generation = true
    if (mode === "discovery-generate") {
      await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", {
        method: "POST",
        body: "{}",
      }).catch(() => {})
    }
    if (mode === "discovery-stall") {
      await new Promise(() => {})
      continue
    }
    if (mode === "discovery-prose") {
      process.stdout.write("not JSON\n")
      continue
    }
    emit({
      type: "control_response",
      response: {
        subtype: mode === "discovery-error" ? "error" : "success",
        request_id:
          mode === "discovery-wrong-id" ? "unrelated" : frame.request_id,
        response: {
          models:
            mode === "discovery-empty"
              ? []
              : [
                  { value: "default" },
                  { value: "sonnet" },
                  { value: "claude-sonnet-4-6" },
                ],
        },
      },
    })
    if (mode === "discovery-bad-exit") process.exitCode = 2
    continue
  }
  if (frame.type === "assistant") continue
  if (frame.shouldQuery === false) {
    if (mode === "repeated-init") emit(init)
    if (mode === "changed-init") emit({ ...init, agents: ["claude"] })
    if (mode === "bad-ack")
      emit({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
      })
    else
      emit({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 0,
      })
    continue
  }
  generation = true
  if (mode === "malformed") {
    process.stdout.write("not JSON\n")
    break
  }
  if (mode === "early-exit") break
  const response = await fetch(
    process.env.ANTHROPIC_BASE_URL + "/v1/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }
  )
  await response.text()
  if (mode === "stall") await new Promise(() => {})
  if (
    mode === "tools" ||
    mode?.startsWith("boundary-") ||
    mode?.startsWith("recovery-")
  ) {
    if (mode?.startsWith("recovery-")) {
      const denied = await fetch(
        process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true",
        {
          method: "POST",
          body: "{}",
        }
      )
      if (denied.status !== 409) process.exit(9)
      await denied.text()
    }
    emit({ type: "assistant", message: { content: [] } })
    const result = {
      type: "result",
      subtype:
        mode === "recovery-error"
          ? "error_during_execution"
          : "error_max_turns",
      is_error: true,
      num_turns:
        mode === "boundary-zero-turns"
          ? 0
          : mode === "boundary-extra-turns"
            ? 3
            : mode === "boundary-one-turn"
              ? 1
              : 2,
    }
    if (mode === "boundary-missing-turns") delete result.num_turns
    emit(result)
    if (mode === "boundary-late-assistant")
      emit({ type: "assistant", message: { content: [] } })
    if (mode === "boundary-late-stream")
      emit({ type: "stream_event", event: {} })
    if (mode === "boundary-duplicate-result") emit(result)
    process.exitCode = mode === "recovery-bad-exit" ? 2 : 1
  } else {
    emit({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: mode === "rewrite" ? "wrong" : "hello" },
        ],
      },
    })
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result: "hello",
    })
    if (mode === "bad-exit") process.exitCode = 2
  }
}
if (!generation && mode !== "bad-ack") process.exitCode = 3
