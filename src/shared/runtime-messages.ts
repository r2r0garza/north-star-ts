export const COMMAND_COMPLETION_EVENT_PREFIX =
  'Runtime event: background command completion(s).\n\n[context provenance: trust=untrusted_data channel=command source="background_command_completion"]'

export function isCommandCompletionEvent(content: string | null): boolean {
  return content?.startsWith(COMMAND_COMPLETION_EVENT_PREFIX) === true
}
