import type { ActionClassifier, ActionDecision, ToolAction } from "./types"
import { normalizeCommand } from "./normalize"

// Deterministic, regex-based classifier for shell commands. Ported from
// hermes-tools/approval.py (HARDLINE_PATTERNS + DANGEROUS_PATTERNS). The LLM is
// NEVER the security boundary — classification is offline, explainable, and
// unit-tested.
//
// Two tiers:
//  - HARDLINE → hard_block: catastrophic, no recovery path (wipe disk rooted at
//    /, overwrite raw block device, kernel shutdown/reboot, fork bomb, kill -1).
//    Never overridable by the allowlist.
//  - DANGEROUS → require_approval: recoverable-but-risky (recursive rm, chmod
//    777, curl|sh, git reset --hard, writes to ~/.ssh / shell-rc / credentials /
//    /etc, etc.). Prompts the human.
// Everything else → allow.

// ── Shared path fragments (mirror approval.py) ───────────────────────────────
const SSH_SENSITIVE_PATH = String.raw`(?:~|\$home|\$\{home\})/\.ssh(?:/|$)`
const SHELL_RC_FILES = String.raw`(?:~|\$home|\$\{home\})/\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\b`
const CREDENTIAL_FILES = String.raw`(?:~|\$home|\$\{home\})/\.(?:netrc|pgpass|npmrc|pypirc)\b`
// macOS: /etc, /var, /tmp, /home are symlinks to /private/{etc,var,tmp,home}.
const MACOS_PRIVATE_SYSTEM_PATH = String.raw`/private/(?:etc|var|tmp|home)/`
const SYSTEM_CONFIG_PATH = String.raw`(?:/etc/|${MACOS_PRIVATE_SYSTEM_PATH})`
const PROJECT_ENV_PATH = String.raw`(?:(?:/|\.{1,2}/)?(?:[^\s/"'\`]+/)*\.env(?:\.[^/\s"'\`]+)*)`
const PROJECT_CONFIG_PATH = String.raw`(?:(?:/|\.{1,2}/)?(?:[^\s/"'\`]+/)*config\.yaml)`
const SENSITIVE_WRITE_TARGET = `(?:${SYSTEM_CONFIG_PATH}|/dev/sd|${SSH_SENSITIVE_PATH}|${SHELL_RC_FILES}|${CREDENTIAL_FILES})`
const USER_SENSITIVE_WRITE_TARGET = `(?:${SSH_SENSITIVE_PATH}|${SHELL_RC_FILES}|${CREDENTIAL_FILES})`
const PROJECT_SENSITIVE_WRITE_TARGET = `(?:${PROJECT_ENV_PATH}|${PROJECT_CONFIG_PATH})`
const COMMAND_TAIL = String.raw`(?:\s*(?:&&|\|\||;).*)?$`

// Regex fragment matching the *start* of a command (positions where a shell
// would begin parsing a new command). Keeps shutdown/reboot patterns from
// firing on "echo reboot" or "grep 'shutdown' log".
const CMDPOS =
  String.raw`(?:^|[;&|\n\`]|\$\()` +
  String.raw`\s*` +
  String.raw`(?:sudo\s+(?:-[^\s]+\s+)*)?` +
  String.raw`(?:env\s+(?:\w+=\S*\s+)*)?` +
  String.raw`(?:(?:exec|nohup|setsid|time)\s+)*` +
  String.raw`\s*`

type Pattern = [pattern: string, description: string]

// ── Hardline (unconditional block) ───────────────────────────────────────────
const HARDLINE_PATTERNS: Pattern[] = [
  [String.raw`\brm\s+(-[^\s]*\s+)*(/|/\*|/ \*)(\s|$)`, "recursive delete of root filesystem"],
  [
    String.raw`\brm\s+(-[^\s]*\s+)*(/home|/home/\*|/root|/root/\*|/etc|/etc/\*|/usr|/usr/\*|/var|/var/\*|/bin|/bin/\*|/sbin|/sbin/\*|/boot|/boot/\*|/lib|/lib/\*)(\s|$)`,
    "recursive delete of system directory",
  ],
  [String.raw`\brm\s+(-[^\s]*\s+)*(~|\$home)(/?|/\*)?(\s|$)`, "recursive delete of home directory"],
  [String.raw`\bmkfs(\.[a-z0-9]+)?\b`, "format filesystem (mkfs)"],
  [String.raw`\bdd\b[^\n]*\bof=/dev/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*`, "dd to raw block device"],
  [String.raw`>\s*/dev/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\b`, "redirect to raw block device"],
  [String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`, "fork bomb"],
  [String.raw`\bkill\s+(-[^\s]+\s+)*-1\b`, "kill all processes"],
  [CMDPOS + String.raw`(shutdown|reboot|halt|poweroff)\b`, "system shutdown/reboot"],
  [CMDPOS + String.raw`init\s+[06]\b`, "init 0/6 (shutdown/reboot)"],
  [CMDPOS + String.raw`systemctl\s+(poweroff|reboot|halt|kexec)\b`, "systemctl poweroff/reboot"],
  [CMDPOS + String.raw`telinit\s+[06]\b`, "telinit 0/6 (shutdown/reboot)"],
]

// ── Dangerous (require approval) ─────────────────────────────────────────────
const DANGEROUS_PATTERNS: Pattern[] = [
  [String.raw`\brm\s+(-[^\s]*\s+)*/`, "delete in root path"],
  [String.raw`\brm\s+-[^\s]*r`, "recursive delete"],
  [String.raw`\brm\s+--recursive\b`, "recursive delete (long flag)"],
  [String.raw`\bchmod\s+(-[^\s]*\s+)*(777|666|o\+[rwx]*w|a\+[rwx]*w)\b`, "world/other-writable permissions"],
  [String.raw`\bchmod\s+--recursive\b.*(777|666|o\+[rwx]*w|a\+[rwx]*w)`, "recursive world/other-writable (long flag)"],
  [String.raw`\bchown\s+(-[^\s]*)?r\s+root`, "recursive chown to root"],
  [String.raw`\bchown\s+--recursive\b.*root`, "recursive chown to root (long flag)"],
  [String.raw`\bmkfs\b`, "format filesystem"],
  [String.raw`\bdd\s+.*if=`, "disk copy"],
  [String.raw`>\s*/dev/sd`, "write to block device"],
  [String.raw`\bdrop\s+(table|database)\b`, "SQL DROP"],
  [String.raw`\bdelete\s+from\b(?![^\n]*\bwhere\b)`, "SQL DELETE without WHERE"],
  [String.raw`\btruncate\s+(table)?\s*\w`, "SQL TRUNCATE"],
  [String.raw`>\s*${SYSTEM_CONFIG_PATH}`, "overwrite system config"],
  [String.raw`\bsystemctl\s+(-[^\s]+\s+)*(stop|restart|disable|mask)\b`, "stop/restart system service"],
  [String.raw`\bkill\s+-9\s+-1\b`, "kill all processes"],
  [String.raw`\bpkill\s+-9\b`, "force kill processes"],
  [String.raw`\bkillall\s+(-[^\s]*\s+)*-(9|kill|sigkill)\b`, "force kill processes (killall -KILL)"],
  [String.raw`\bkillall\s+(-[^\s]*\s+)*-s\s+(kill|sigkill|9)\b`, "force kill processes (killall -s KILL)"],
  [String.raw`\bkillall\s+(-[^\s]*\s+)*-r\b`, "kill processes by regex (killall -r)"],
  [String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`, "fork bomb"],
  [String.raw`\b(bash|sh|zsh|ksh)\s+-[^\s]*c(\s+|$)`, "shell command via -c/-lc flag"],
  [String.raw`\b(python[23]?|perl|ruby|node)\s+-[ec]\s+`, "script execution via -e/-c flag"],
  [String.raw`\b(curl|wget)\b.*\|\s*(?:[/\w]*/)?(?:ba)?sh(?:\s|$|-c)`, "pipe remote content to shell"],
  [String.raw`\b(bash|sh|zsh|ksh)\s+<\s*<?\s*\(\s*(curl|wget)\b`, "execute remote script via process substitution"],
  [String.raw`\btee\b.*["']?${SENSITIVE_WRITE_TARGET}`, "overwrite system file via tee"],
  [String.raw`>>?\s*["']?${SENSITIVE_WRITE_TARGET}`, "overwrite system file via redirection"],
  [String.raw`\btee\b.*["']?${PROJECT_SENSITIVE_WRITE_TARGET}["']?${COMMAND_TAIL}`, "overwrite project env/config via tee"],
  [String.raw`>>?\s*["']?${PROJECT_SENSITIVE_WRITE_TARGET}["']?${COMMAND_TAIL}`, "overwrite project env/config via redirection"],
  [String.raw`\bxargs\s+.*\brm\b`, "xargs with rm"],
  [String.raw`\bfind\b.*-exec(?:dir)?\s+(/\S*/)?rm\b`, "find -exec/-execdir rm"],
  [String.raw`\bfind\b.*-delete\b`, "find -delete"],
  [String.raw`\b(cp|mv|install)\b.*\s${SYSTEM_CONFIG_PATH}`, "copy/move file into system config path"],
  [String.raw`\b(cp|mv|install)\b.*\s["']?${PROJECT_SENSITIVE_WRITE_TARGET}["']?${COMMAND_TAIL}`, "overwrite project env/config file"],
  [
    String.raw`\b(cp|mv|install)\b.*\s["']?${SENSITIVE_WRITE_TARGET}[^\s"']*["']?${COMMAND_TAIL}`,
    "copy/move file into sensitive credential/SSH/shell-rc path",
  ],
  [String.raw`\bsed\s+-[^\s]*i.*(?:${USER_SENSITIVE_WRITE_TARGET})[^\s"']*`, "in-place edit of sensitive credential/SSH/shell-rc path"],
  [String.raw`\bsed\s+--in-place\b.*(?:${USER_SENSITIVE_WRITE_TARGET})[^\s"']*`, "in-place edit of sensitive credential/SSH/shell-rc path (long flag)"],
  [String.raw`\b(?:perl|ruby)\b.*(?:^|\s)-[^\s]*i\b.*(?:${USER_SENSITIVE_WRITE_TARGET})[^\s"']*`, "in-place edit of sensitive credential/SSH/shell-rc path (perl/ruby)"],
  [String.raw`\bsed\s+-[^\s]*i.*\s${SYSTEM_CONFIG_PATH}`, "in-place edit of system config"],
  [String.raw`\bsed\s+--in-place\b.*\s${SYSTEM_CONFIG_PATH}`, "in-place edit of system config (long flag)"],
  [String.raw`\b(python[23]?|perl|ruby|node)\s+<<`, "script execution via heredoc"],
  [String.raw`\bgit\s+reset\s+--hard\b`, "git reset --hard (destroys uncommitted changes)"],
  [String.raw`\bgit\s+push\b.*--force\b`, "git force push (rewrites remote history)"],
  [String.raw`\bgit\s+push\b.*-f\b`, "git force push short flag (rewrites remote history)"],
  [String.raw`\bgit\s+clean\s+-[^\s]*f`, "git clean with force (deletes untracked files)"],
  [String.raw`\bgit\s+branch\s+-d\b`, "git branch force delete"],
  [String.raw`\bchmod\s+\+x\b.*[;&|]+\s*\./`, "chmod +x followed by immediate execution"],
  [String.raw`\bsudo\b[^;|&\n]*?\s+(?:-s\b|--stdin\b|-a\b|--askpass\b)`, "sudo with privilege flag (stdin/askpass/shell/list)"],
  [String.raw`\bsudo\b[^;|&\n]*?\s+-[a-z]*[sa][a-z]*\b`, "sudo with combined-flag privilege escalation"],
]

// Pre-compile at module load. Patterns are authored lowercase-friendly and we
// match against the normalized+lowercased command, so the `i` flag is belt-and-
// suspenders; `s` (dotAll) mirrors Python's re.DOTALL.
function compile(patterns: Pattern[]): Array<[RegExp, string]> {
  return patterns.map(([p, d]) => [new RegExp(p, "is"), d])
}
const HARDLINE_COMPILED = compile(HARDLINE_PATTERNS)
const DANGEROUS_COMPILED = compile(DANGEROUS_PATTERNS)

export class RegexCommandClassifier implements ActionClassifier {
  classify(action: ToolAction): ActionDecision | null {
    if (action.kind !== "shell") return null
    const command =
      typeof action.detail?.command === "string"
        ? (action.detail.command as string)
        : action.identity
    const normalized = normalizeCommand(command).toLowerCase()

    for (const [re, description] of HARDLINE_COMPILED) {
      if (re.test(normalized)) return { level: "hard_block", reason: description }
    }
    for (const [re, description] of DANGEROUS_COMPILED) {
      if (re.test(normalized)) return { level: "require_approval", reason: description }
    }
    return { level: "allow" }
  }
}
