import type { LlmClient } from "./index"

export const CODEX_SUBSCRIPTION_BASE_URL =
  "https://chatgpt.com/backend-api/codex"

export const CODEX_SUBSCRIPTION_MODELS = [
  { id: "gpt-5.5", name: "GPT-5.5", favorite: true },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", favorite: false },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", favorite: false },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", favorite: false },
] as const

export const DEFAULT_CODEX_SUBSCRIPTION_MODEL = "gpt-5.5"

const CODEX_AUTH_ISSUER = "https://auth.openai.com"
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
const CODEX_SUBSCRIPTION_CLIENT_VERSION = "0.151.0"
const CHATGPT_ACCOUNT_ID_CLAIM =
  "https://api.openai.com/auth.chatgpt_account_id"

type ChatMessage = {
  role?: string
  content?: unknown
  tool_call_id?: unknown
  tool_calls?: Array<{
    id?: unknown
    call_id?: unknown
    type?: unknown
    function?: { name?: unknown; arguments?: unknown }
  }>
}

interface BuildRequestInput {
  model: string
  maxOutputTokens: number
  body: Record<string, unknown>
}

interface CodexSubscriptionSecret {
  access_token?: unknown
  refresh_token?: unknown
  auth_mode?: unknown
  created_at?: unknown
  last_refresh?: unknown
}

interface ResolveAuthInput {
  secret: string
  forceRefresh?: boolean
  refreshSkewSeconds?: number
  nowMs?: number
  fetchImpl?: typeof fetch
  persistSecret?: (secret: string) => void | Promise<void>
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text
          return typeof text === "string" ? text : ""
        }
        return ""
      })
      .join("")
  }
  return content == null ? "" : String(content)
}

function asJsonString(value: unknown): string {
  if (typeof value === "string") return value.trim() || "{}"
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return "{}"
  }
}

function sanitizeFunctionName(name: unknown): string {
  const raw = typeof name === "string" ? name.trim() : ""
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)
  return cleaned || "tool"
}

function callIdFrom(value: unknown, index: number): string {
  const raw = typeof value === "string" ? value.trim() : ""
  return raw || `call_${index}`
}

function responsesTools(
  tools: unknown
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined
  const converted: Array<Record<string, unknown>> = []
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue
    const record = tool as Record<string, any>
    if (record.type !== "function") continue
    const fn = record.function
    if (!fn || typeof fn !== "object" || typeof fn.name !== "string") {
      continue
    }
    converted.push({
      type: "function",
      name: sanitizeFunctionName(fn.name),
      description: typeof fn.description === "string" ? fn.description : "",
      strict: false,
      parameters:
        fn.parameters && typeof fn.parameters === "object"
          ? fn.parameters
          : { type: "object", properties: {} },
    })
  }
  return converted.length > 0 ? converted : undefined
}

export function buildCodexSubscriptionRequest({
  model,
  body,
}: BuildRequestInput): Record<string, unknown> {
  const messages = Array.isArray(body.messages)
    ? (body.messages as ChatMessage[])
    : []
  const instructions =
    messages
      .filter(
        (message) => message.role === "system" || message.role === "developer"
      )
      .map((message) => textFromContent(message.content).trim())
      .filter(Boolean)
      .join("\n\n") || "You are North Star, a careful coding assistant."

  const input: Array<Record<string, unknown>> = []
  let toolIndex = 0
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") continue
    if (message.role === "tool") {
      const callId = callIdFrom(message.tool_call_id, toolIndex++)
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: textFromContent(message.content),
      })
      continue
    }
    if (message.role === "assistant") {
      const text = textFromContent(message.content).trim()
      if (text) input.push({ role: "assistant", content: text })
      for (const call of message.tool_calls ?? []) {
        const callId = callIdFrom(call.call_id ?? call.id, toolIndex++)
        input.push({
          type: "function_call",
          call_id: callId,
          name: sanitizeFunctionName(call.function?.name),
          arguments: asJsonString(call.function?.arguments),
        })
      }
      continue
    }
    if (message.role === "user") {
      input.push({ role: "user", content: textFromContent(message.content) })
    }
  }

  const request: Record<string, unknown> = {
    model: model.trim(),
    instructions,
    input,
    stream: true,
    store: false,
  }
  const tools = responsesTools(body.tools)
  if (tools) request.tools = tools
  return request
}

function outputText(item: any): string {
  if (!Array.isArray(item?.content)) return ""
  return item.content
    .map((part: any) =>
      part?.type === "output_text" || part?.type === "text" ? part.text : ""
    )
    .filter((text: unknown): text is string => typeof text === "string")
    .join("")
}

function parseSseEvents(text: string): any[] {
  const events: any[] = []
  const frames = text.split(/\r?\n\r?\n/)
  for (const frame of frames) {
    const lines = frame.split(/\r?\n/)
    const eventType = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim()
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim()
    if (!data || data === "[DONE]") continue
    try {
      const parsed = JSON.parse(data)
      if (
        eventType &&
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.type !== "string"
      ) {
        parsed.type = eventType
      }
      events.push(parsed)
    } catch {
      // Ignore malformed frames; the terminal/content checks below decide if the
      // stream was usable.
    }
  }
  return events
}

function codexSseToResponse(text: string, model: string): any {
  const events = parseSseEvents(text)
  const output: any[] = []
  const textDeltas: string[] = []
  let terminal: any = null
  for (const event of events) {
    const type = typeof event?.type === "string" ? event.type : ""
    if (type === "error") {
      const message =
        event?.message ?? event?.error?.message ?? "Codex stream failed."
      throw new Error(redactCodexSubscriptionError(String(message)))
    }
    if (type === "response.output_item.done" && event.item) {
      output.push(event.item)
      continue
    }
    if (type.includes("output_text.delta") && typeof event.delta === "string") {
      textDeltas.push(event.delta)
      continue
    }
    if (
      type === "response.completed" ||
      type === "response.incomplete" ||
      type === "response.failed"
    ) {
      terminal = event.response ?? null
    }
  }
  if (output.length === 0 && textDeltas.length > 0) {
    output.push({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: textDeltas.join("") }],
    })
  }
  if (!terminal && output.length === 0) {
    throw new Error("Codex stream did not emit a usable response.")
  }
  return {
    id: terminal?.id,
    model,
    status: terminal?.status ?? "completed",
    usage: terminal?.usage,
    error: terminal?.error,
    incomplete_details: terminal?.incomplete_details,
    output,
  }
}

function parseCodexResponseBody(
  text: string,
  contentType: string,
  model: string
): any {
  if (
    contentType.includes("text/event-stream") ||
    /^(data|event):/m.test(text.trimStart())
  ) {
    return codexSseToResponse(text, model)
  }
  return text ? JSON.parse(text) : {}
}

function responsePreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim()
  const preview = compact.length > 240 ? `${compact.slice(0, 240)}...` : compact
  return redactCodexSubscriptionError(preview || "<empty response>")
}

function codexSubscriptionError(message: string, status?: number): Error {
  const error = new Error(redactCodexSubscriptionError(message)) as Error & {
    status?: number
  }
  if (status !== undefined) error.status = status
  return error
}

function parseCodexResponseBodyOrThrow(input: {
  text: string
  contentType: string
  model: string
  status: number
  ok: boolean
  statusText: string
}): any {
  try {
    return parseCodexResponseBody(input.text, input.contentType, input.model)
  } catch (error) {
    if (input.ok) {
      const message = error instanceof Error ? error.message : String(error)
      throw codexSubscriptionError(
        `Experimental Codex subscription backend returned an invalid response (${input.status}, ${input.contentType || "unknown content type"}): ${message}. Preview: ${responsePreview(input.text)}`,
        input.status
      )
    }
    throw codexSubscriptionError(
      `Experimental Codex subscription backend failed (${input.status}): returned a non-JSON response (${input.contentType || "unknown content type"}). Preview: ${responsePreview(input.text || input.statusText)}. Use Codex CLI or an official OpenAI/OpenAI-compatible provider if this private endpoint changed.`,
      input.status
    )
  }
}

export function codexSubscriptionResponseToChat(response: any): {
  choices: Array<{ message: any; finish_reason: string }>
  usage?: unknown
  _request_id?: unknown
} {
  if (response?.status === "failed" || response?.status === "cancelled") {
    const code = response?.error?.code ? `${response.error.code}: ` : ""
    const message =
      response?.error?.message ?? `Codex backend returned ${response.status}.`
    throw new Error(redactCodexSubscriptionError(`${code}${message}`))
  }

  const output = Array.isArray(response?.output) ? response.output : []
  const content = output
    .filter((item: any) => item?.type === "message")
    .map(outputText)
    .filter(Boolean)
    .join("\n")
  const toolCalls = output
    .filter((item: any) => item?.type === "function_call")
    .map((item: any, index: number) => ({
      id: callIdFrom(item.call_id ?? item.id, index),
      type: "function",
      function: {
        name: sanitizeFunctionName(item.name),
        arguments: asJsonString(item.arguments),
      },
    }))
  const finish_reason = toolCalls.length > 0 ? "tool_calls" : "stop"
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason,
      },
    ],
    usage: response?.usage,
    _request_id: response?._request_id ?? response?.id,
  }
}

async function* chatToSingleChunkStream(chat: {
  choices: Array<{ message: any; finish_reason: string }>
  usage?: unknown
  _request_id?: unknown
}): AsyncIterable<any> {
  const choice = chat.choices[0]
  const message = choice?.message ?? {}
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  if (message.content) {
    yield {
      _request_id: chat._request_id,
      choices: [{ delta: { content: message.content } }],
    }
  }
  if (toolCalls.length > 0) {
    yield {
      _request_id: chat._request_id,
      choices: [
        {
          delta: {
            tool_calls: toolCalls.map((call: any, index: number) => ({
              index,
              id: call.id,
              type: "function",
              function: {
                name: call.function?.name,
                arguments: call.function?.arguments,
              },
            })),
          },
        },
      ],
    }
  }
  yield {
    _request_id: chat._request_id,
    usage: chat.usage,
    choices: [{ delta: {}, finish_reason: choice?.finish_reason ?? "stop" }],
  }
}

export function redactCodexSubscriptionError(message: string): string {
  return message
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(
      /(access_token|refresh_token|id_token|api[_-]?key)=([^\s,;]+)/gi,
      "$1=[redacted]"
    )
    .replace(/cookie=([^\s,;]+)/gi, "cookie=[redacted]")
    .replace(/(sess-[A-Za-z0-9._-]+)/g, "[redacted]")
}

export function codexSubscriptionAccessToken(secret: string): string {
  const trimmed = secret.trim()
  if (!trimmed.startsWith("{")) return trimmed
  try {
    const parsed = JSON.parse(trimmed) as { access_token?: unknown }
    return typeof parsed.access_token === "string"
      ? parsed.access_token.trim()
      : trimmed
  } catch {
    return trimmed
  }
}

function parseCodexSecret(secret: string): CodexSubscriptionSecret | null {
  const trimmed = secret.trim()
  if (!trimmed.startsWith("{")) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === "object"
      ? (parsed as CodexSubscriptionSecret)
      : null
  } catch {
    return null
  }
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1]
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "="
    )
    const claims = JSON.parse(Buffer.from(padded, "base64").toString("utf8"))
    return claims && typeof claims === "object"
      ? (claims as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function jwtExpSeconds(token: string): number | null {
  const exp = jwtClaims(token)?.exp
  return typeof exp === "number" ? exp : null
}

function codexSubscriptionAccountId(token: string): string | null {
  const accountId = jwtClaims(token)?.[CHATGPT_ACCOUNT_ID_CLAIM]
  return typeof accountId === "string" && accountId.trim()
    ? accountId.trim()
    : null
}

function codexAccessTokenIsExpiring(
  token: string,
  nowMs: number,
  skewSeconds: number
): boolean {
  const exp = jwtExpSeconds(token)
  return exp != null && exp * 1000 <= nowMs + Math.max(0, skewSeconds) * 1000
}

function endpointFor(baseUrl: string | null | undefined): string {
  const base = (baseUrl || CODEX_SUBSCRIPTION_BASE_URL).replace(/\/+$/, "")
  return base.endsWith("/responses") ? base : `${base}/responses`
}

function modelsEndpointFor(baseUrl: string | null | undefined): string {
  const base = (baseUrl || CODEX_SUBSCRIPTION_BASE_URL).replace(/\/+$/, "")
  const endpoint = base.endsWith("/models")
    ? base
    : base.endsWith("/responses")
      ? `${base.slice(0, -10)}/models`
      : `${base}/models`
  const url = new URL(endpoint)
  url.searchParams.set("client_version", CODEX_SUBSCRIPTION_CLIENT_VERSION)
  return url.toString()
}

function modelProbeEndpointsFor(baseUrl: string | null | undefined): string[] {
  return [modelsEndpointFor(baseUrl)]
}

function codexUserAgent(): string {
  const os =
    process.platform === "darwin"
      ? "Mac OS"
      : process.platform === "win32"
        ? "Windows"
        : "Linux"
  return `codex_cli_rs/${CODEX_SUBSCRIPTION_CLIENT_VERSION} (${os}; ${process.arch}) unknown`
}

function codexDiscoveryHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
    originator: "codex_cli_rs",
    "openai-beta": "responses=experimental",
    "user-agent": codexUserAgent(),
  }
  const accountId = codexSubscriptionAccountId(accessToken)
  if (accountId) headers["chatgpt-account-id"] = accountId
  return headers
}

function collectFallbackModelIds(value: unknown, ids: Set<string>): void {
  if (!value) return
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed) ids.add(trimmed)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFallbackModelIds(item, ids)
    return
  }
  if (typeof value !== "object") return

  const record = value as Record<string, unknown>
  for (const key of ["id", "model", "slug"]) {
    collectFallbackModelIds(record[key], ids)
  }
}

function parsePriority(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Number.MAX_SAFE_INTEGER
}

function isCodexModelSlug(slug: string): boolean {
  if (!/^gpt-\d+\.\d+(?:$|-[a-z0-9-]+$)/.test(slug)) return false
  const suffix = slug.match(/^gpt-\d+\.\d+-(.+)$/)?.[1] ?? ""
  return !new Set(["wm"]).has(suffix)
}

export function parseCodexSubscriptionModels(json: unknown): string[] {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const models = (json as Record<string, unknown>).models
    if (
      Array.isArray(models) &&
      models.every((model) => model && typeof model === "object")
    ) {
      const seen = new Set<string>()
      return models
        .map((model, index) => ({
          index,
          record: model as Record<string, unknown>,
        }))
        .filter(({ record }) => {
          const slug = typeof record.slug === "string" ? record.slug.trim() : ""
          const visibility =
            typeof record.visibility === "string" ? record.visibility : ""
          const shellType =
            typeof record.shell_type === "string" ? record.shell_type : ""
          return (
            isCodexModelSlug(slug) &&
            visibility === "list" &&
            shellType !== "disabled"
          )
        })
        .sort((a, b) => {
          const priorityDelta =
            parsePriority(a.record.priority) - parsePriority(b.record.priority)
          return priorityDelta || a.index - b.index
        })
        .map(({ record }) => String(record.slug).trim())
        .filter((slug) => {
          if (seen.has(slug)) return false
          seen.add(slug)
          return true
        })
    }
  }

  const ids = new Set<string>()
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const record = json as Record<string, unknown>
    const catalog =
      record.data ?? record.models ?? record.available_models ?? record.items
    collectFallbackModelIds(catalog, ids)
  } else {
    collectFallbackModelIds(json, ids)
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export async function preflightCodexSubscriptionBackend(input: {
  baseUrl?: string | null
  bearerToken: string
  fetchImpl?: typeof fetch
  persistSecret?: (secret: string) => void | Promise<void>
}): Promise<{ ok: boolean; endpoint?: string; error?: string }> {
  const fetchImpl = input.fetchImpl ?? fetch
  const endpoint = endpointFor(input.baseUrl)
  try {
    const auth = await resolveCodexSubscriptionAuth({
      secret: input.bearerToken,
      fetchImpl,
      persistSecret: input.persistSecret,
    })
    const res = await fetchImpl(endpoint, {
      method: "HEAD",
      headers: { authorization: `Bearer ${auth.accessToken}` },
    })
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error:
          "Codex subscription auth was rejected or expired. Refresh credentials or use Codex CLI instead.",
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        error:
          "Codex subscription endpoint was not found. The private backend may have changed; use Codex CLI or an official provider.",
      }
    }
    if (res.status >= 500) {
      return {
        ok: false,
        error:
          "Codex subscription endpoint is currently unavailable. Retry later or use Codex CLI.",
      }
    }
    return { ok: true, endpoint }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: redactCodexSubscriptionError(
        `Could not reach Codex subscription endpoint: ${message}. Check network access or use Codex CLI.`
      ),
    }
  }
}

async function parseJsonResponse(res: Response, label: string): Promise<any> {
  const text = await res.text()
  let json: any = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`${label} returned invalid JSON.`)
  }
  if (!res.ok) {
    throw new Error(`${label} returned status ${res.status}.`)
  }
  return json
}

async function refreshCodexSubscriptionSecret(input: {
  payload: CodexSubscriptionSecret
  fetchImpl: typeof fetch
}): Promise<{ secret: string; accessToken: string }> {
  const refreshToken =
    typeof input.payload.refresh_token === "string"
      ? input.payload.refresh_token.trim()
      : ""
  if (!refreshToken) {
    throw new Error(
      "Codex auth is expired and no refresh token is available. Sign in again."
    )
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
  })
  const res = await input.fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  })
  if (res.status === 429) {
    throw new Error(
      "Codex token refresh is rate-limited. Retry later; signing in again will not bypass this limit."
    )
  }
  const json = await parseJsonResponse(res, "Codex token refresh")
  if (typeof json.access_token !== "string" || !json.access_token.trim()) {
    throw new Error("Codex token refresh response was missing access_token.")
  }
  const nextPayload = {
    ...input.payload,
    access_token: json.access_token.trim(),
    refresh_token:
      typeof json.refresh_token === "string" && json.refresh_token.trim()
        ? json.refresh_token.trim()
        : refreshToken,
    last_refresh: new Date().toISOString(),
  }
  return {
    secret: JSON.stringify(nextPayload),
    accessToken: nextPayload.access_token,
  }
}

export async function resolveCodexSubscriptionAuth(
  input: ResolveAuthInput
): Promise<{
  accessToken: string
  secret: string
  refreshed: boolean
}> {
  const fetchImpl = input.fetchImpl ?? fetch
  const payload = parseCodexSecret(input.secret)
  if (!payload) {
    return {
      accessToken: input.secret.trim(),
      secret: input.secret,
      refreshed: false,
    }
  }
  const accessToken =
    typeof payload.access_token === "string" ? payload.access_token.trim() : ""
  if (!accessToken) {
    throw new Error("Codex auth is missing access_token. Sign in again.")
  }
  const shouldRefresh =
    input.forceRefresh === true ||
    codexAccessTokenIsExpiring(
      accessToken,
      input.nowMs ?? Date.now(),
      input.refreshSkewSeconds ?? 120
    )
  if (!shouldRefresh) {
    return { accessToken, secret: input.secret, refreshed: false }
  }
  const refreshed = await refreshCodexSubscriptionSecret({ payload, fetchImpl })
  await input.persistSecret?.(refreshed.secret)
  return { ...refreshed, refreshed: true }
}

async function probeCodexSubscriptionModelsEndpointUrl(input: {
  endpoint: string
  bearerToken: string
  fetchImpl?: typeof fetch
  persistSecret?: (secret: string) => void | Promise<void>
}): Promise<{
  endpoint: string
  status: number
  ok: boolean
  body: string
}> {
  const fetchImpl = input.fetchImpl ?? fetch
  let auth = await resolveCodexSubscriptionAuth({
    secret: input.bearerToken,
    fetchImpl,
    persistSecret: input.persistSecret,
  })
  const send = (accessToken: string) =>
    fetchImpl(input.endpoint, {
      method: "GET",
      headers: codexDiscoveryHeaders(accessToken),
    })
  let res = await send(auth.accessToken)
  if ((res.status === 401 || res.status === 403) && !auth.refreshed) {
    auth = await resolveCodexSubscriptionAuth({
      secret: auth.secret,
      forceRefresh: true,
      fetchImpl,
      persistSecret: input.persistSecret,
    })
    res = await send(auth.accessToken)
  }
  return {
    endpoint: input.endpoint,
    status: res.status,
    ok: res.ok,
    body: await res.text(),
  }
}

export async function probeCodexSubscriptionModelsEndpoint(input: {
  baseUrl?: string | null
  bearerToken: string
  fetchImpl?: typeof fetch
  persistSecret?: (secret: string) => void | Promise<void>
}): Promise<{
  endpoint: string
  status: number
  ok: boolean
  body: string
}> {
  return probeCodexSubscriptionModelsEndpointUrl({
    ...input,
    endpoint: modelsEndpointFor(input.baseUrl),
  })
}

export async function probeCodexSubscriptionModelEndpointCandidates(input: {
  baseUrl?: string | null
  bearerToken: string
  fetchImpl?: typeof fetch
  persistSecret?: (secret: string) => void | Promise<void>
}): Promise<
  Array<{
    endpoint: string
    status: number
    ok: boolean
    body: string
  }>
> {
  const endpoints = modelProbeEndpointsFor(input.baseUrl)
  const results: Array<{
    endpoint: string
    status: number
    ok: boolean
    body: string
  }> = []
  for (const endpoint of endpoints) {
    const result = await probeCodexSubscriptionModelsEndpointUrl({
      ...input,
      endpoint,
    })
    results.push(result)
  }
  return results
}

export async function requestCodexSubscriptionDeviceCode(input: {
  fetchImpl?: typeof fetch
}): Promise<{
  verificationUri: string
  userCode: string
  deviceAuthId: string
  intervalSeconds: number
}> {
  const fetchImpl = input.fetchImpl ?? fetch
  const res = await fetchImpl(
    `${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/usercode`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
    }
  )
  const json = await parseJsonResponse(res, "Codex device-code request")
  const userCode = typeof json.user_code === "string" ? json.user_code : ""
  const deviceAuthId =
    typeof json.device_auth_id === "string" ? json.device_auth_id : ""
  if (!userCode || !deviceAuthId) {
    throw new Error("Codex device-code response was missing required fields.")
  }
  const interval = Number(json.interval)
  return {
    verificationUri: `${CODEX_AUTH_ISSUER}/codex/device`,
    userCode,
    deviceAuthId,
    intervalSeconds: Number.isFinite(interval) ? Math.max(1, interval) : 5,
  }
}

export async function completeCodexSubscriptionDeviceAuth(input: {
  deviceAuthId: string
  userCode: string
  intervalSeconds: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch
  const sleep = input.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const deadline = Date.now() + 15 * 60_000
  let authorizationCode = ""
  let codeVerifier = ""
  while (Date.now() < deadline) {
    await sleep(Math.max(1, input.intervalSeconds) * 1000)
    const poll = await fetchImpl(
      `${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_auth_id: input.deviceAuthId,
          user_code: input.userCode,
        }),
      }
    )
    if (poll.status === 403 || poll.status === 404) continue
    const json = await parseJsonResponse(poll, "Codex device-code polling")
    authorizationCode =
      typeof json.authorization_code === "string" ? json.authorization_code : ""
    codeVerifier =
      typeof json.code_verifier === "string" ? json.code_verifier : ""
    break
  }
  if (!authorizationCode || !codeVerifier) {
    throw new Error("Codex sign-in timed out or returned incomplete auth data.")
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    redirect_uri: `${CODEX_AUTH_ISSUER}/deviceauth/callback`,
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  })
  const token = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  const json = await parseJsonResponse(token, "Codex token exchange")
  if (typeof json.access_token !== "string" || !json.access_token.trim()) {
    throw new Error("Codex token exchange did not return an access token.")
  }
  return JSON.stringify({
    access_token: json.access_token,
    refresh_token:
      typeof json.refresh_token === "string" ? json.refresh_token : "",
    auth_mode: "chatgpt_device_code",
    created_at: new Date().toISOString(),
  })
}

export function buildCodexSubscriptionClient(input: {
  baseUrl?: string | null
  bearerToken: string
  fetchImpl?: typeof fetch
  persistSecret?: (secret: string) => void | Promise<void>
}): LlmClient {
  const fetchImpl = input.fetchImpl ?? fetch
  const listModels = async () => {
    const probe = await probeCodexSubscriptionModelsEndpoint({
      baseUrl: input.baseUrl,
      bearerToken: input.bearerToken,
      fetchImpl,
      persistSecret: input.persistSecret,
    })
    let json: unknown = {}
    try {
      json = probe.body ? JSON.parse(probe.body) : {}
    } catch {
      throw new Error("Codex models endpoint returned invalid JSON.")
    }
    if (!probe.ok) {
      const detail =
        json && typeof json === "object"
          ? ((json as any).error?.message ?? probe.body)
          : probe.body
      const error = new Error(
        redactCodexSubscriptionError(
          `Codex models endpoint failed (${probe.status}): ${detail}.`
        )
      ) as Error & { status?: number }
      error.status = probe.status
      throw error
    }
    return { data: parseCodexSubscriptionModels(json).map((id) => ({ id })) }
  }
  const create = async (body: Record<string, unknown>, ...rest: unknown[]) => {
    const opts = rest[1] as { signal?: AbortSignal } | undefined
    const model = typeof body.model === "string" ? body.model : ""
    const maxOutputTokens =
      typeof body.max_tokens === "number"
        ? body.max_tokens
        : typeof body.max_completion_tokens === "number"
          ? body.max_completion_tokens
          : typeof body.max_output_tokens === "number"
            ? body.max_output_tokens
            : 8192
    const request = buildCodexSubscriptionRequest({
      model,
      maxOutputTokens,
      body,
    })
    const send = async (accessToken: string) => {
      return fetchImpl(endpointFor(input.baseUrl), {
        method: "POST",
        signal: opts?.signal,
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      })
    }
    try {
      let auth = await resolveCodexSubscriptionAuth({
        secret: input.bearerToken,
        fetchImpl,
        persistSecret: input.persistSecret,
      })
      let res = await send(auth.accessToken)
      if ((res.status === 401 || res.status === 403) && !auth.refreshed) {
        auth = await resolveCodexSubscriptionAuth({
          secret: auth.secret,
          forceRefresh: true,
          fetchImpl,
          persistSecret: input.persistSecret,
        })
        res = await send(auth.accessToken)
      }
      const text = await res.text()
      const contentType = res.headers.get("content-type") ?? ""
      const json = parseCodexResponseBodyOrThrow({
        text,
        contentType,
        model,
        status: res.status,
        ok: res.ok,
        statusText: res.statusText,
      })
      if (!res.ok) {
        const detail = json?.error?.message ?? text ?? res.statusText
        throw codexSubscriptionError(
          `Experimental Codex subscription backend failed (${res.status}): ${detail}. Use Codex CLI or an official OpenAI/OpenAI-compatible provider if this private endpoint changed.`,
          res.status
        )
      }
      const chat = codexSubscriptionResponseToChat(json)
      return body.stream ? chatToSingleChunkStream(chat) : chat
    } catch (error) {
      if (error instanceof Error) {
        error.message = redactCodexSubscriptionError(error.message)
      }
      throw error
    }
  }
  return {
    chat: { completions: { create } },
    models: { list: listModels },
  }
}
