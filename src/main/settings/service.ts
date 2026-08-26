import * as settingsRepo from "../db/repositories/settings"
import { envConfigFromEnv, type EnvConfig } from "../agent/env/factory"

// The single main-process read/write point for persisted settings. Backed by the
// flat key→JSON `settings` table (SCHEMA_V4), it parses blobs into typed shapes,
// caches them in memory, and bakes in defaults so a fresh install behaves exactly
// like before any setting was written. This slice covers execution backend +
// approval policy only; LLM provider/model/API-key settings (and safeStorage
// secret handling) are a later slice.

// ── Stored shapes ────────────────────────────────────────────────────────────

export type Backend = "local" | "docker" | "podman"
export type FilePermission = "auto" | "require_approval"

// Approval categories a sandbox MAY auto-approve. Read ops aren't here (they're
// never gated). Hardline commands aren't here (never downgraded — see policy.ts).
// Only `workspace_mutation` defaults on when sandbox auto-approve is enabled;
// the riskier categories stay off until the user opts each one in.
export type ApprovalCategory =
  | "workspace_mutation" // file_write / file_edit inside the workspace
  | "destructive_fs" // recursive/forced delete (rm -r, find -delete, git clean -f)
  | "history_rewrite" // git reset --hard, git push --force
  | "system_mutation" // chmod 777, writes to system/credential paths
  | "network_access" // curl/wget/ssh/git fetch/pull/push/package installs
  | "code_exec" // bash -c, curl|sh, interpreter -e

export const SANDBOX_CATEGORY_DEFAULTS: Record<ApprovalCategory, boolean> = {
  workspace_mutation: true,
  destructive_fs: false,
  history_rewrite: false,
  system_mutation: false,
  network_access: false,
  code_exec: false,
}

export interface ExecutionSettings {
  backend: Backend
  image?: string
  sandbox: {
    // Master switch. When false, no sandbox downgrade happens at all.
    autoApprove: boolean
    // Whether the user has been shown the one-time onboarding explanation.
    prompted: boolean
    // Per-category opt-in (only consulted when autoApprove is true).
    categories: Record<ApprovalCategory, boolean>
  }
}

export interface PermissionSettings {
  file_write: FilePermission
  file_edit: FilePermission
}

// The DEFAULT LLM selection — which configured provider account + model new
// conversations start with. Each conversation can override it (see the nullable
// account_id/model_id columns on `conversations`, SCHEMA_V6); this blob is only
// the fallback when a conversation hasn't pinned its own. The accounts and models
// themselves live in their own tables (SCHEMA_V5); this only points at the
// default pair. Both null on a fresh install → the UI prompts the user to
// configure a provider before the first turn.
export interface LlmSettings {
  activeAccountId: string | null
  activeModelId: string | null
}

// Dedicated model for automatic memory maintenance. Null account/model means
// "use the default chat model"; disabling keeps existing memory files readable
// but stops all background writes.
export interface MemorySettings {
  enabled: boolean
  accountId: string | null
  modelId: string | null
}

// Dedicated model for cheap conversation title generation. Null account/model
// means "use the default chat model".
export interface TitleGenerationSettings {
  accountId: string | null
  modelId: string | null
}

// Workspace Indexing (plan 008). Global defaults; a per-workspace disable lives
// on index_runs.enabled, not here.
export interface IndexingSettings {
  // Auto-start indexing when a workspace is assigned to an interactive/north_star
  // conversation. A per-workspace disable overrides this.
  autoIndexNewWorkspaces: boolean
  // Feed the index into the agent's system prompt (a compact workspace summary).
  // Off = the index still builds but the agent ignores it (useful for debugging).
  useIndexForContext: boolean
  // Stage 4 semantic embeddings — deferred; shown disabled in the UI to signal
  // the roadmap. Persisted so the toggle round-trips, but unused in slice 1.
  includeEmbeddings: boolean
  // Conversation-summary triggers (plan 019). A summary regenerates when the
  // un-summarized tail past coversThrough reaches EITHER threshold (whichever
  // comes first). `0` disables that trigger independently: message=0 ⇒ summarize
  // on tokens only; both 0 ⇒ summarization off. See summaries/service.ts.
  summarizeMessageThreshold: number
  summarizeTokenThreshold: number
  // Debug aid: when on, each turn's assembled system prompt is written verbatim
  // to system-prompt-logs/<mode> - <MM-DD-YYYY HH-MM-SS>.md. Off by default.
  logSystemPrompt: boolean
}

// Extra skill-source folders the user registers in Settings → Capabilities, on
// top of the built-in sources (app-bundled, ~/.cowork/skills, and the workspace
// dirs). Each is an absolute path treated as a CONTAINER of <skill-name>/SKILL.md
// subfolders, exactly like the built-ins. See agent/skills/sources.ts.
export interface SkillSourcesSettings {
  folders: string[]
}

// Extra agent-source folders the user registers in Settings → Capabilities, on
// top of the built-in sources (~/.cowork/agents and the workspace dirs). Each is
// an absolute path treated as a CONTAINER of `<name>.agent.md` files, exactly
// like the built-ins. Applies across chat/interactive/north_star conversations.
// See agent/agents/sources.ts.
export interface AgentSourcesSettings {
  folders: string[]
}

// Extra MCP-source folders the user registers in Settings → Capabilities, on top
// of the built-in sources (~/.cowork and the workspace dirs). Each is an absolute
// path treated as a CONTAINER of an mcp.json config file, like the built-ins.
// See agent/mcp/sources.ts.
export interface McpSourcesSettings {
  folders: string[]
}

// Agent browser preferences. `revealOnAgentUse` controls whether the browser
// window pops to the front when the agent navigates in the conversation you're
// viewing: "always" reveals it, "never" keeps it hidden (the page still runs and
// screenshots still work; a browser_handoff for a captcha/login still reveals).
export type BrowserReveal = "always" | "never"
export interface BrowserSettings {
  revealOnAgentUse: BrowserReveal
}

// User-editable brand colors (Settings → Appearance), overriding the .env
// presets (NEXT_accent_color / NEXT_neutral_color). Each is a hex string, or
// null to defer to the env preset / built-in default for that channel. The
// recolor math lives in src/shared/theme.ts; precedence is resolved in
// src/main/config/theme.ts resolveBrandTheme (DB > env > default).
export interface ThemeSettings {
  accent: string | null
  neutral: string | null
}

// Which IDE a changed-file pill / "open in editor" launches. "system" (default)
// hands the file to the OS default app; otherwise it's a known IDE id (see
// src/main/ide/open.ts IDES). Stored as a plain id string so adding IDEs needs no
// migration.
export interface IdeSettings {
  ide: string
}

// Desktop (OS) notifications. `enabled` is the master switch; the per-event
// flags let the user mute categories they don't care about. The renderer decides
// whether to actually fire (it knows which conversation is on screen and whether
// the window is focused); these flags gate which categories are eligible at all.
// All default ON so notifications work out of the box once enabled.
export interface NotificationSettings {
  enabled: boolean
  // Agent paused for a human decision (approval prompt or ask_user_question).
  onNeedsInput: boolean
  // A turn finished streaming its final answer.
  onTurnComplete: boolean
  // A turn failed (error or unavailable backend).
  onTurnError: boolean
  // A background task / delegated subagent completed.
  onTaskComplete: boolean
}

// Default container image when a runtime is chosen but no image is set.
const DEFAULT_CONTAINER_IMAGE = "node:20-bookworm"

const DEFAULT_PERMISSIONS: PermissionSettings = {
  file_write: "auto",
  file_edit: "auto",
}

const DEFAULT_LLM: LlmSettings = {
  activeAccountId: null,
  activeModelId: null,
}

const DEFAULT_MEMORY: MemorySettings = {
  enabled: false,
  accountId: null,
  modelId: null,
}

const DEFAULT_TITLE_GENERATION: TitleGenerationSettings = {
  accountId: null,
  modelId: null,
}

const DEFAULT_INDEXING: IndexingSettings = {
  autoIndexNewWorkspaces: true,
  useIndexForContext: true,
  includeEmbeddings: false,
  // Token-only triggering by default: message count off (0), summarize once the
  // fresh tail reaches ~80k tokens. Both are user-adjustable in Settings.
  summarizeMessageThreshold: 0,
  summarizeTokenThreshold: 80000,
  logSystemPrompt: false,
}

const DEFAULT_SKILL_SOURCES: SkillSourcesSettings = { folders: [] }

const DEFAULT_AGENT_SOURCES: AgentSourcesSettings = { folders: [] }
const DEFAULT_MCP_SOURCES: McpSourcesSettings = { folders: [] }

const DEFAULT_BROWSER: BrowserSettings = {
  revealOnAgentUse: "always",
}

const DEFAULT_THEME: ThemeSettings = {
  accent: null,
  neutral: null,
}

const DEFAULT_IDE: IdeSettings = {
  ide: "system",
}

const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: true,
  onNeedsInput: true,
  onTurnComplete: true,
  onTurnError: true,
  onTaskComplete: true,
}

function defaultExecution(): ExecutionSettings {
  return {
    backend: "local",
    sandbox: {
      autoApprove: false,
      prompted: false,
      categories: { ...SANDBOX_CATEGORY_DEFAULTS },
    },
  }
}

// ── Keys + cache ─────────────────────────────────────────────────────────────

const KEY_EXECUTION = "execution"
const KEY_PERMISSIONS = "permissions"
const KEY_LLM = "llm"
const KEY_MEMORY = "memory"
const KEY_TITLE_GENERATION = "titleGeneration"
const KEY_INDEXING = "indexing"
const KEY_SKILL_SOURCES = "skillSources"
const KEY_AGENT_SOURCES = "agentSources"
const KEY_MCP_SOURCES = "mcpSources"
const KEY_BROWSER = "browser"
const KEY_THEME = "theme"
const KEY_IDE = "ide"
const KEY_NOTIFICATIONS = "notifications"

let executionCache: ExecutionSettings | undefined
let permissionsCache: PermissionSettings | undefined
let llmCache: LlmSettings | undefined
let memoryCache: MemorySettings | undefined
let titleGenerationCache: TitleGenerationSettings | undefined
let indexingCache: IndexingSettings | undefined
let skillSourcesCache: SkillSourcesSettings | undefined
let agentSourcesCache: AgentSourcesSettings | undefined
let mcpSourcesCache: McpSourcesSettings | undefined
let browserCache: BrowserSettings | undefined
let themeCache: ThemeSettings | undefined
let ideCache: IdeSettings | undefined
let notificationsCache: NotificationSettings | undefined
// Tracks whether an execution row exists, so getExecutionConfig can fall back to
// the COWORK_ENV_RUNTIME env var until the user writes a backend choice.
let executionPersisted = false

function loadExecution(): ExecutionSettings {
  if (executionCache) return executionCache
  const raw = settingsRepo.getSetting(KEY_EXECUTION)
  executionPersisted = raw != null
  const base = defaultExecution()
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ExecutionSettings>
      executionCache = {
        backend: parsed.backend ?? base.backend,
        image: parsed.image,
        sandbox: {
          autoApprove: parsed.sandbox?.autoApprove ?? base.sandbox.autoApprove,
          prompted: parsed.sandbox?.prompted ?? base.sandbox.prompted,
          categories: {
            ...base.sandbox.categories,
            ...parsed.sandbox?.categories,
          },
        },
      }
      return executionCache
    } catch {
      // Corrupt blob — fall through to defaults rather than crash.
    }
  }
  executionCache = base
  return executionCache
}

function loadPermissions(): PermissionSettings {
  if (permissionsCache) return permissionsCache
  const raw = settingsRepo.getSetting(KEY_PERMISSIONS)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PermissionSettings>
      permissionsCache = {
        file_write: parsed.file_write ?? DEFAULT_PERMISSIONS.file_write,
        file_edit: parsed.file_edit ?? DEFAULT_PERMISSIONS.file_edit,
      }
      return permissionsCache
    } catch {
      // Corrupt blob — fall through to defaults.
    }
  }
  permissionsCache = { ...DEFAULT_PERMISSIONS }
  return permissionsCache
}

function loadLlm(): LlmSettings {
  if (llmCache) return llmCache
  const raw = settingsRepo.getSetting(KEY_LLM)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<LlmSettings>
      llmCache = {
        activeAccountId: parsed.activeAccountId ?? DEFAULT_LLM.activeAccountId,
        activeModelId: parsed.activeModelId ?? DEFAULT_LLM.activeModelId,
      }
      return llmCache
    } catch {
      // Corrupt blob — fall through to defaults.
    }
  }
  llmCache = { ...DEFAULT_LLM }
  return llmCache
}

function loadMemory(): MemorySettings {
  if (memoryCache) return memoryCache
  const raw = settingsRepo.getSetting(KEY_MEMORY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<MemorySettings>
      memoryCache = {
        enabled: parsed.enabled ?? DEFAULT_MEMORY.enabled,
        accountId:
          typeof parsed.accountId === "string" ? parsed.accountId : null,
        modelId: typeof parsed.modelId === "string" ? parsed.modelId : null,
      }
      return memoryCache
    } catch {
      // Corrupt blob — fall through to defaults.
    }
  }
  memoryCache = { ...DEFAULT_MEMORY }
  return memoryCache
}

function loadTitleGeneration(): TitleGenerationSettings {
  if (titleGenerationCache) return titleGenerationCache
  const raw = settingsRepo.getSetting(KEY_TITLE_GENERATION)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<TitleGenerationSettings>
      titleGenerationCache = {
        accountId:
          typeof parsed.accountId === "string" ? parsed.accountId : null,
        modelId: typeof parsed.modelId === "string" ? parsed.modelId : null,
      }
      return titleGenerationCache
    } catch {
      // Corrupt blob — fall through to defaults.
    }
  }
  titleGenerationCache = { ...DEFAULT_TITLE_GENERATION }
  return titleGenerationCache
}

function loadIndexing(): IndexingSettings {
  if (indexingCache) return indexingCache
  const raw = settingsRepo.getSetting(KEY_INDEXING)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<IndexingSettings>
      indexingCache = {
        autoIndexNewWorkspaces:
          parsed.autoIndexNewWorkspaces ??
          DEFAULT_INDEXING.autoIndexNewWorkspaces,
        useIndexForContext:
          parsed.useIndexForContext ?? DEFAULT_INDEXING.useIndexForContext,
        includeEmbeddings:
          parsed.includeEmbeddings ?? DEFAULT_INDEXING.includeEmbeddings,
        summarizeMessageThreshold:
          parsed.summarizeMessageThreshold ??
          DEFAULT_INDEXING.summarizeMessageThreshold,
        summarizeTokenThreshold:
          parsed.summarizeTokenThreshold ??
          DEFAULT_INDEXING.summarizeTokenThreshold,
        logSystemPrompt:
          parsed.logSystemPrompt ?? DEFAULT_INDEXING.logSystemPrompt,
      }
      return indexingCache
    } catch {
      // Corrupt blob — fall through to defaults.
    }
  }
  indexingCache = { ...DEFAULT_INDEXING }
  return indexingCache
}

function loadSkillSources(): SkillSourcesSettings {
  if (skillSourcesCache) return skillSourcesCache
  const raw = settingsRepo.getSetting(KEY_SKILL_SOURCES)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<SkillSourcesSettings>
      skillSourcesCache = {
        folders: Array.isArray(parsed.folders)
          ? parsed.folders.filter((f): f is string => typeof f === "string")
          : DEFAULT_SKILL_SOURCES.folders,
      }
      return skillSourcesCache
    } catch {
      // Corrupt blob — fall through to defaults.
    }
  }
  skillSourcesCache = { folders: [...DEFAULT_SKILL_SOURCES.folders] }
  return skillSourcesCache
}

function loadAgentSources(): AgentSourcesSettings {
  if (agentSourcesCache) return agentSourcesCache
  const raw = settingsRepo.getSetting(KEY_AGENT_SOURCES)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<AgentSourcesSettings>
      agentSourcesCache = {
        folders: Array.isArray(parsed.folders)
          ? parsed.folders.filter((f): f is string => typeof f === "string")
          : DEFAULT_AGENT_SOURCES.folders,
      }
      return agentSourcesCache
    } catch {
      // Corrupt blob — fall through to defaults.
    }
  }
  agentSourcesCache = { folders: [...DEFAULT_AGENT_SOURCES.folders] }
  return agentSourcesCache
}

function loadMcpSources(): McpSourcesSettings {
  if (mcpSourcesCache) return mcpSourcesCache
  const raw = settingsRepo.getSetting(KEY_MCP_SOURCES)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<McpSourcesSettings>
      mcpSourcesCache = {
        folders: Array.isArray(parsed.folders)
          ? parsed.folders.filter((f): f is string => typeof f === "string")
          : DEFAULT_MCP_SOURCES.folders,
      }
      return mcpSourcesCache
    } catch {
      // Corrupt blob — fall through to defaults.
    }
  }
  mcpSourcesCache = { folders: [...DEFAULT_MCP_SOURCES.folders] }
  return mcpSourcesCache
}

function loadBrowser(): BrowserSettings {
  if (browserCache) return browserCache
  const raw = settingsRepo.getSetting(KEY_BROWSER)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<BrowserSettings>
      browserCache = {
        revealOnAgentUse:
          parsed.revealOnAgentUse === "never" ? "never" : "always",
      }
      return browserCache
    } catch {
      // Corrupt blob — fall through to defaults.
    }
  }
  browserCache = { ...DEFAULT_BROWSER }
  return browserCache
}

function loadTheme(): ThemeSettings {
  if (themeCache) return themeCache
  const raw = settingsRepo.getSetting(KEY_THEME)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ThemeSettings>
      themeCache = {
        accent: typeof parsed.accent === "string" ? parsed.accent : null,
        neutral: typeof parsed.neutral === "string" ? parsed.neutral : null,
      }
      return themeCache
    } catch {
      // Corrupt blob — fall through to defaults.
    }
  }
  themeCache = { ...DEFAULT_THEME }
  return themeCache
}

function loadIde(): IdeSettings {
  if (ideCache) return ideCache
  const raw = settingsRepo.getSetting(KEY_IDE)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<IdeSettings>
      ideCache = { ide: typeof parsed.ide === "string" ? parsed.ide : "system" }
      return ideCache
    } catch {
      // Corrupt blob — fall through to defaults.
    }
  }
  ideCache = { ...DEFAULT_IDE }
  return ideCache
}

function loadNotifications(): NotificationSettings {
  if (notificationsCache) return notificationsCache
  const raw = settingsRepo.getSetting(KEY_NOTIFICATIONS)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<NotificationSettings>
      notificationsCache = {
        enabled: parsed.enabled ?? DEFAULT_NOTIFICATIONS.enabled,
        onNeedsInput: parsed.onNeedsInput ?? DEFAULT_NOTIFICATIONS.onNeedsInput,
        onTurnComplete:
          parsed.onTurnComplete ?? DEFAULT_NOTIFICATIONS.onTurnComplete,
        onTurnError: parsed.onTurnError ?? DEFAULT_NOTIFICATIONS.onTurnError,
        onTaskComplete:
          parsed.onTaskComplete ?? DEFAULT_NOTIFICATIONS.onTaskComplete,
      }
      return notificationsCache
    } catch {
      // Corrupt blob — fall through to defaults.
    }
  }
  notificationsCache = { ...DEFAULT_NOTIFICATIONS }
  return notificationsCache
}

// ── Reads ────────────────────────────────────────────────────────────────────

export function getExecution(): ExecutionSettings {
  return loadExecution()
}

// The backend choice mapped to the env factory's EnvConfig. When the user hasn't
// written a choice yet, defer to the env var (COWORK_ENV_RUNTIME) so the dev
// override keeps working until the UI takes over.
export function getExecutionConfig(): EnvConfig {
  const exec = loadExecution()
  if (!executionPersisted) return envConfigFromEnv()
  if (exec.backend === "docker" || exec.backend === "podman") {
    return {
      kind: "container",
      runtime: exec.backend,
      image: exec.image || DEFAULT_CONTAINER_IMAGE,
    }
  }
  return { kind: "local" }
}

export function getPermissions(): PermissionSettings {
  return loadPermissions()
}

export function getLlm(): LlmSettings {
  return loadLlm()
}

export function getMemory(): MemorySettings {
  return loadMemory()
}

export function getTitleGeneration(): TitleGenerationSettings {
  return loadTitleGeneration()
}

export function getIndexing(): IndexingSettings {
  return loadIndexing()
}

export function getSkillSources(): SkillSourcesSettings {
  return loadSkillSources()
}

export function getAgentSources(): AgentSourcesSettings {
  return loadAgentSources()
}

export function getMcpSources(): McpSourcesSettings {
  return loadMcpSources()
}

export function getBrowser(): BrowserSettings {
  return loadBrowser()
}

export function getTheme(): ThemeSettings {
  return loadTheme()
}

export function getIde(): IdeSettings {
  return loadIde()
}

export function getNotifications(): NotificationSettings {
  return loadNotifications()
}

// Whether the sandbox policy auto-approves a given action category. Consulted by
// the PolicyEngine only when the active backend is a container (see policy.ts).
// Unknown/undefined categories are never auto-approved (conservative default).
export function sandboxAutoApproves(category: string | undefined): boolean {
  const exec = loadExecution()
  if (!exec.sandbox.autoApprove) return false
  if (!category) return false
  return exec.sandbox.categories[category as ApprovalCategory] === true
}

// ── Writes (update repo + refresh cache) ─────────────────────────────────────

export function setExecution(next: ExecutionSettings): ExecutionSettings {
  settingsRepo.setSetting(KEY_EXECUTION, JSON.stringify(next))
  executionCache = next
  executionPersisted = true
  return next
}

export function setPermissions(next: PermissionSettings): PermissionSettings {
  settingsRepo.setSetting(KEY_PERMISSIONS, JSON.stringify(next))
  permissionsCache = next
  return next
}

export function setIndexing(next: IndexingSettings): IndexingSettings {
  settingsRepo.setSetting(KEY_INDEXING, JSON.stringify(next))
  indexingCache = next
  return next
}

export function setSkillSources(
  next: SkillSourcesSettings
): SkillSourcesSettings {
  settingsRepo.setSetting(KEY_SKILL_SOURCES, JSON.stringify(next))
  skillSourcesCache = next
  return next
}

export function setAgentSources(
  next: AgentSourcesSettings
): AgentSourcesSettings {
  settingsRepo.setSetting(KEY_AGENT_SOURCES, JSON.stringify(next))
  agentSourcesCache = next
  return next
}

export function setMcpSources(next: McpSourcesSettings): McpSourcesSettings {
  settingsRepo.setSetting(KEY_MCP_SOURCES, JSON.stringify(next))
  mcpSourcesCache = next
  return next
}

export function setBrowser(next: BrowserSettings): BrowserSettings {
  settingsRepo.setSetting(KEY_BROWSER, JSON.stringify(next))
  browserCache = next
  return next
}

export function setTheme(next: ThemeSettings): ThemeSettings {
  settingsRepo.setSetting(KEY_THEME, JSON.stringify(next))
  themeCache = next
  return next
}

export function setIde(next: IdeSettings): IdeSettings {
  settingsRepo.setSetting(KEY_IDE, JSON.stringify(next))
  ideCache = next
  return next
}

export function setNotifications(
  next: NotificationSettings
): NotificationSettings {
  settingsRepo.setSetting(KEY_NOTIFICATIONS, JSON.stringify(next))
  notificationsCache = next
  return next
}

// Invalidation hook fired whenever the active LLM selection changes, so the
// provider routing layer can drop its cached client and the next turn rebuilds
// with the new account/model. Registered by the providers module to avoid a
// circular import (providers → service for reads; service → providers only via
// this opaque callback).
let onLlmChange: (() => void) | undefined
export function setLlmChangeListener(fn: () => void): void {
  onLlmChange = fn
}

export function setLlm(next: LlmSettings): LlmSettings {
  settingsRepo.setSetting(KEY_LLM, JSON.stringify(next))
  llmCache = next
  onLlmChange?.()
  return next
}

export function setMemory(next: MemorySettings): MemorySettings {
  settingsRepo.setSetting(KEY_MEMORY, JSON.stringify(next))
  memoryCache = next
  return next
}

export function setTitleGeneration(
  next: TitleGenerationSettings
): TitleGenerationSettings {
  settingsRepo.setSetting(KEY_TITLE_GENERATION, JSON.stringify(next))
  titleGenerationCache = next
  return next
}

// Test hook: drop the in-memory cache so the next read re-hits the repo.
export function _resetCacheForTests(): void {
  executionCache = undefined
  permissionsCache = undefined
  llmCache = undefined
  memoryCache = undefined
  titleGenerationCache = undefined
  indexingCache = undefined
  skillSourcesCache = undefined
  agentSourcesCache = undefined
  mcpSourcesCache = undefined
  browserCache = undefined
  themeCache = undefined
  ideCache = undefined
  notificationsCache = undefined
  executionPersisted = false
}
