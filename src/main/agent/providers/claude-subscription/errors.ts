export class ClaudeSubscriptionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly headers?: Record<string, string>
  ) {
    super(message)
    this.name = "ClaudeSubscriptionError"
  }
}

export function invalid(message: string): never {
  throw new ClaudeSubscriptionError(
    "claude_subscription_invalid_request",
    message,
    400
  )
}

export function protocol(): never {
  throw new ClaudeSubscriptionError(
    "claude_subscription_protocol",
    "Claude subscription transport returned an invalid or incomplete response."
  )
}

export function aborted(): Error {
  const error = new Error("Claude subscription request cancelled.")
  error.name = "AbortError"
  return error
}

export function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function onlyKeys(
  value: Record<string, unknown>,
  allowed: string[]
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    invalid(
      `Unsupported Claude subscription request field: ${Object.keys(value)
        .filter((key) => !allowed.includes(key))
        .map((key) =>
          /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(key)
            ? key
            : "[invalid field name]"
        )
        .slice(0, 8)
        .join(", ")}.`
    )
  }
}
