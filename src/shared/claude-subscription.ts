export interface ClaudeSubscriptionPreflight {
  ok: boolean
  installed: boolean | null
  version: string | null
  compatible: boolean | null
  loggedIn: boolean | null
  hint: string
}

export interface ClaudeSubscriptionCatalog {
  source: "discovered" | "fallback" | "retained"
  models: Array<{ id: string }>
  hint: string
}

export interface ClaudeSubscriptionRefresh {
  ok: boolean
  preflight: ClaudeSubscriptionPreflight
  catalog?: ClaudeSubscriptionCatalog
}
