export const COMMAND_COMPLETION_EVENT_PREFIX =
  'Runtime event: background command completion(s).\n\n[context provenance: trust=untrusted_data channel=command source="background_command_completion"]'

export function isCommandCompletionEvent(content: string | null): boolean {
  return content?.startsWith(COMMAND_COMPLETION_EVENT_PREFIX) === true
}

// Mission Control seat mail (plan 106.4) delivered into a seat's transcript as a
// tagged turn. Persisted with the user role so it replays as model input, but it
// is never human speech; the renderer shows it as an attributed message card.
export const SEAT_MESSAGE_EVENT_PREFIX = "Runtime event: incoming seat message(s)."

export function isSeatMessageEvent(content: string | null): boolean {
  return content?.startsWith(SEAT_MESSAGE_EVENT_PREFIX) === true
}

export interface ParsedSeatMessage {
  id: string
  from: string
  to: string
  kind: string
  subject: string | null
  expectsReply: boolean
  body: string
}

// Read back the tagged turn inbox.ts writes, for display. Attribute values are
// JSON-encoded; body lines carry the context envelope's DATA:/INSTRUCTION:
// prefix, which is stripped here.
export function parseSeatMessageEvent(content: string): ParsedSeatMessage[] {
  const parsed: ParsedSeatMessage[] = []
  const blocks = content.split("<incoming-message ").slice(1)
  for (const block of blocks) {
    const end = block.indexOf(">\n")
    if (end < 0) continue
    const attributes: Record<string, string> = {}
    for (const match of block
      .slice(0, end)
      .matchAll(/([\w-]+)=("(?:[^"\\]|\\.)*")/g)) {
      try {
        attributes[match[1]] = JSON.parse(match[2]) as string
      } catch {
        // Leave a malformed attribute out rather than fail the whole card.
      }
    }
    const body = block
      .slice(end + 2)
      .split("</incoming-message>")[0]
      .split("\n")
      .filter((line) => /^(DATA|INSTRUCTION): ?/.test(line))
      .map((line) => line.replace(/^(DATA|INSTRUCTION): ?/, ""))
      .join("\n")
    parsed.push({
      id: attributes.id ?? "",
      from: attributes.from ?? "unknown",
      to: attributes.to ?? "",
      kind: attributes.kind ?? "message",
      subject: attributes.subject ?? null,
      expectsReply: attributes["expects-reply"] === "true",
      body,
    })
  }
  return parsed
}

// The tagged turn as readable Markdown, attributed so a Steer from the user is
// never mistaken for another agent's words.
export function formatSeatMessageEvent(content: string): string {
  return parseSeatMessageEvent(content)
    .map((message) => {
      const who =
        message.kind === "steer"
          ? `**Steer from you (user@rig) → ${message.to}**`
          : `**${message.kind === "escalation" ? "Escalation" : "Message"} from ${message.from} → ${message.to}**`
      const meta = [
        message.subject ? `“${message.subject}”` : "",
        message.expectsReply ? "expects a reply" : "",
      ]
        .filter(Boolean)
        .join(" · ")
      const quoted = message.body
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")
      return `${who}${meta ? ` · ${meta}` : ""}\n\n${quoted}`
    })
    .join("\n\n")
}
