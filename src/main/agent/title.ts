import { randomUUID } from "crypto"
import * as settingsService from "../settings/service"
import { normalizeClaudeModel, runClaudeCode } from "./cli/claude"
import {
  createCompletion,
  resolveLlm,
  resolveLlmTarget,
  type LlmSelection,
} from "./providers"

const TITLE_OUTPUT_TOKENS = 256
const TITLE_SYSTEM_PROMPT =
  "Create a semantic label for a conversation from its first user message. " +
  "Return exactly one final line in this format: TITLE: <3-6 word title>. " +
  "Name the topic or intent; do not copy a greeting, command, URL, or the " +
  "user's wording verbatim. Never include analysis or a preamble."
const GENERIC_GREETING =
  /^(?:hey|hi|hello|yo|hey there|hi there|hello there|good (?:morning|afternoon|evening))[!.?\s]*$/i
const META_NARRATION =
  /\b(?:we need to|the user(?:'s)?|first message|short title|title generation|summari[sz](?:e|ing)|output only|reply with|produce a title)\b/i
const ACTION_PREFIX =
  /^(?:please\s+)?(?:go to|open|visit|navigate to|check out|look at)\b/i
const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
])
const KNOWN_CASING: Record<string, string> = {
  api: "API",
  deepagents: "DeepAgents",
  langchain: "LangChain",
  sdk: "SDK",
  ui: "UI",
  url: "URL",
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: any) => (typeof part === "string" ? part : (part?.text ?? "")))
    .join("")
}

function displayWords(text: string): string {
  const words = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu)
  if (!words?.length) return ""
  return words
    .map((word, index) => {
      const lower = word.toLowerCase()
      if (KNOWN_CASING[lower]) return KNOWN_CASING[lower]
      if (index > 0 && SMALL_WORDS.has(lower)) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(" ")
}

function titleFromUrl(raw: string): string | null {
  const match = raw.match(/https?:\/\/[^\s)\]>"']+/i)
  if (!match) return null
  try {
    const url = new URL(match[0])
    const host = url.hostname
      .replace(/^www\./, "")
      .split(".")
      .filter((part) => part && part !== "docs")
      .at(0)
    const path = url.pathname
      .split("/")
      .map((part) => decodeURIComponent(part))
      .filter(
        (part) => part && !/^(?:docs?|oss|python|en|latest|v\d+)$/i.test(part)
      )
      .slice(-2)
    const pieces = [host, ...path].filter((part): part is string => !!part)
    const title = displayWords(pieces.join(" "))
    return title || null
  } catch {
    return null
  }
}

// A deterministic, bounded fallback is important because title generation is a
// cosmetic background call: a provider error or malformed response must never
// leave model reasoning, a full prompt, or a raw URL in the sidebar.
export function fallbackConversationTitle(message: string): string {
  const normalized = message.trim().replace(/\s+/g, " ")
  if (GENERIC_GREETING.test(normalized)) return "Casual Greeting"

  const urlTitle = titleFromUrl(normalized)
  if (urlTitle) return urlTitle.split(/\s+/).slice(0, 6).join(" ")

  const withoutMarkdown = normalized
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(ACTION_PREFIX, "")
    .trim()
  const title = displayWords(withoutMarkdown).split(/\s+/).slice(0, 6).join(" ")
  return title || "New Conversation"
}

function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

// Accept only title-shaped output. If a model emits visible reasoning before a
// `TITLE:` marker, use the marked final line; without that marker, long/meta
// output is rejected instead of being persisted verbatim.
export function parseGeneratedTitle(
  raw: unknown,
  message: string
): string | null {
  const text = contentToText(raw)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim()
  if (!text) return null

  const markers = [...text.matchAll(/\bTITLE\s*:\s*/gi)]
  const marked = markers.at(-1)
  const source = marked ? text.slice(marked.index! + marked[0].length) : text
  const candidate = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^[\s*_'"`]+|[\s*_'"`.!?;:,`]+$/g, "")
    .trim()

  if (!candidate || /https?:\/\//i.test(candidate)) return null
  const words = candidate.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu) ?? []
  if (words.length < 2 || words.length > 7 || candidate.length > 80) return null
  if (META_NARRATION.test(candidate) || ACTION_PREFIX.test(candidate))
    return null
  if (
    GENERIC_GREETING.test(message.trim()) &&
    comparable(candidate) === comparable(message)
  ) {
    return null
  }
  if (!marked && (text.includes("\n") || META_NARRATION.test(text))) return null
  return candidate
}

function reasoningEffortUnsupported(error: unknown): boolean {
  const text =
    error && typeof error === "object"
      ? `${String((error as any).code ?? "")} ${String(
          (error as any).message ?? error
        )}`
      : String(error)
  return (
    /reasoning_effort/i.test(text) &&
    /unsupported|not supported|unknown|unrecognized|invalid/i.test(text)
  )
}

function requestBody(message: string, includeReasoningEffort: boolean) {
  return {
    messages: [
      {
        role: "system",
        content: TITLE_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: `First message:\n"""\n${message}\n"""`,
      },
    ],
    ...(includeReasoningEffort ? { reasoning_effort: "low" } : {}),
  }
}

export async function generateTitle(
  message: string,
  sel: LlmSelection = settingsService.getTitleGeneration()
): Promise<string> {
  const fallback = fallbackConversationTitle(message)
  try {
    const target = resolveLlmTarget(sel)
    if (target.account.provider === "claude_code") {
      const result = await runClaudeCode({
        cwd: process.cwd(),
        message: `First message:\n\"\"\"\n${message}\n\"\"\"`,
        sessionId: randomUUID(),
        resume: false,
        model: normalizeClaudeModel(target.model),
        signal: new AbortController().signal,
        onEvent: () => {},
        isolated: true,
        systemPrompt: TITLE_SYSTEM_PROMPT,
      })
      if (result.error) throw new Error(result.error)
      return parseGeneratedTitle(result.content, message) ?? fallback
    }

    const { client, model, apiMode } = resolveLlm(sel)
    let response: any
    try {
      response = await createCompletion(
        client,
        model,
        TITLE_OUTPUT_TOKENS,
        requestBody(message, true),
        [],
        apiMode
      )
    } catch (error) {
      if (!reasoningEffortUnsupported(error)) throw error
      response = await createCompletion(
        client,
        model,
        TITLE_OUTPUT_TOKENS,
        requestBody(message, false),
        [],
        apiMode
      )
    }
    return (
      parseGeneratedTitle(response?.choices?.[0]?.message?.content, message) ??
      fallback
    )
  } catch (error) {
    console.error("Title generation failed:", error)
    return fallback
  }
}
