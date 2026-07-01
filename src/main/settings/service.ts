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
  | "code_exec" // bash -c, curl|sh, interpreter -e

export const SANDBOX_CATEGORY_DEFAULTS: Record<ApprovalCategory, boolean> = {
  workspace_mutation: true,
  destructive_fs: false,
  history_rewrite: false,
  system_mutation: false,
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

const DEFAULT_INDEXING: IndexingSettings = {
  autoIndexNewWorkspaces: true,
  useIndexForContext: true,
  includeEmbeddings: false,
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
const KEY_INDEXING = "indexing"

let executionCache: ExecutionSettings | undefined
let permissionsCache: PermissionSettings | undefined
let llmCache: LlmSettings | undefined
let indexingCache: IndexingSettings | undefined
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
          categories: { ...base.sandbox.categories, ...parsed.sandbox?.categories },
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

function loadIndexing(): IndexingSettings {
  if (indexingCache) return indexingCache
  const raw = settingsRepo.getSetting(KEY_INDEXING)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<IndexingSettings>
      indexingCache = {
        autoIndexNewWorkspaces:
          parsed.autoIndexNewWorkspaces ?? DEFAULT_INDEXING.autoIndexNewWorkspaces,
        useIndexForContext: parsed.useIndexForContext ?? DEFAULT_INDEXING.useIndexForContext,
        includeEmbeddings: parsed.includeEmbeddings ?? DEFAULT_INDEXING.includeEmbeddings,
      }
      return indexingCache
    } catch {
      // Corrupt blob — fall through to defaults.
    }
  }
  indexingCache = { ...DEFAULT_INDEXING }
  return indexingCache
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

export function getIndexing(): IndexingSettings {
  return loadIndexing()
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

// Test hook: drop the in-memory cache so the next read re-hits the repo.
export function _resetCacheForTests(): void {
  executionCache = undefined
  permissionsCache = undefined
  llmCache = undefined
  indexingCache = undefined
  executionPersisted = false
}
