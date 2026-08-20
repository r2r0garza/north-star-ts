import { createServer, type Server } from "http"
import { AddressInfo } from "net"
import { shell } from "electron"
import { randomUUID } from "crypto"
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import * as secrets from "../../settings/secrets"
import { systemDisplayName } from "../../config/system-name"

// OAuth support for HTTP MCP servers (e.g. Atlassian). The user's sign-in happens
// in their SYSTEM default browser (shell.openExternal) — no dock icon, and their
// existing SSO/passkey sessions apply. A transient loopback HTTP server on
// 127.0.0.1 catches the redirect and hands the authorization code back to the
// pending auth flow.
//
// Persistence: tokens and the dynamic client registration are stored encrypted on
// the mcp_servers row via the secrets layer, so a completed authorization
// survives restarts. The PKCE verifier, CSRF state, and discovery state are only
// needed for the duration of ONE authorize() attempt, so they live in memory on
// the provider instance.

// How long to wait for the user to complete sign-in before giving up.
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

// A running loopback callback server plus the promise that resolves with the
// authorization code once the browser is redirected back.
interface CallbackListener {
  redirectUrl: string
  code: Promise<string>
  close: () => void
}

// Start a one-shot loopback HTTP server that resolves with the `code` query param
// of the first request to /callback, after validating `state`. Serves a small
// "you can close this tab" page and then shuts itself down. Rejects on timeout.
export async function startCallbackListener(
  expectedState: string
): Promise<CallbackListener> {
  let server: Server
  let settle: {
    resolve: (code: string) => void
    reject: (err: Error) => void
  }
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject }
  })

  const timeout = setTimeout(() => {
    settle.reject(new Error("Timed out waiting for OAuth sign-in to complete."))
    try {
      server.close()
    } catch {
      /* already closed */
    }
  }, CALLBACK_TIMEOUT_MS)

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== "/callback") {
      res.writeHead(404).end("Not found")
      return
    }
    const returnedState = url.searchParams.get("state")
    const authCode = url.searchParams.get("code")
    const err = url.searchParams.get("error")
    res.writeHead(200, { "Content-Type": "text/html" })
    if (err) {
      res.end(
        page(`Sign-in failed: ${escapeHtml(err)}. You can close this tab.`)
      )
      settle.reject(new Error(`OAuth error: ${err}`))
    } else if (!authCode) {
      res.end(
        page("No authorization code was returned. You can close this tab.")
      )
      settle.reject(new Error("OAuth callback missing authorization code."))
    } else if (returnedState !== expectedState) {
      // CSRF guard: the state the AS echoed back must match what we generated.
      res.end(page("Sign-in state mismatch. You can close this tab."))
      settle.reject(new Error("OAuth state mismatch (possible CSRF)."))
    } else {
      res.end(
        page(
          `Signed in to ${escapeHtml(systemDisplayName())}. You can close this tab and return to the app.`
        )
      )
      settle.resolve(authCode)
    }
    clearTimeout(timeout)
    // Close after the response flushes so the browser gets the page.
    setImmediate(() => {
      try {
        server.close()
      } catch {
        /* already closed */
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    // Port 0 → the OS assigns a free ephemeral port.
    server.listen(0, "127.0.0.1", resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    redirectUrl: `http://127.0.0.1:${port}/callback`,
    code,
    close: () => {
      clearTimeout(timeout)
      try {
        server.close()
      } catch {
        /* already closed */
      }
    },
  }
}

// The OAuthClientProvider the SDK drives during connect/finishAuth. Tokens and
// client registration are read from / written to the encrypted DB columns; the
// per-attempt PKCE/state/discovery values are held in memory. `redirectUrl` is
// set once the loopback listener is up (its ephemeral port is baked into the
// redirect URIs so the AS redirects back to us).
export class McpOAuthProvider implements OAuthClientProvider {
  private _redirectUrl: string
  private verifier?: string
  private _state?: string
  private discovery?: OAuthDiscoveryState
  // The most recent state we handed the AS, for the callback CSRF check.
  lastState?: string

  constructor(
    private readonly serverName: string,
    private readonly serverDisplayName: string,
    redirectUrl: string
  ) {
    this._redirectUrl = redirectUrl
  }

  // Called once the loopback server is (re)started with a possibly new port.
  setRedirectUrl(url: string): void {
    this._redirectUrl = url
  }

  get redirectUrl(): string {
    return this._redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `${this.serverDisplayName} — ${systemDisplayName()}`,
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }
  }

  state(): string {
    this._state = randomUUID()
    this.lastState = this._state
    return this._state
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const raw = secrets.getMcpOauthClient(this.serverName)
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as OAuthClientInformationMixed
    } catch {
      return undefined
    }
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    secrets.setMcpOauthClient(this.serverName, JSON.stringify(info))
  }

  tokens(): OAuthTokens | undefined {
    const raw = secrets.getMcpOauthTokens(this.serverName)
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as OAuthTokens
    } catch {
      return undefined
    }
  }

  saveTokens(tokens: OAuthTokens): void {
    secrets.setMcpOauthTokens(this.serverName, JSON.stringify(tokens))
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Open the user's real browser. Fire-and-forget; the loopback listener
    // resolves once they finish and are redirected back.
    void shell.openExternal(authorizationUrl.toString())
  }

  saveCodeVerifier(v: string): void {
    this.verifier = v
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("No PKCE code verifier for this flow.")
    return this.verifier
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery
  }
}

function page(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    systemDisplayName()
  )}</title><style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0b0c;color:#e5e5e5}div{max-width:28rem;text-align:center;padding:2rem;line-height:1.5}</style></head><body><div>${escapeHtml(
    message
  )}</div></body></html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
