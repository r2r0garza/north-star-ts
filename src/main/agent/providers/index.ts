import { Portkey } from "portkey-ai"
import * as providerAccountsRepo from "../../db/repositories/provider-accounts"
import * as modelsRepo from "../../db/repositories/models"
import * as settingsService from "../../settings/service"
import { getApiKey } from "../../settings/secrets"
import type { ProviderAccount } from "../../db/types"

// The LLM routing layer. Resolves a provider account + model — either an explicit
// per-conversation selection or the global default (the settings `llm` blob) —
// decrypts the account's key in-process, and builds (and caches) the client the
// agent talks to. Replaces the old env-keyed singleton in agent/index.ts.
//
// Clients are cached per account id (keyed on the account, not the model — the
// same client serves all of an account's models). The cache is cleared whenever
// the default selection changes (via settingsService.setLlmChangeListener) or an
// account's key/base_url is edited (callers invoke invalidate()).
//
// Portkey and openai_compatible both route through the Portkey SDK — same
// {baseURL, apiKey, model} shape — so a single client builder serves both. The
// remaining providers are reserved (disabled in the UI) until wired here.

// Seed defaults, used only when seeding a brand-new Portkey account so the dev
// setup keeps working. They are NOT a runtime fallback for a configured account.
export const DEFAULT_PORTKEY_BASE_URL = "https://portkeygateway.perficient.com/v1"
export const DEFAULT_MODEL = "@aws-bedrock-use2/us.anthropic.claude-sonnet-4-6"

export class NoActiveProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NoActiveProviderError"
  }
}

// The resolved client + the model id to call it with, returned together so the
// agent doesn't re-read settings separately.
export interface ResolvedClient {
  client: Portkey
  model: string
  accountId: string
}

// A per-conversation (or default) selection. Either field null → fall back to the
// global default for that field.
export interface LlmSelection {
  accountId: string | null
  modelId: string | null
}

// Clients cached per account id. Cleared wholesale on any credential/default
// change — simpler than per-account invalidation and cheap to rebuild.
const clientCache = new Map<string, Portkey>()

// Drop all cached clients so the next resolve rebuilds. Called on any change to
// the default selection or an account's credentials.
export function invalidate(): void {
  clientCache.clear()
}

// Register cache invalidation with the settings service once, at import time, so
// changing the default account/model takes effect on the next turn with no restart.
settingsService.setLlmChangeListener(invalidate)

function buildClient(account: ProviderAccount): Portkey {
  const cached = clientCache.get(account.id)
  if (cached) return cached
  if (account.provider !== "portkey" && account.provider !== "openai_compatible") {
    throw new NoActiveProviderError(
      `Provider "${account.provider}" is not wired yet. Pick a Portkey or OpenAI-compatible account.`
    )
  }
  const apiKey = getApiKey(account.id)
  if (!apiKey) {
    throw new NoActiveProviderError(
      `The provider "${account.displayName}" has no API key set. Add one in Settings.`
    )
  }
  if (!account.baseUrl) {
    throw new NoActiveProviderError(
      `The provider "${account.displayName}" has no base URL set. Add one in Settings.`
    )
  }
  const client = new Portkey({ baseURL: account.baseUrl, apiKey })
  clientCache.set(account.id, client)
  return client
}

// Resolve a client + model for a selection, falling back to the global default
// per field when a field is null. Throws NoActiveProviderError with a user-facing
// message when nothing usable resolves — runChat surfaces it as the turn's error.
// `sel` defaults to "all default" so callers without a conversation (e.g. the
// title generator before a selection exists) get the default.
export function resolveLlm(sel: LlmSelection = { accountId: null, modelId: null }): ResolvedClient {
  const dflt = settingsService.getLlm()
  const accountId = sel.accountId ?? dflt.activeAccountId
  const modelId = sel.modelId ?? dflt.activeModelId

  if (!accountId) {
    throw new NoActiveProviderError(
      "No LLM provider is configured. Open Settings to add a provider and API key."
    )
  }
  const account = providerAccountsRepo.getAccount(accountId)
  if (!account) {
    throw new NoActiveProviderError(
      "The selected LLM provider no longer exists. Pick one in the composer or Settings."
    )
  }
  if (!modelId) {
    throw new NoActiveProviderError(
      "No model is selected. Choose a model in the composer or Settings."
    )
  }
  // The model id must belong to the account's stored list.
  const model = modelsRepo.listModels(account.id).find((m) => m.modelId === modelId)
  if (!model) {
    throw new NoActiveProviderError(
      "The selected model is no longer in the provider's list. Pick another in the composer."
    )
  }

  const client = buildClient(account)
  providerAccountsRepo.touchLastUsed(account.id)
  return { client, model: model.modelId, accountId: account.id }
}

// Whether ANY usable provider+model exists (used to gate Send and drive the
// first-launch prompt). Checks the default selection first, then falls back to
// "any account with a key, a base URL, and at least one model" so a user who has
// configured a provider but not set a default isn't blocked. Never throws.
export function hasActiveProvider(): boolean {
  try {
    const usable = (accountId: string, modelId?: string | null): boolean => {
      const account = providerAccountsRepo.getAccount(accountId)
      if (!account || !account.hasKey || !account.baseUrl) return false
      const models = modelsRepo.listModels(account.id)
      return modelId ? models.some((m) => m.modelId === modelId) : models.length > 0
    }
    const { activeAccountId, activeModelId } = settingsService.getLlm()
    if (activeAccountId && usable(activeAccountId, activeModelId)) return true
    return providerAccountsRepo.listAccounts().some((a) => usable(a.id))
  } catch {
    return false
  }
}

// Build a transient client for an account by id — used by the gateway model
// import, which needs a client before the account is necessarily the active one.
// Throws NoActiveProviderError on missing key/base_url. Not cached.
export function clientForAccount(accountId: string): Portkey {
  const account = providerAccountsRepo.getAccount(accountId)
  if (!account) throw new NoActiveProviderError("Provider account not found.")
  return buildClient(account)
}

// Fetch the model ids the gateway advertises for an account (the OpenAI-style
// /models catalog, exposed by the Portkey SDK as models.list()). Returns a flat
// list of id strings. Throws on a network/auth failure — the caller (IPC handler)
// catches it and reports cleanly, leaving the local list untouched. The app never
// depends on this succeeding: manual/seeded models always remain usable.
export async function fetchGatewayModelIds(accountId: string): Promise<string[]> {
  const client = clientForAccount(accountId)
  const res = (await client.models.list()) as { data?: Array<{ id?: string }> } | undefined
  const data = res?.data ?? []
  return data.map((m) => m?.id).filter((id): id is string => typeof id === "string" && id.length > 0)
}
