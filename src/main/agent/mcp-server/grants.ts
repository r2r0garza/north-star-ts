import { randomBytes, timingSafeEqual } from "crypto"
import { cancelConversationQuestions } from "../questions/broker"
import {
  CLI_MCP_TOOLS,
  type CliMcpGrant,
  type CliMcpProvider,
  type CliMcpQuestionSink,
  type CliMcpToolName,
} from "./types"

// Defense in depth behind the runner's own revoke: a grant nobody released
// (crashed runner, wedged child) stops authorizing anything after this. Long
// enough to cover a CLI turn that sits on a human question.
export const GRANT_TTL_MS = 12 * 60 * 60 * 1000

// Tokens are `<id>.<secret>`: the id is a plain map key (so lookup doesn't leak
// timing on the secret) and the secret is compared in constant time.
const ID_BYTES = 12
const SECRET_BYTES = 32

interface StoredGrant extends CliMcpGrant {
  secret: Buffer
}

const grants = new Map<string, StoredGrant>()

export interface MintGrantInput {
  conversationId: string
  workingDirectory: string
  workspace: string | null
  provider: CliMcpProvider
  // Requested tools. Intersected with CLI_MCP_TOOLS, so an unknown name is
  // dropped rather than registered.
  tools: readonly string[]
  question?: CliMcpQuestionSink | null
  ttlMs?: number
  now?: number
}

export interface MintedGrant {
  token: string
  grant: CliMcpGrant
  revoke: () => void
}

export function mintGrant(input: MintGrantInput): MintedGrant {
  const id = randomBytes(ID_BYTES).toString("base64url")
  const secret = randomBytes(SECRET_BYTES)
  const allowed = new Set<CliMcpToolName>(
    CLI_MCP_TOOLS.filter((name) => input.tools.includes(name))
  )
  const stored: StoredGrant = {
    conversationId: input.conversationId,
    workingDirectory: input.workingDirectory,
    workspace: input.workspace,
    provider: input.provider,
    allowedTools: allowed,
    expiresAt: (input.now ?? Date.now()) + (input.ttlMs ?? GRANT_TTL_MS),
    question: input.question ?? null,
    secret,
  }
  grants.set(id, stored)
  return {
    token: `${id}.${secret.toString("base64url")}`,
    grant: stored,
    revoke: () => revokeGrant(id),
  }
}

// Release a grant and cancel anything still waiting on it, so a CLI that is
// blocked on a question can never outlive the turn that authorized it.
function revokeGrant(id: string): void {
  const grant = grants.get(id)
  if (!grant) return
  grants.delete(id)
  if (grant.question) cancelConversationQuestions(grant.conversationId)
}

// Resolve an `Authorization: Bearer <token>` value to its grant. Returns null
// for missing, malformed, unknown, expired, and revoked tokens alike — the
// caller must answer all of them identically.
export function resolveGrant(
  header: string | undefined,
  now = Date.now()
): CliMcpGrant | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return null
  const [id, secret] = match[1].split(".")
  if (!id || !secret) return null
  const stored = grants.get(id)
  if (!stored) return null
  if (stored.expiresAt <= now) {
    revokeGrant(id)
    return null
  }
  let supplied: Buffer
  try {
    supplied = Buffer.from(secret, "base64url")
  } catch {
    return null
  }
  if (supplied.length !== stored.secret.length) return null
  if (!timingSafeEqual(supplied, stored.secret)) return null
  return stored
}

// Clear every grant — app teardown, or the bridge closing.
export function revokeAllGrants(): void {
  for (const id of [...grants.keys()]) revokeGrant(id)
}

// Test seam: grants are process-global runtime state.
export function activeGrantCount(): number {
  return grants.size
}
