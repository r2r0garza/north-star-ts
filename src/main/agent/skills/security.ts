const FORBIDDEN_AUTHORITY_PATTERNS: Array<[RegExp, string]> = [
  [
    /\b(ignore|override|bypass|discard)\b.{0,80}\b(system|developer|higher[- ]priority|previous|above)\b/i,
    "claims authority over higher-priority instructions",
  ],
  [
    /\b(always|never|silently|automatically)\b.{0,80}\b(approve|allow|bypass|skip)\b.{0,80}\b(approval|permission|gate|prompt)\b/i,
    "claims approval or permission authority",
  ],
  [
    /\b(grant|enable|authorize|unlock)\b.{0,80}\b(tool|mcp|plugin|permission|capabilit)/i,
    "claims tool or capability authority",
  ],
  [
    /\b(read|reveal|print|dump|exfiltrate|upload|send|publish)\b.{0,80}\b(secrets?|tokens?|passwords?|credentials?|api keys?|private keys?)\b/i,
    "requests secret or credential disclosure",
  ],
  [
    /\b(hidden|delayed|background)\b.{0,80}\b(command|instruction|payload|rule)\b/i,
    "contains hidden or delayed command language",
  ],
  [
    /\bapproved_instruction\b|\btrusted instruction\b/i,
    "claims trusted instruction classification",
  ],
]

const SUSPICIOUS_RESOURCE_PATTERNS: Array<[RegExp, string]> = [
  [/\]\(\s*(?:file:|~\/|\/|[A-Za-z]:[\\/])[^)]*\)/, "links to an absolute local path"],
  [/\]\(\s*(?:\.\.\/|[^)]*\/\.\.\/)[^)]*\)/, "links outside the skill folder"],
  [/\b(?:file:|~\/|\/(?:etc|var|private|Users|home|root)\b)/, "references a sensitive local path"],
]

export function validateSkillSecurity(content: string): string[] {
  const warnings: string[] = []
  for (const [pattern, reason] of FORBIDDEN_AUTHORITY_PATTERNS) {
    if (pattern.test(content)) warnings.push(reason)
  }
  for (const [pattern, reason] of SUSPICIOUS_RESOURCE_PATTERNS) {
    if (pattern.test(content)) warnings.push(reason)
  }
  return [...new Set(warnings)]
}

export function assertSkillSecurity(content: string): void {
  const warnings = validateSkillSecurity(content)
  if (warnings.length === 0) return
  throw new Error(
    `Skill content needs review before installation: ${warnings.join("; ")}.`
  )
}
