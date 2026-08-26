# PR52: Local shell confinement and syntax-aware command policy

> Status: **NOT STARTED**. Depends on `051` so every one-shot/session command
> shares one spawn and policy seam. Security-focused; no DB migration expected.

## Context

`LocalEnvironment.exec` sets `cwd` to the workspace, but cwd is not confinement:
a command can still read/write absolute paths, follow symlinks, or access the
network. The existing offline regex classifier is a valuable hard-block/approval
layer, yet shell strings contain pipelines, substitutions, redirects, heredocs,
environment assignments, and platform-specific syntax that regexes can only
approximate.

Containers provide a stronger boundary, but Local is the default and CLI-agent
work has made the distinction more visible. The UI and policy must not imply that
“workspace cwd” means “workspace sandbox.”

## Goal

Create one syntax-aware command analysis/policy pipeline for all internal shell
sessions, make Local host access explicit, and add enforceable filesystem/network
profiles where the operating system supports them. Unknown syntax fails toward
approval, never toward silent allow.

## Delivery slices

### 052.1 — Honest posture + parsed policy

- Introduce `analyzeShellCommand(command, platform)` returning command segments,
  pipelines, substitutions, redirects, candidate read/write paths, network
  operations, and parse confidence.
- Evaluate every executable segment and redirection through the existing
  hard-block/danger categories. Preserve normalization and regex rules as
  defense-in-depth over the parsed representation.
- Parse failure/unsupported constructs → `require_approval`; known hardline text
  still hard-blocks even when parsing fails.
- Separate approvals for command execution, filesystem outside workspace, and
  network access. Display the detected executable/actions and targets.
- Rename UI language from “confined to workspace” to the accurate posture:
  Local runs with host permissions unless an OS sandbox profile is active.

Parser selection is an implementation spike with fixtures as the decision gate:
prefer a maintained, pure JS/wasm parser that works in Electron main without a
new ABI rebuild. If no parser covers supported shells reliably, implement a
conservative tokenizer for policy segmentation and treat complex/unknown syntax
as approval-required rather than adopting an unmaintained parser as a security
boundary.

### 052.2 — Enforced Local profiles

- Define `read-only`, `workspace-write`, and `host-access` profiles independently
  from approval mode.
- `read-only`: workspace readable, no filesystem writes; network off by default.
- `workspace-write`: writes limited to resolved workspace/temp locations; network
  off by default with per-domain/command approval where enforceable.
- `host-access`: today's host capability, clearly labeled and still protected by
  hard blocks/approvals.
- Implement per-platform adapters only where enforcement is dependable. A
  platform without an enforceable adapter must refuse the stronger label and
  offer container execution or explicit host-access—not simulate isolation with
  regexes.
- Keep container profiles authoritative when a container backend is selected;
  do not stack a host sandbox around `docker`/`podman` commands accidentally.

## Policy and audit

- Policy decisions include parser confidence, command segments, filesystem
  targets, network intent, selected profile, and reason.
- Allowlist identity is based on normalized parsed actions, not the entire raw
  string alone; material changes to redirects/subcommands require a new decision.
- Never persist command output secrets in policy records. Continue to redact
  sensitive environment values from activity details.
- Add regression fixtures for obfuscation, quoting, command substitution,
  heredocs, aliases/wrappers, redirects, globbing, Windows cmd/PowerShell, and
  Unicode normalization.

## Implementation areas

- `approval/`: analyzer abstraction, parsed classifier, policy reason/detail.
- `env/`: Local sandbox profile adapters and capability detection.
- `051` command-session spawn seam: one enforcement entry point for exec/stdin.
- Settings/execution UI: accurate profile availability and fallback explanation.

## Verification

- Existing hardline/danger corpus remains blocked/prompted.
- Compound commands cannot hide a dangerous second segment or redirect target.
- Unknown/invalid syntax never auto-allows.
- Filesystem and network probes demonstrate actual profile enforcement, including
  symlink and child-process attempts—not merely classifier decisions.
- Unsupported platforms show host-access/container fallback honestly.
- Approval allowlists do not broaden when command structure or targets change.
- Local, Docker, and Podman execution retain correct process-tree Stop behavior.

## Out of scope

- Claiming a cross-platform sandbox before each platform adapter passes probes.
- Sandboxing external Claude/Codex CLI providers; they own their native policy.
- Replacing container runtime profiles.
