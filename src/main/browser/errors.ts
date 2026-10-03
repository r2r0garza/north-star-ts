// Raised when a Mission Control seat tries to reach, or was taken to, an
// origin it may not use (plan 109.04). The browser tools report it as
// `origin_not_allowed`. Kept free of Electron imports so tools can check it.
export class OriginNotAllowedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OriginNotAllowedError"
  }
}
