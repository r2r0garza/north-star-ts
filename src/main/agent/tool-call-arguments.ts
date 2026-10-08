// Gateways may parse historical arguments before forwarding a request. Keep
// malformed model output as data in valid JSON, never as executable arguments.
export function replayToolCallArguments(argumentsText: string): string {
  try {
    JSON.parse(argumentsText)
    return argumentsText
  } catch {
    return JSON.stringify({ _invalid_tool_arguments: argumentsText })
  }
}
