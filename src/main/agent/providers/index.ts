import { Portkey } from "portkey-ai"
import OpenAI from "openai"
import * as providerAccountsRepo from "../../db/repositories/provider-accounts"
import * as modelsRepo from "../../db/repositories/models"
import * as settingsService from "../../settings/service"
import { getApiKey } from "../../settings/secrets"
import type { ApiMode, ProviderAccount } from "../../db/types"

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
// Two SDKs back the wired providers, chosen by provider type:
//   • portkey                     → the Portkey SDK (routes via x-portkey-* headers).
//   • openai, openai_compatible   → the OpenAI SDK (Authorization: Bearer on EVERY
//                                   request — chat AND models — which is what a plain
//                                   OpenAI-compatible gateway like Copilot Bridge
//                                   requires; the Portkey SDK only sent Bearer on the
//                                   models path, so chat 401'd).
// Both expose the same {baseURL, apiKey, model} shape and the same
// chat.completions.create / models.list surface, so a small LlmClient wrapper (below)
// lets the rest of the module stay SDK-agnostic. baseURL is optional for native
// `openai` (the SDK defaults to api.openai.com) and required for openai_compatible.
// The remaining providers are reserved (disabled in the UI) until wired here.

export class NoActiveProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NoActiveProviderError"
  }
}

// A minimal, SDK-agnostic client surface. Both the Portkey and OpenAI SDKs expose
// exactly this shape, so the agent loop and model import can talk to either without
// caring which backs it. `chat.completions.create` keeps the Portkey positional
// signature — create(body, params, opts) — so existing call sites (which pass the
// abort signal via extraArgs) are unchanged; the OpenAI-backed wrapper maps those
// positional args onto the OpenAI SDK's own create(body, opts) shape internally.
export interface LlmClient {
  chat: {
    completions: {
      create: (body: Record<string, unknown>, ...rest: unknown[]) => unknown
    }
  }
  models: {
    list: () => Promise<{ data?: Array<{ id?: string }> } | undefined>
  }
}

// The resolved client + the model id to call it with, returned together so the
// agent doesn't re-read settings separately. `apiMode` rides along so the chat
// path can branch (completions today; /responses reserved) without re-reading the
// account.
export interface ResolvedClient {
  client: LlmClient
  model: string
  accountId: string
  apiMode: ApiMode
}

// A per-conversation (or default) selection. Either field null → fall back to the
// global default for that field.
export interface LlmSelection {
  accountId: string | null
  modelId: string | null
}

// Clients cached per account id. Cleared wholesale on any credential/default
// change — simpler than per-account invalidation and cheap to rebuild.
const clientCache = new Map<string, LlmClient>()

// Drop all cached clients so the next resolve rebuilds. Called on any change to
// the default selection or an account's credentials.
export function invalidate(): void {
  clientCache.clear()
}

// Register cache invalidation with the settings service once, at import time, so
// changing the default account/model takes effect on the next turn with no restart.
settingsService.setLlmChangeListener(invalidate)

// Wrap a Portkey SDK instance as an LlmClient. Portkey's native surface already
// matches — chat.completions.create is positional (body, params, opts) and
// models.list returns the {data:[{id}]} catalog — so this is a straight pass-through.
function wrapPortkey(client: Portkey): LlmClient {
  return {
    chat: {
      completions: {
        create: (body, ...rest) =>
          (client.chat.completions.create as any)(body, ...rest),
      },
    },
    models: {
      list: () =>
        client.models.list() as Promise<
          { data?: Array<{ id?: string }> } | undefined
        >,
    },
  }
}

// Wrap an OpenAI SDK instance as an LlmClient. The OpenAI SDK's create takes
// (body, opts) — no Portkey `params` slot — so we translate the positional call:
// callers pass [params, opts] as extraArgs (params is unused by the OpenAI path),
// and we forward `opts` (which carries the abort signal) as the OpenAI SDK's second
// arg. Unlike Portkey 3.1.0, the OpenAI SDK forwards that signal to fetch, so an
// abort actually tears down an in-flight stream.
function wrapOpenAI(client: OpenAI): LlmClient {
  return {
    chat: {
      completions: {
        create: (body, ...rest) => {
          const opts = rest[1] as Record<string, unknown> | undefined
          return (client.chat.completions.create as any)(body, opts)
        },
      },
    },
    models: {
      list: async () =>
        (await client.models.list()) as unknown as {
          data?: Array<{ id?: string }>
        },
    },
  }
}

function buildClient(account: ProviderAccount): LlmClient {
  const cached = clientCache.get(account.id)
  if (cached) return cached
  if (
    account.provider !== "portkey" &&
    account.provider !== "openai_compatible" &&
    account.provider !== "openai"
  ) {
    throw new NoActiveProviderError(
      `Provider "${account.provider}" is not wired yet. Pick a Portkey, OpenAI, or OpenAI-compatible account.`
    )
  }
  const apiKey = getApiKey(account.id)
  if (!apiKey) {
    throw new NoActiveProviderError(
      `The provider "${account.displayName}" has no API key set. Add one in Settings.`
    )
  }
  // A base URL is required for the two gateway providers; native `openai` may omit
  // it (the SDK defaults to api.openai.com).
  if (!account.baseUrl && account.provider !== "openai") {
    throw new NoActiveProviderError(
      `The provider "${account.displayName}" has no base URL set. Add one in Settings.`
    )
  }

  let client: LlmClient
  if (account.provider === "portkey") {
    client = wrapPortkey(new Portkey({ baseURL: account.baseUrl!, apiKey }))
  } else {
    // openai + openai_compatible: the OpenAI SDK sends Authorization: Bearer on
    // every request. baseURL undefined → native api.openai.com.
    client = wrapOpenAI(
      new OpenAI({ apiKey, baseURL: account.baseUrl ?? undefined })
    )
  }
  clientCache.set(account.id, client)
  return client
}

// Resolve a client + model for a selection, falling back to the global default
// per field when a field is null. Throws NoActiveProviderError with a user-facing
// message when nothing usable resolves — runChat surfaces it as the turn's error.
// `sel` defaults to "all default" so callers without a conversation (e.g. the
// title generator before a selection exists) get the default.
export function resolveLlm(
  sel: LlmSelection = { accountId: null, modelId: null }
): ResolvedClient {
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
  if (!account.enabled) {
    throw new NoActiveProviderError(
      "The selected LLM provider is disabled. Enable it in Settings or pick another provider."
    )
  }
  if (!modelId) {
    throw new NoActiveProviderError(
      "No model is selected. Choose a model in the composer or Settings."
    )
  }
  // The model id must belong to the account's stored list.
  const model = modelsRepo
    .listModels(account.id)
    .find((m) => m.modelId === modelId)
  if (!model) {
    throw new NoActiveProviderError(
      "The selected model is no longer in the provider's list. Pick another in the composer."
    )
  }

  const client = buildClient(account)
  providerAccountsRepo.touchLastUsed(account.id)
  return {
    client,
    model: model.modelId,
    accountId: account.id,
    apiMode: account.apiMode,
  }
}

// A human-readable label for the model a selection would resolve to, WITHOUT
// throwing or building a client — used by the environment context section, which
// runs before resolveLlm and must degrade gracefully. Prefers the stored custom
// `modelName`, falls back to the model id, and returns null when nothing resolves
// (no provider configured, stale selection) so the caller can omit the line.
export function resolveModelLabel(
  sel: LlmSelection = { accountId: null, modelId: null }
): string | null {
  try {
    const dflt = settingsService.getLlm()
    const accountId = sel.accountId ?? dflt.activeAccountId
    const modelId = sel.modelId ?? dflt.activeModelId
    if (!accountId || !modelId) return modelId ?? null
    const model = modelsRepo
      .listModels(accountId)
      .find((m) => m.modelId === modelId)
    return model?.modelName?.trim() || modelId
  } catch {
    return null
  }
}

// Whether ANY usable provider+model exists (used to gate Send and drive the
// first-launch prompt). Checks the default selection first, then falls back to
// "any account with a key, a base URL, and at least one model" so a user who has
// configured a provider but not set a default isn't blocked. Never throws.
export function hasActiveProvider(): boolean {
  try {
    const usable = (accountId: string, modelId?: string | null): boolean => {
      const account = providerAccountsRepo.getAccount(accountId)
      if (!account || !account.enabled || !account.hasKey) return false
      if (!account.baseUrl && account.provider !== "openai") return false
      const models = modelsRepo.listModels(account.id)
      return modelId
        ? models.some((m) => m.modelId === modelId)
        : models.length > 0
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
export function clientForAccount(accountId: string): LlmClient {
  const account = providerAccountsRepo.getAccount(accountId)
  if (!account) throw new NoActiveProviderError("Provider account not found.")
  return buildClient(account)
}

// Fetch the model ids the gateway advertises for an account (the OpenAI-style
// /models catalog, exposed by the Portkey SDK as models.list()). Returns a flat
// list of id strings. Throws on a network/auth failure — the caller (IPC handler)
// catches it and reports cleanly, leaving the local list untouched. The app never
// depends on this succeeding: manual/seeded models always remain usable.
export async function fetchGatewayModelIds(
  accountId: string
): Promise<string[]> {
  const client = clientForAccount(accountId)
  const res = (await client.models.list()) as
    | { data?: Array<{ id?: string }> }
    | undefined
  const data = res?.data ?? []
  return data
    .map((m) => m?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
}

// ── Output-token parameter compatibility ─────────────────────────────────────
// The OpenAI-compatible APIs are split on how to cap output: older models (and
// Bedrock/Claude via the gateway) take `max_tokens`; the GPT-5.x / o-series
// reject it with an `unsupported_parameter` error and require
// `max_completion_tokens`. There's no reliable way to tell from the model id, so
// we probe: build the request with `max_tokens`, and if the gateway rejects it
// for that reason, rebuild with `max_completion_tokens`. The working choice is
// cached per model id so we only ever pay the failed round-trip once.
type TokenParam = "max_tokens" | "max_completion_tokens"
const tokenParamByModel = new Map<string, TokenParam>()

// Whether an error is the gateway's "use max_completion_tokens instead" rejection.
function isMaxTokensUnsupported(err: unknown): boolean {
  const msg =
    err && typeof err === "object"
      ? // Portkey/OpenAI surface it as error.code or in the message string.
        String((err as any).code ?? "") +
        " " +
        String((err as any).message ?? err)
      : String(err)
  return (
    /unsupported_parameter/i.test(msg) &&
    /max_tokens/i.test(msg) &&
    /max_completion_tokens/i.test(msg)
  )
}

// Whether a failed request is a transient infrastructure hiccup (worth a backoff
// retry) rather than a deterministic error that would fail identically next time.
// Read off the raw error here — by the time the agent loop collapses it into a
// string, the structured status/code is gone. Portkey/OpenAI APIErrors carry a
// numeric `.status`; connection-layer failures carry a Node/undici `.code` or an
// SDK error `.name`. Anything we can't positively identify as transient is treated
// as deterministic (no retry).
const TRANSIENT_NETWORK_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
])

// Transient failure MESSAGE patterns. A socket dying mid-stream surfaces from
// undici's fetch as a bare `TypeError` whose `.message` is "terminated" (the real
// code lives on `.cause` — see the cause walk below), with no status/code of its
// own. These few patterns are kept deliberately tight so a deterministic 4xx
// body text can't trip them.
const TRANSIENT_MESSAGE = /\b(terminated|premature close|socket hang up)\b/i

// Classify a SINGLE error object (no cause walk) into a tri-state:
//   "transient"     → a retryable infrastructure hiccup
//   "deterministic" → an authoritative non-retryable signal (a real 4xx status);
//                     stops the cause walk so a stray transient-looking cause
//                     can't override a definite client error
//   "unknown"       → no signal on this link; keep walking the cause chain
function classifyLink(e: {
  status?: unknown
  code?: unknown
  name?: unknown
  message?: unknown
}): "transient" | "deterministic" | "unknown" {
  // HTTP status present → authoritative. 408 (timeout), 429 (rate limit), and 5xx
  // (gateway/server) are transient; any other 4xx is deterministic.
  if (typeof e.status === "number") {
    if (e.status === 408 || e.status === 429) return "transient"
    return e.status >= 500 && e.status <= 599 ? "transient" : "deterministic"
  }

  // No status → connection layer. Match Node/undici codes or the OpenAI SDK's
  // connection error class names.
  const code = typeof e.code === "string" ? e.code : ""
  if (TRANSIENT_NETWORK_CODES.has(code)) return "transient"
  const name = typeof e.name === "string" ? e.name : ""
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError")
    return "transient"

  // The bare "terminated" (etc.) message from a mid-stream socket death that
  // carries no code on this link.
  const message = typeof e.message === "string" ? e.message : ""
  if (TRANSIENT_MESSAGE.test(message)) return "transient"

  return "unknown"
}

// Whether an error is a transient infrastructure hiccup worth a backoff retry.
// Walks the `cause` chain: undici hangs the real socket code (UND_ERR_SOCKET /
// ECONNRESET / …) on the `.cause` of an outer `TypeError("terminated")`, so a
// single-link check would miss it and wrongly mark the turn non-retryable. A link
// with an authoritative deterministic status stops the walk. Bounded depth + a
// visited guard defend against a self-referential cause.
export function isTransientError(err: unknown): boolean {
  let current: unknown = err
  const seen = new Set<unknown>()
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth++
  ) {
    if (seen.has(current)) break
    seen.add(current)
    const verdict = classifyLink(current as Record<string, unknown>)
    if (verdict === "transient") return true
    if (verdict === "deterministic") return false
    current = (current as { cause?: unknown }).cause
  }
  return false
}

// Build the chat-completions params with the correct output-token field for this
// model, honoring a previously-learned choice.
function withTokenParam(
  base: Record<string, unknown>,
  model: string,
  maxOutputTokens: number,
  param: TokenParam
): Record<string, unknown> {
  return { ...base, model, [param]: maxOutputTokens }
}

// Create a chat completion (streaming or not), transparently coping with the
// max_tokens vs max_completion_tokens split. `base` is everything except the
// model + the output-token field. Pass the Portkey `opts`/`signal` through via
// `extraArgs` (used by the streaming call site). On the first call for a model we
// try `max_tokens`; a single retry switches to `max_completion_tokens` and the
// result is cached so later calls skip the probe.
export async function createCompletion(
  client: LlmClient,
  model: string,
  maxOutputTokens: number,
  base: Record<string, unknown>,
  extraArgs: unknown[] = [],
  apiMode: ApiMode = "completions"
): Promise<any> {
  // Seam for a future OpenAI Responses (/responses) adapter. Only "completions"
  // is implemented today; a "responses" account is rejected loudly rather than
  // silently mis-routed, so wiring it later is an additive change here (plus a
  // request/stream/tool-call translation) with no call-site churn.
  if (apiMode === "responses") {
    throw new Error(
      "The OpenAI Responses API (/responses) is not supported yet; use an account with apiMode 'completions'."
    )
  }

  const tryParam = (param: TokenParam) =>
    (client.chat.completions.create as any)(
      withTokenParam(base, model, maxOutputTokens, param),
      ...extraArgs
    )

  const known = tokenParamByModel.get(model)
  if (known) return tryParam(known)

  try {
    const res = await tryParam("max_tokens")
    tokenParamByModel.set(model, "max_tokens")
    return res
  } catch (err) {
    if (!isMaxTokensUnsupported(err)) throw err
    const res = await tryParam("max_completion_tokens")
    tokenParamByModel.set(model, "max_completion_tokens")
    return res
  }
}
