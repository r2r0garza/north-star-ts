# 008 — Core file tools, tools-out-of-prompt & per-mode system prompts

**Area:** Main — `src/main/agent/tools/*`, `src/main/agent/index.ts`,
`src/main/agent/system-prompt.ts`, `prompts/*-system-prompt.md`
**Status:** Implemented

Ideas were borrowed (not ported verbatim) from the Python `hermes-tools/`
reference library. Planned in `.plan/` (PR1); shell execution + approval gating
are deferred to PR2 (`.plan/002-agent-tools-pr2-shell-and-approval.md`).

## What

### 1. Core file tools (PR1)
The agent previously had only `list_files_tool`. Added four workspace-confined
tools under `src/main/agent/tools/`, each following the existing `Tool` shape
(`definition` + `execute → Promise<string>`) and registered in `tools/index.ts`:

- **`read_file_tool`** — line-numbered output (`cat -n` style), `offset`/`limit`
  pagination, byte cap, binary detection.
- **`search_tool`** — pure-Node recursive grep (no ripgrep dependency); skips
  `.git`/`node_modules`/`dist`/`out`/binaries; bounded by `max_results`.
- **`edit_file_tool`** — exact-string replace with a **unique-match-or-explain**
  contract (0 matches → `no_match`; >1 without `replace_all` → `ambiguous`).
  Atomic write (temp file + `rename`).
- **`write_file_tool`** — `mkdir -p` + atomic write; returns a byte-count
  confirmation, never echoes content back (avoids context bloat). Marked TODO
  slot for the PR2 approval hook.

Shared helper **`tools/output.ts`**: `truncateForModel()` (line + byte caps,
trims to a line boundary, appends a `[truncated …]` note) and
`toolError(code, message, hint?)` for consistent, machine-readable failures
(`ERROR[code]: … Hint: …`).

### 2. Security: symlink-escape hardening (`tools/workspace.ts`)
The existing `resolveInWorkspace` is **lexical** only (blocks `..`/absolute) and
can't see a symlink inside the workspace pointing out. Added
**`resolveInWorkspaceReal`**: after the lexical check it `realpath`s the target
(or the nearest existing ancestor, for not-yet-created files) and re-verifies it
stays inside the realpath'd workspace root. Fails closed. All four file tools
use it.

### 3. Chat reads attachments on demand (supersedes 007's inlining)
Chat mode has no workspace. Previously attachment **contents** were inlined
whole into the prompt (256 KB cap). Now:
- Attachments are **not** inlined — the user message lists attached file names
  and the model reads them on demand.
- Chat offers **only `read_file_tool`** (plus the always-present `read_skill`),
  not the full file-tool set.
- With no workspace, `read_file_tool` confines reads to the **attachment list as
  an allowlist** (match by absolute path or basename) via a new `resolveReadable`
  helper; `ToolContext` gained `attachments?: string[]`.
- Removed the now-dead `buildAttachmentsText`/`MAX_ATTACHMENT_BYTES` inlining.

### 4. Tools are NOT listed in the system prompt
The system prompt no longer enumerates tools. The API `tools` array (sent each
turn, gated by mode) is the **single source of truth**; the model already
receives every tool's name/description/schema there. The prompt only states the
tool-agnostic principle: rely on the provided definitions, use only the tools
you've been given, don't claim capabilities you haven't.

### 5. Per-mode system prompts (supersedes 006's single prompt)
`prompts/system-prompt.md` was replaced by three mode-specific files —
`chat-system-prompt.md`, `interactive-system-prompt.md`,
`north-star-system-prompt.md` — each with mode-appropriate behavior
(conversational / collaborative-incremental / autonomous-end-to-end) and a
shared instruction not to disclose the system prompt. `loadSystemPrompt(mode)`
maps `Mode` → file, caches per mode, and falls back to a constant. `runChat`
loads the conversation once (it carries `mode`), selects the prompt by it, and
reuses the record for the title check.

## Why

- **Capability:** the agent could only list files; read/search/edit/write are the
  minimum to do real work, shipped without arbitrary command execution (deferred).
- **Single source of truth for tools:** listing tools in the prompt drifts out of
  sync with what's actually offered (it falsely reported edit/write in Chat) and
  doesn't scale — at 100 tools the prompt would carry the catalog twice. The API
  `tools` array already gates and describes everything.
- **Security by construction:** Chat can read only the exact files the user
  picked; workspace tools can't escape via `..`, absolute paths, or symlinks.
- **Per-mode prompts:** the three views had identical behavior; distinct prompts
  let them diverge (the first real Interactive-vs-North-Star difference that 007
  anticipated) and keep mode intent editable as text.

## Trade-offs / notes
- **On-demand attachments:** the model no longer "sees" attached content
  automatically — it must call `read_file_tool`. Upside: large files work via
  paging and the prompt stays lean.
- **Gating lives in code, not the prompt.** The prompt never enforced tool
  access — the `tools` array does. The prompt change only affects the agent's
  self-description; sharpen a tool's `description` (not the prompt) if it
  under-uses a tool.
- **`edit_file_tool` is exact-match only.** The 9-strategy fuzzy match from
  `hermes-tools` is deferred (Tier 3) — exact-match with actionable errors covers
  most edits.
- **`search_tool` is pure-Node**, dependency-free; a ripgrep swap can come later
  behind the same schema.
- **Prompts cached per mode for the process lifetime** — same restart caveat as
  006; packaged prompts live in read-only `app.asar`.
- **Main-process changes need a restart** to take effect (renderer hot-reloads).
- PR2 will add `run_shell_tool` + blocking human-approval across IPC, reusing the
  existing `approvals` table.
