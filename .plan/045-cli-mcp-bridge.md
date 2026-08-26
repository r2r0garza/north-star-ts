# PR45: North Star MCP bridge for CLI providers

> Status: **NOT STARTED**. Depends on `041` (Claude Code, implemented) and
> `042` (Codex CLI) for the two client adapters. The bridge foundation can be
> built against Claude first, but the phase is complete only after both CLIs
> pass the same contract tests and live smoke test.

## Context

CLI providers deliberately branch before `runAgentLoop`: Claude Code and Codex
own their agent loops, built-in tools, permissions, context assembly, and native
session state. That boundary is correct, but it also means they cannot currently
reach capabilities that exist only inside North Star, such as the persisted
workspace index, Process state, dashboards, or an app-rendered question/approval
round trip.

North Star already has the opposite MCP role: `src/main/agent/mcp/` is an MCP
**client** that connects the internal agent loop to external stdio/HTTP servers.
This phase adds a separate MCP **server** role. Each spawned CLI becomes a
short-lived client of a loopback North Star endpoint and receives only the tools
authorized for its current conversation turn.

MCP does not transport or discover LLM models. This bridge does **not** restore
gateway model import for CLI providers; it exposes tools, resources, and prompts.

## Verified client and SDK behavior

Researched against the current official documentation on 2026-08-26 and the
installed `@modelcontextprotocol/sdk` `1.30.0`:

- Claude Code accepts a session-only `--mcp-config <file>` in both interactive
  and `-p` modes. HTTP server definitions support `headers`, including
  `${ENV_VAR}` expansion. `--strict-mcp-config` would suppress the user's other
  configured servers, so North Star must **not** pass it by default.
- Claude tools can be pre-approved narrowly with
  `--allowedTools "mcp__north-star__<tool>"` (or an exact generated list).
- Codex accepts global `-c/--config key=value` overrides on `codex exec`, so a
  temporary `mcp_servers` entry can be injected without changing
  `~/.codex/config.toml`. Streamable HTTP definitions support a URL and a bearer
  token read from a named environment variable.
- The TypeScript SDK supports Streamable HTTP, stateless transports, and a
  localhost Express app with DNS-rebinding protection. The app already depends
  on this SDK; no second MCP implementation is required.

Every first-turn and resume command must carry the injected MCP configuration.
The CLI process is recreated per app turn, even when its native conversation is
resumed.

## Goal

Give Claude Code and Codex CLI a secure, ephemeral connection to a deliberately
small North Star tool surface without:

1. modifying the user's project/global CLI configuration;
2. exposing the Electron renderer, SQLite, or the internal tool registry
   directly;
3. trusting a client-supplied conversation id or workspace path; or
4. duplicating filesystem and shell tools the CLIs already provide natively.

The first vertical slice exposes one read-only, North-Star-specific capability:
`index_query`. A second slice adds the app-mediated human question round trip.

## Core design

### 1. Lazy loopback Streamable HTTP server

- Add a distinct server package under `src/main/agent/mcp-server/`; do not mix
  it into `src/main/agent/mcp/`, which remains the external-server client pool.
- `getCliMcpBridge()` lazily starts one HTTP listener when the first CLI turn
  requests a grant. Bind **only** to `127.0.0.1` with port `0` and retain the
  selected port for the app process lifetime.
- Use the SDK's localhost Express helper/DNS-rebinding protection plus explicit
  host/origin validation, a small JSON body limit, and an `Authorization` check
  before the MCP transport handles a request.
- Use a stateless Streamable HTTP transport in `045.1`. North Star needs no
  server push, subscriptions, or transport session state for request/response
  tools. If later features require notifications, add stateful transports with
  explicit session maps and `onclose` cleanup then.
- Dispose the listener from Electron's `will-quit` path alongside the existing
  MCP client pool, browser manager, terminal service, and DB.

HTTP is preferred over stdio here because North Star owns one live server and
multiple independently spawned clients connect to it. A stdio definition would
make each CLI responsible for spawning a sidecar process, forcing a second IPC
hop back into Electron and duplicating lifecycle/state.

### 2. Per-turn capability grants

The endpoint being loopback-only is not sufficient authorization. Before each
CLI spawn, mint a cryptographically random bearer token and store only an
in-memory grant:

```ts
type CliMcpGrant = {
  conversationId: string
  workingDirectory: string
  workspace: string | null
  provider: "claude_code" | "codex_cli"
  allowedTools: ReadonlySet<string>
  expiresAt: number
}
```

- The token, not MCP arguments, determines the conversation, workspace, and
  allowed tool set. Model-supplied paths continue through existing workspace
  confinement where a tool accepts paths.
- Chat keeps its app-owned CLI working directory but has `workspace:null`;
  workspace-only tools such as `index_query` are omitted from that grant rather
  than treating the empty chat directory as an indexed project.
- Put the token in a task-specific child environment variable such as
  `NORTH_STAR_MCP_TOKEN`; never place it in argv, where process listings expose
  it. Claude's generated config references it from the Authorization header;
  Codex uses `bearer_token_env_var`.
- Revoke the grant in the CLI runner's `finally` block on success, failure, Stop,
  or spawn error. Also enforce a short expiry as defense in depth and clear all
  grants when the bridge closes.
- Compare tokens in constant time and return the same unauthorized response for
  missing, expired, revoked, and unknown values.
- Grants are ephemeral runtime state: **no schema migration and no secret
  persistence**.

### 3. Per-provider config injection

Extend the provider adapters, not the shared renderer or project files:

- **Claude Code:** generate an app-owned JSON config containing one HTTP server
  named `north-star`; append `--mcp-config <path>` and the exact North Star MCP
  tool allowlist to both first and resumed argv. The config contains the URL and
  `${NORTH_STAR_MCP_TOKEN}` placeholder, never the token. Do not pass
  `--strict-mcp-config`, so user/project MCP servers continue to work.
- **Codex CLI:** prepend argv-safe `-c` overrides defining the `north-star` URL
  and bearer-token environment variable to both `exec` and `exec resume`.
  Continue to pass args as an array; no shell interpolation or quoting layer.
- The runner receives `{ url, tokenEnv, allowedTools }` from the bridge, merges
  the single token into `hostCliEnv()`, and revokes it when the child settles.
- If the bridge cannot start or the config is rejected, fail the turn with a
  precise North Star MCP error; do not silently run with a partial contract.

### 4. Explicit tool adapters, not `runTool()` passthrough

Do not register every entry from `src/main/agent/tools/` automatically. That
registry assumes a fully constructed `ToolContext` and contains filesystem,
shell, browser, delegation, approval, and Process operations with materially
different trust and lifecycle needs.

Each MCP tool gets an explicit adapter that:

- defines its MCP schema, annotations, and bounded output;
- names the capability required by the grant;
- derives its workspace/conversation only from the authenticated grant;
- calls a narrow domain service rather than fabricating a broad `ToolContext`;
- preserves application-side authorization even if the CLI itself is running
  in an auto-approval posture; and
- emits structured errors without leaking absolute paths, tokens, or internal
  stack traces.

For `index_query`, extract the current query body from
`index_query_tool.ts` into a shared pure/service function. The internal tool and
MCP adapter call that function with a server-derived workspace. Keep the current
partial/stale-index warning and result caps.

Read-only MCP tools receive the MCP `readOnlyHint`; Claude may execute independent
read-only calls concurrently. Mutating tools must remain sequential and require
an explicit North Star policy decision.

### 5. Why filesystem and shell stay native

“Native is better” here means **better integrated with that CLI's own agent
runtime**, not that North Star's tools are generally inferior:

- Claude already supplies `Read`, `Edit`, `Write`, `Glob`, `Grep`, and `Bash`,
  with path-aware permissions, sandbox rules, parallel read-only execution, and
  first-class tool events. Codex similarly owns `apply_patch`, fast file search,
  `exec_command`, `write_stdin`, PTY/process sessions, sandbox profiles, and
  command events.
- The models and CLI system prompts are designed around those exact schemas and
  error/result shapes. Their edit/shell calls participate directly in native
  sandboxing, approval policy, resumable session history, output streaming, and
  process cancellation.
- An MCP duplicate would add HTTP/JSON-RPC serialization, a second path policy,
  a second approval decision, different truncation semantics, and ambiguous tool
  choice without adding a capability. Long-running shell state would be
  especially awkward because North Star would need another remote process table
  and stdin/kill protocol while Codex and Claude already own one.
- North Star's versions remain valuable for the internal `runAgentLoop`: they
  provide a provider-neutral interface, container backends, app approvals, and
  strict workspace resolution. Those advantages do not transfer automatically
  when the outer agent loop belongs to a CLI and is already forced to Local.

If a future requirement is **uniform North Star enforcement** rather than added
capability, wrapping filesystem/shell can be reconsidered—but only together
with disabling the corresponding native CLI tools. Offering both paths would
not enforce anything and would make behavior less predictable.

## Delivery slices

### 045.1 — Bridge foundation + `index_query`

1. Add the lazy authenticated Streamable HTTP server and lifecycle cleanup.
2. Add per-turn grant mint/revoke/expiry and exact tool filtering.
3. Extract and register the shared `index_query` service.
4. Inject the bridge into Claude and Codex first/resume argv without touching
   user or workspace MCP files.
5. Map MCP tool start/result events through each CLI's existing JSONL activity
   stream so users can see `north-star · index_query` in the transcript.
6. Advertise the connection in CLI-provider UI copy as “North Star tools:
   workspace index”; no general enable/disable setting is needed for this
   read-only first slice.

### 045.2 — Human round trip (`ask_user_question`)

1. Extract the current renderer question flow behind a conversation-scoped
   broker usable by both `runAgentLoop` and MCP requests.
2. Register `ask_user_question` only for a live foreground CLI turn with an
   attached renderer. The MCP call awaits the existing UI answer and returns the
   normalized answer JSON.
3. Stop, renderer dismissal, bridge revocation, or app quit resolves the pending
   call as cancelled—never leaves the CLI hanging.
4. Set an explicit MCP/CLI tool timeout long enough for human response, while
   keeping a final bounded expiry and showing the waiting state in the activity
   UI.

Process/todo/dashboard tools are candidates after these slices demonstrate the
capability model. Each should receive its own write-policy decision; they are not
implicitly included in `045.2`.

## Security invariants

- Listener is loopback-only; never `0.0.0.0`, LAN, or a fixed public port.
- A valid, unexpired per-turn bearer grant is required before MCP initialize,
  list, or call handling.
- Authentication context is authoritative; the CLI cannot select another
  conversation/workspace by argument.
- Tool registration is the intersection of server-supported tools and the
  grant allowlist. Unknown tools fail closed.
- Side-effect authorization is enforced inside North Star. Claude/Codex tool
  permission flags are an additional client-side layer, not the security
  boundary.
- No token in logs, argv, JSONL events, persisted transcripts, SQLite, or config
  files.
- Response sizes, request bodies, execution time, and concurrent requests are
  bounded. Stop/abort propagates to any pending MCP operation.
- Do not proxy arbitrary external MCP servers through North Star in this phase;
  both clients already load their own configured servers, and proxying would
  blur credentials, approvals, names, and audit ownership.

## Verification

### Automated

- Real loopback SDK-client test: initialize, list `index_query`, call it, and
  receive workspace-specific indexed output.
- Missing/wrong/expired/revoked tokens all fail before MCP handling.
- Two simultaneous grants cannot read one another's workspace or tools.
- Grant cleanup runs for success, CLI failure, spawn failure, Stop, and bridge
  disposal.
- Claude and Codex arg tests cover first + resume, preserve user MCP config, and
  prove the bearer token appears only in the child environment.
- Config fixtures parse under the installed CLI versions; no shell quoting is
  used.
- Existing internal `index_query_tool` tests still pass against the extracted
  shared service.
- `pnpm typecheck`, targeted tests, full regression suite, and `pnpm build`.

### Manual

1. Start one Claude Code and one Codex conversation in different indexed
   workspaces; ask each to locate a known symbol through North Star's index.
2. Confirm the MCP activity is visible and each answer names only files from its
   own workspace.
3. Resume both conversations and confirm the bridge is re-injected and callable.
4. Stop during a call; confirm the CLI exits, the grant is revoked, and replaying
   the captured endpoint/token fails.
5. Confirm each CLI's pre-existing user/project MCP servers still load.
6. For `045.2`, ask a deliberately ambiguous question, answer in the Electron
   panel, and confirm the CLI continues with the selected/free-form response.

## Out of scope

- Model discovery/import or proxying model inference through MCP.
- Replacing Claude/Codex native file, search, edit, or shell tools.
- Injecting North Star skills, system prompts, or the complete internal tool
  registry.
- Exposing the bridge outside the local machine or supporting remote/cloud CLI
  workers.
- OAuth for the app-owned loopback endpoint.
- Proxying external MCP servers or their stored OAuth credentials.

## Documentation update required on implementation

`034` and the CLI-specific plans currently state that North Star tools do not
apply to CLI turns. Preserve the core “CLI owns its loop” rule, but qualify it:
CLI providers receive only the explicitly granted North Star MCP bridge tools;
they still do not enter `runAgentLoop` or inherit its tool/context registry.
