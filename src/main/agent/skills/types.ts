// Parsed metadata from a SKILL.md, per the Agent Skills spec
// (agentskills.io/specification).
export interface SkillMetadata {
  // Skill identifier: 1–64 chars, lowercase alphanumeric + single hyphens,
  // matches the directory name.
  name: string
  // What the skill does AND when to use it. Max 1024 chars.
  description: string
  // Absolute path to the SKILL.md file — read_skill resolves names to this.
  path: string
  // Full markdown body (frontmatter stripped). Loaded eagerly but NOT put in
  // the prompt — read_skill returns it on demand (progressive disclosure).
  body: string
  // Which source this skill came from, for diagnostics (base | user | project).
  source: string
  license?: string
  compatibility?: string
  metadata: Record<string, string>
  // Tool names the skill recommends. Advisory only.
  allowedTools: string[]
}

// One skill-source directory as surfaced to the Settings → Capabilities table.
// `kind` distinguishes the locked built-ins from user-added custom folders:
//   user      — ~/.<system>/skills (seeded once from the app-bundled skills)
//   custom    — a folder the user registered (removable)
//   github    — <workspace>/.github/skills (zero-config, workspace-scoped)
//   workspace — <workspace>/.<system>/skills
// Note: there's no "app" kind — the app-bundled dir seeds `user` on first launch
// and is not itself a live source.
export type SkillSourceKind = "user" | "custom" | "github" | "workspace"
export interface SkillSourceRow {
  path: string
  kind: SkillSourceKind
  skillCount: number
}
