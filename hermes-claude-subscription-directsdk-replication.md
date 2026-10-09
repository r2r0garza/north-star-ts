# Replicating Hermes's Claude Subscription DirectSDK Pattern

## Purpose

This document explains how Hermes uses the official Claude Code CLI as a subscription-backed model transport while keeping the host application's own:

- Conversation history
- Agent loop
- Tool execution
- Approvals
- Compaction
- Persistence
- Retry/fallback behavior
- Provider abstraction

The goal is to adapt the pattern to North Star without replacing North Star's existing agent architecture.

> This is an implementation analysis of the Hermes plugin at commit `31b591fd04737a7807183f3d7f3d389b19f94687`.

## 1. The architectural distinction

There are two ways to integrate Claude Code.

### Claude Code as the agent

```text
North Star
  -> claude -p / --resume
  -> Claude Code owns conversation state and the agent loop
  -> Claude Code executes native/MCP tools
```

This is close to North Star's current implementation.

### Claude Code as a subscription-backed model transport

```text
North Star
  -> builds the canonical request from its own history
  -> starts a fresh Claude Code process
  -> Claude Code authenticates using the user's Claude login
  -> Claude Code sends one native Messages request
  -> North Star receives the assistant response/tool calls
  -> North Star executes tools and stores results
```

The second design is what the Hermes plugin implements.

The key idea is:

> Claude Code supplies authentication, model access, and native streaming. The host application remains the agent.

## 2. High-level request flow

```text
┌────────────────────────────┐
│ Host application            │
│                            │
│ - canonical message history│
│ - tools                    │
│ - approvals                │
│ - agent loop               │
│ - compaction               │
│ - persistence              │
└─────────────┬──────────────┘
              │ OpenAI-like internal request
              ▼
┌─────────────────────────────┐
│ Subscription transport      │
│                             │
│ - validates request          │
│ - translates messages       │
│ - translates tools          │
│ - starts Claude Code        │
│ - parses stream-json        │
└─────────────┬───────────────┘
              │ stdin/stdout stream-json
              ▼
┌─────────────────────────────┐
│ Official Claude Code CLI    │
│                             │
│ - uses existing Claude login│
│ - talks to Anthropic        │
│ - returns native events     │
└─────────────┬───────────────┘
              │ ANTHROPIC_BASE_URL
              ▼
┌─────────────────────────────┐
│ Per-request localhost relay │
│                             │
│ - admits only one request   │
│ - forwards to Anthropic     │
│ - captures response/usage   │
│ - rejects native retries    │
└─────────────┬───────────────┘
              ▼
        api.anthropic.com
```

## 3. Why a fresh process is used for each request

The Hermes provider does not use a parked Claude Code session and does not depend on `--resume` for canonical history.

Each model request starts a new Claude Code process. The host replays the conversation into that process using Claude Code's stream-json input protocol.

This gives the host control over:

- Message edits
- Message deletion
- Provider switching
- Branching conversations
- Compaction
- Retries
- Fallback models
- Tool schema changes
- Database recovery
- Reproducible request construction

The process is disposable. The host's database is the source of truth.

## 4. The Claude Code command

The plugin starts Claude Code in print mode with structured input/output:

```text
claude -p
  --model <native-model-id>
  --input-format stream-json
  --output-format stream-json
  --verbose
  --include-partial-messages
  --tools ""
  --system-prompt-file <temporary-file>
  --settings <temporary-settings-file>
  --setting-sources ""
  --strict-mcp-config
  --disable-slash-commands
  --max-turns 1
  --permission-mode dontAsk
  --no-session-persistence
  --mcp-config <temporary-mcp-config>
```

The exact flags are important:

- `--input-format stream-json`: accepts structured newline-delimited JSON frames on stdin.
- `--output-format stream-json`: emits structured newline-delimited JSON on stdout.
- `--max-turns 1`: asks Claude Code to produce one logical model response.
- `--tools ""`: disables Claude Code built-in tools.
- `--strict-mcp-config`: prevents unrelated MCP configuration from being loaded.
- `--setting-sources ""`: prevents user/project settings from unexpectedly changing the provider behavior.
- `--permission-mode dontAsk`: prevents a native approval prompt from taking over the host application.
- `--no-session-persistence`: makes the process request-scoped.
- `--disable-slash-commands`: prevents native slash-command behavior from entering the host loop.

Your North Star Claude Code agent mode should probably keep its current behavior. The subscription transport should be a separate mode/provider because it has different ownership rules.

## 5. Request translation

The transport accepts an OpenAI-style request internally:

```ts
interface ChatCompletionRequest {
  model: string
  messages: Message[]
  tools?: ToolDefinition[]
  stream?: boolean
  max_tokens?: number
  response_format?: ResponseFormat
  extra_body?: Record<string, unknown>
}
```

The transport performs three translations:

1. OpenAI-style messages -> Claude native message frames.
2. OpenAI-style tools -> Claude/MCP tool definitions.
3. Claude native events -> OpenAI-style response chunks.

### System messages

System/developer content is extracted and written to a private temporary file:

```text
<temporary-dir>/system.md
```

Claude Code receives it through:

```text
--system-prompt-file <temporary-dir>/system.md
```

This avoids putting a very large system prompt into argv or an environment variable.

### User messages

User messages become Claude user frames. Text content becomes native text blocks.

Images are converted as follows:

- Base64 data URLs become native base64 image blocks.
- Remote image URLs are not downloaded by the transport. They become a text hint instructing the host's vision tool to inspect the URL.

### Assistant messages

Assistant messages are converted to Claude assistant content blocks.

Tool calls become native `tool_use` blocks:

```json
{
  "type": "tool_use",
  "id": "call-123",
  "name": "mcp__hermes__read_file",
  "input": {
    "path": "src/index.ts"
  }
}
```

### Tool results

Tool results become Claude user messages containing `tool_result` blocks:

```json
{
  "type": "tool_result",
  "tool_use_id": "call-123",
  "content": "file contents...",
  "is_error": false
}
```

The host executes the tool. Claude Code does not execute the tool itself.

## 6. History replay

The host sends the complete relevant history to the new Claude Code process.

Historical user frames are marked as non-querying:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "Earlier user message"
      }
    ]
  },
  "shouldQuery": false
}
```

Claude Code acknowledges those frames without generating another answer.

The final frame is the only querying frame:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "New user message"
      }
    ]
  },
  "shouldQuery": true
}
```

In practice the final frame is normally just the last user message or the latest tool-result frame. The previous frames establish the native context.

The host must wait for a zero-turn result after every historical frame. If Claude Code responds with a normal generation or exits early, treat replay as unsupported/failing.

Pseudo-code:

```ts
for (const [index, frame] of frames.entries()) {
  const historical = index < frames.length - 1

  writeJsonLine(child.stdin, {
    ...frame,
    ...(historical ? { shouldQuery: false } : {})
  })

  if (historical) {
    await waitForZeroTurnAcknowledgement(child.stdout)
  }
}

child.stdin.end()
```

## 7. Tool ownership

The host must advertise its tools to Claude without allowing Claude Code to execute them directly.

Hermes does this through a temporary inert MCP server.

### Tool flow

```text
Host tool registry
       │
       ▼
Temporary tools.json
       │
       ▼
Inert MCP server advertised to Claude Code
       │
       ▼
Claude emits tool_use
       │
       ▼
Host receives tool call
       │
       ▼
Host executes tool
       │
       ▼
Host sends tool_result on the next request
```

The MCP server only advertises the current tool names, descriptions, and schemas. Its callbacks do not perform the actual tool work.

Tool names are prefixed so they cannot collide with native Claude tools:

```text
mcp__hermes__<tool-name>
```

When the response comes back, remove the prefix before passing the call to the host tool dispatcher.

Example conversion:

```text
mcp__hermes__read_file
```

becomes:

```text
read_file
```

The host still validates the name and arguments. Never trust the model-generated tool arguments merely because they passed through MCP.

## 8. Creating the temporary MCP server

For each request:

1. Create a temporary directory.
2. Write the current tool manifest to `tools.json`.
3. Start or reference an inert MCP executable.
4. Pass a private MCP configuration to Claude Code.
5. Make the configuration available only for this process.
6. Remove it after the request completes, fails, or is cancelled.

Example configuration shape:

```json
{
  "mcpServers": {
    "host": {
      "command": "node",
      "args": ["/path/to/inert-mcp-server.js", "/tmp/request/tools.json"]
    }
  }
}
```

The host should not write its real secret bearer token into this JSON file or into argv. If the MCP server needs a token, pass it through a tightly scoped environment variable and revoke it when the request ends.

## 9. The admission relay

This is the most important part that is missing from a simple `claude -p` integration.

### Problem

Claude Code may make another upstream request for recovery, retry, or native error handling even when the host intended one request.

Without a relay:

```text
one host request → potentially multiple Anthropic requests
```

That creates problems for:

- Usage accounting
- Retry behavior
- Response consistency
- Tool-loop determinism
- Subscription allowance tracking

### Solution

For every host model request, create a local relay:

```text
http://127.0.0.1:<ephemeral-port>/admit/<random-route>
```

Set this URL in the child environment:

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/admit/<random-route>
```

The relay accepts exactly one request to:

```text
<random-route>/v1/messages
```

The first request is forwarded to the real upstream URL. Any later request gets a local error such as:

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "HOST_MODEL_ADMISSION_CONSUMED"
  }
}
```

### Relay requirements

The relay should:

- Bind only to loopback.
- Use a random per-request route.
- Reject unexpected paths.
- Reject requests with unexpected origins.
- Accept only HTTPS upstreams in production.
- Allow loopback HTTP only for tests.
- Preserve upstream authorization headers in memory.
- Never log authorization headers.
- Never persist request bodies containing credentials.
- Forward the first request's body and relevant identity headers.
- Normalize transfer encoding if necessary.
- Stream the upstream response back to Claude Code.
- Capture status, request ID, usage, stop reason, and error body.
- Close the upstream connection when the request is cancelled.
- Stop accepting new requests after the first request begins.

### TypeScript shape

```ts
interface AdmissionRelay {
  readonly baseUrl: string
  readonly upstreamRequests: number
  readonly blockedRequests: number
  readonly status?: number
  readonly requestId?: string

  start(): Promise<void>
  close(): Promise<void>
  abort(): void
}
```

A request-scoped relay should be created immediately before starting Claude Code and closed in a `finally` block.

## 10. Process management and cancellation

The Claude child and the relay must share the same cancellation lifecycle.

```text
AbortSignal fires
   ├─ abort relay upstream socket
   ├─ terminate Claude process group/tree
   ├─ close stdin/stdout ownership
   └─ clean temporary files and MCP grants
```

On POSIX:

- Start the process detached or in a new process group.
- Kill the process group, not only the shell wrapper.

On Windows:

- Use a tree termination mechanism because the npm `claude.cmd` shim may spawn Node children.

North Star already has the right general pattern through `detached` and `captureSpawn(..., killGroup: true)`. The additional work is making the relay's socket cancellation participate in the same `AbortSignal` lifecycle.

## 11. Reading stream-json output

Claude Code emits newline-delimited JSON. Do not assume one stdout `data` event equals one JSON object.

Use a UTF-8 decoder and line buffer:

```ts
let pending = ""
const decoder = new StringDecoder("utf8")

child.stdout.on("data", (chunk) => {
  pending += decoder.write(chunk)

  const lines = pending.split(/\r?\n/)
  pending = lines.pop() ?? ""

  for (const line of lines) {
    if (!line.trim()) continue
    const event = JSON.parse(line)
    handleNativeEvent(event)
  }
})

child.stdout.on("end", () => {
  pending += decoder.end()
  if (pending.trim()) handleNativeEvent(JSON.parse(pending))
})
```

Do not treat arbitrary non-JSON stdout as assistant text. It may be a CLI banner or diagnostic output. Treat it as a protocol failure or record it separately.

## 12. Native event handling

At minimum, handle these event classes:

### Assistant message

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "Hello"
      }
    ]
  }
}
```

Extract:

- Text blocks
- Thinking blocks
- Tool-use blocks
- Refusal metadata
- Native message ID
- Stop reason

### Partial stream event

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "delta": {
      "type": "text_delta",
      "text": "partial text"
    }
  }
}
```

Forward text deltas to the UI/provider stream.

Thinking deltas should map to your provider's reasoning channel rather than ordinary assistant text.

### Result event

The final result carries information such as:

- Success/error subtype
- Usage
- Model usage
- Cost estimate
- Turn count
- Native error details

Do not declare the request complete merely because text was emitted. Require the final result and process completion conditions described below.

### Native control responses

During replay, Claude Code may emit control responses. Use them to verify zero-turn acknowledgements and model initialization behavior.

## 13. Completion criteria

A successful model request should require all of the following:

- At least one assistant message.
- A `message_stop` event.
- Exactly one final result event.
- Complete input/output token usage.
- A valid process exit or an accepted `error_max_turns` boundary containing a complete tool batch.
- No incomplete upstream relay response.

If the relay received an upstream request but the response was incomplete, treat the request as failed even if Claude Code emits a later synthetic result.

The Hermes implementation deliberately trusts the first captured upstream response over a later native recovery result.

## 14. Converting the response back to the host

Return an internal OpenAI-like response:

```ts
interface ProviderResponse {
  id: string
  model: string
  finishReason: "stop" | "tool_calls" | "length" | "content_filter"
  message: {
    role: "assistant"
    content: string | null
    toolCalls?: Array<{
      id: string
      name: string
      arguments: string
    }>
    reasoningContent?: string
    refusal?: string
  }
  usage?: {
    inputTokens: number
    outputTokens: number
    cachedTokens?: number
    native?: unknown
  }
}
```

Tool-call conversion:

```ts
{
  id: block.id,
  name: removeHostPrefix(block.name),
  arguments: JSON.stringify(block.input)
}
```

The host's existing agent loop should then execute the calls exactly as it does for other providers.

## 15. Refusals and errors

Do not treat every native failure as a generic retryable error.

Useful classifications include:

| Native condition | Suggested status/classification |
|---|---:|
| Missing Claude CLI | 503 / configuration error |
| Not logged in | 401 / authentication error |
| Native authentication failure | 401 |
| Plan/session limit | 429 |
| Billing/usage-credit error | 402 |
| Native overload | 529 |
| Native server error | 503 |
| Upstream HTTP rejection | Preserve upstream status |
| Incomplete stream | Transport failure |
| Local validation error | Non-retryable input error |
| User cancellation | Cancellation, not provider failure |

An upstream refusal should become a terminal refusal response rather than an empty assistant response that the host blindly retries.

If a refusal includes a tool call that was cut off, do not execute the cut-off call. Preserve the native turn for replay metadata if needed, but expose no executable tool call to the host loop.

## 16. Native assistant replay metadata

Hermes stores a versioned native assistant carrier in reasoning metadata:

```json
{
  "type": "claude-subscription-directsdk-experimental.native_assistant",
  "version": 1,
  "messages": [
    "native assistant messages..."
  ],
  "projection": {
    "content": "visible assistant text",
    "tool_calls": []
  }
}
```

On the next request:

1. Compare the current visible assistant/tool projection with the stored projection.
2. If unchanged, replay the native messages exactly.
3. If changed by editing, compaction, or a hook, discard the stale carrier and reconstruct ordinary Claude content blocks.

This avoids attaching stale signed/native thinking to modified text.

You do not need this carrier for a first implementation if your app does not depend on signed thinking replay. Add it later if you need maximum continuity and cache reuse.

## 17. Model routing and context windows

Claude Code model aliases are not sufficient for context budgeting. The host must know whether a route selects a 200K or 1M context window.

Maintain a table similar to:

```ts
const MODEL_METADATA = {
  "claude-sonnet-5-5[1m]": {
    contextWindow: 1_000_000,
    supportsVision: true,
  },
  "claude-sonnet-5[1m]": {
    contextWindow: 1_000_000,
    supportsVision: true,
  },
  "claude-haiku-4-5-20251001": {
    contextWindow: 200_000,
    supportsVision: true,
  },
}
```

The long-context suffix must be passed consistently to both:

- Claude Code's `--model` argument.
- The host's context-budget calculation.

Do not let the host guess a 1M window merely from a family name. An unknown model should use a conservative window.

## 18. Thinking/reasoning compatibility

Some Claude routes reject disabled thinking or adaptive thinking settings.

The host should maintain model-specific rules:

```ts
const MANDATORY_THINKING = [
  "claude-fable",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
]

const NO_ADAPTIVE_THINKING = new Set([
  "claude-haiku-4-5-20251001",
])
```

When building the request:

- Omit `thinking: disabled` for routes that reject it.
- Omit adaptive thinking for routes that reject it.
- Translate host effort levels into Claude-native effort fields only when supported.
- Do not forward unsupported sampling fields just because another provider accepts them.

## 19. Request validation

Reject unsupported provider features explicitly rather than silently ignoring them.

Examples:

```ts
if (request.n !== undefined && request.n !== 1) {
  throw new Error("Only n=1 is supported")
}

if (request.toolChoice && request.toolChoice !== "auto") {
  throw new Error("Forced tool choice is unsupported")
}

if (request.parallelToolCalls === false) {
  throw new Error("parallel_tool_calls=false is unsupported")
}
```

Also reject unknown extra fields unless you intentionally translate them.

This is safer than passing arbitrary fields into Claude Code's environment or native request body.

## 20. Authentication behavior

The transport should not implement a second Claude authentication system.

Use the official CLI login:

```sh
claude auth login
```

At setup time:

1. Resolve the Claude executable.
2. Run `claude auth status`.
3. If absent, show the install hint.
4. If logged out, show the login command.
5. Do not save provider configuration until prerequisites pass.

The provider should not print or copy credential values.

Reject conflicting environment variables before spawning. In particular, do not allow a user-provided `ANTHROPIC_BASE_URL` to redirect the subscription bearer to an arbitrary host.

## 21. Telemetry and child environment

The plugin applies an explicit child-process traffic policy.

It always disables:

```text
DISABLE_AUTOUPDATER
DISABLE_FEEDBACK_COMMAND
```

An optional setting controls Claude Code's nonessential telemetry/feature traffic. If disabled, it sets the appropriate Claude Code environment flags.

Do not remove user-exported privacy settings accidentally. User-provided opt-outs should be preserved.

The child environment should also disable settings that would interfere with host ownership:

```text
ENABLE_TOOL_SEARCH=false
CLAUDE_CODE_MAX_RETRIES=0
DISABLE_AUTO_COMPACT=1
DISABLE_COMPACT=1
CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off
```

These values are provider-owned because the host owns the agent loop and context budget.

## 22. North Star implementation plan

Keep the existing native Claude Code agent adapter intact:

```text
src/main/agent/cli/claude.ts
```

Add a distinct provider transport, for example:

```text
src/main/agent/providers/claude-subscription/
  client.ts
  stream-json.ts
  history.ts
  admission.ts
  mcp.ts
  model-catalog.ts
  errors.ts
```

### Phase 1: structured transport

Implement:

- Fresh Claude process per request.
- `--input-format stream-json`.
- `--output-format stream-json`.
- History-to-frame translation.
- Native event parser.
- Text/tool-call response conversion.
- Existing North Star cancellation.

Do not implement cache restoration or signed native carriers yet.

### Phase 2: host-owned tools

Implement:

- Per-request tool manifest.
- Inert MCP server.
- Native tool disabling.
- Host-side tool execution.
- Tool-result replay.
- Strict validation of tool names and arguments.

### Phase 3: admission relay

Implement:

- Loopback relay.
- One-request gate.
- Upstream streaming.
- AbortSignal socket teardown.
- Upstream status/request-ID capture.
- No-secret logging policy.

### Phase 4: reliability

Add:

- Model context metadata.
- Thinking compatibility.
- Refusal handling.
- Native error classification.
- Incomplete-stream detection.
- Native usage propagation.
- Model discovery/setup checks.

### Phase 5: cache/replay optimization

Only after the basic provider works, add:

- Native assistant carriers.
- Lossless tool-result restoration.
- Cache breakpoint preservation.
- First-turn frame reordering.
- Cross-request cache qualification tests.

## 23. Suggested North Star provider interface

```ts
interface ModelProvider {
  id: string
  listModels(): Promise<ModelInfo[]>
  complete(input: {
    model: string
    messages: HostMessage[]
    tools: HostTool[]
    signal: AbortSignal
    stream: (event: ProviderStreamEvent) => void
  }): Promise<ProviderResponse>
  cancel?(): void
  close?(): Promise<void>
}
```

The provider should not know about the renderer. It should emit provider events, and the existing agent/UI layer should continue handling them.

## 24. Tests to write before using a real subscription

Use synthetic fake Claude processes and fake upstream HTTP servers first.

### Process/parser tests

- Split JSON across multiple stdout chunks.
- Multiple JSON events in one chunk.
- UTF-8 characters split across chunks.
- Assistant text streaming.
- Thinking streaming.
- Tool-use extraction.
- Tool-result extraction.
- Final result validation.
- Malformed stdout.
- Missing final result.
- Nonzero process exit.

### History tests

- System prompt conversion.
- Multiple user turns.
- Assistant/tool-call/tool-result sequence.
- Historical zero-turn acknowledgements.
- Final frame is the only queried frame.
- Edited assistant content does not reuse stale native metadata.
- Empty history and invalid ending roles are rejected.

### Relay tests

- First request is forwarded.
- Second request is rejected.
- Authorization header is forwarded but not logged.
- Streaming response reaches Claude process.
- Upstream HTTP errors preserve status.
- Upstream disconnect is reported.
- Cancellation closes the upstream socket.
- Relay rejects unexpected paths.
- Relay accepts only loopback HTTP fixtures in tests.

### Host integration tests

- Tool call reaches North Star's dispatcher.
- Tool result is sent back to Claude.
- Conversation persists assistant/tool rows correctly.
- Provider switching uses North Star history.
- Stop kills both Claude and relay.
- Temporary MCP configuration is removed on success, failure, and cancellation.

## 25. What not to copy blindly

Do not copy these Hermes assumptions without adapting them:

- Hermes provider registration APIs.
- Hermes-specific `reasoning_details` types.
- Hermes account-usage provider hooks.
- Hermes retry/fallback status conventions.
- Hermes tool naming rules.
- Hermes compaction thresholds.
- Hermes's Python subprocess implementation.
- Hermes's static Claude model table without verifying current Claude Code behavior.

The reusable design is the separation of responsibilities, not every internal class.

## 26. Minimal first implementation

A practical first version for North Star can be much smaller than the full Hermes plugin:

```text
1. Build request from North Star messages.
2. Write system prompt and tool manifest to a temp directory.
3. Start fresh Claude Code with stream-json stdin/stdout.
4. Send historical frames with shouldQuery=false.
5. Send the final frame with shouldQuery=true.
6. Parse assistant text and tool_use blocks.
7. Return tool calls to North Star.
8. Let North Star execute tools.
9. Send tool results on the next request.
10. Kill the process and clean up in finally.
```

Then add the admission relay once the basic provider loop is working.

## 27. Final design recommendation

North Star should expose two separate Claude integrations:

### `claude_code_agent`

- Uses `--session-id` and `--resume`.
- Claude Code owns native session state.
- Claude Code remains the agent.
- Best for native Claude Code behavior.

### `claude_subscription_direct`

- Starts a fresh process per model request.
- North Star owns canonical history.
- North Star owns tools, approvals, and compaction.
- Claude Code supplies subscription authentication and model execution.
- Uses stream-json and, ideally, the admission relay.
- Best for treating Claude as another provider alongside your other providers.

This preserves your current Claude Code experience while giving North Star a provider that behaves consistently with the rest of your multi-provider architecture.
