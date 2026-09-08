import { beforeEach, describe, expect, it } from "vitest"
import {
  activeGrantCount,
  mintGrant,
  resolveGrant,
  revokeAllGrants,
} from "./grants"

function mint(overrides: Partial<Parameters<typeof mintGrant>[0]> = {}) {
  return mintGrant({
    conversationId: "conv-1",
    workingDirectory: "/tmp/one",
    workspace: "/tmp/one",
    provider: "claude_code",
    tools: ["ask_user_question"],
    ...overrides,
  })
}

describe("CLI MCP grants", () => {
  beforeEach(() => revokeAllGrants())

  it("resolves a live token to its own conversation and tools", () => {
    const { token } = mint()
    const grant = resolveGrant(`Bearer ${token}`)
    expect(grant?.conversationId).toBe("conv-1")
    expect(grant?.workspace).toBe("/tmp/one")
    expect([...(grant?.allowedTools ?? [])]).toEqual(["ask_user_question"])
  })

  it("drops tool names the server does not implement", () => {
    const { grant } = mint({
      tools: ["ask_user_question", "run_shell", "index_query"],
    })
    expect([...grant.allowedTools]).toEqual(["ask_user_question"])
  })

  it("grants no tools when none are requested", () => {
    const { token } = mint({ tools: [] })
    expect([...(resolveGrant(`Bearer ${token}`)?.allowedTools ?? [])]).toEqual(
      []
    )
  })

  it("rejects missing, malformed, unknown, and tampered tokens alike", () => {
    const { token } = mint()
    const [id, secret] = token.split(".")
    expect(resolveGrant(undefined)).toBeNull()
    expect(resolveGrant("")).toBeNull()
    expect(resolveGrant(token)).toBeNull() // no Bearer scheme
    expect(resolveGrant("Bearer ")).toBeNull()
    expect(resolveGrant("Bearer no-dot-separator")).toBeNull()
    expect(resolveGrant(`Bearer unknown-id.${secret}`)).toBeNull()
    // Right id, wrong secret — the constant-time compare must still fail.
    const flipped = Buffer.from(secret, "base64url")
    flipped[0] ^= 0xff
    expect(
      resolveGrant(`Bearer ${id}.${flipped.toString("base64url")}`)
    ).toBeNull()
    // A truncated secret of the wrong length is rejected before the compare.
    expect(resolveGrant(`Bearer ${id}.${secret.slice(0, 8)}`)).toBeNull()
  })

  it("rejects an expired token and reclaims it", () => {
    const { token } = mint({ ttlMs: 1000 })
    expect(resolveGrant(`Bearer ${token}`, Date.now() + 500)).not.toBeNull()
    expect(resolveGrant(`Bearer ${token}`, Date.now() + 2000)).toBeNull()
    expect(activeGrantCount()).toBe(0)
  })

  it("rejects a revoked token", () => {
    const { token, revoke } = mint()
    revoke()
    expect(resolveGrant(`Bearer ${token}`)).toBeNull()
    expect(() => revoke()).not.toThrow() // idempotent
  })

  it("keeps two simultaneous grants isolated", () => {
    const a = mint({ conversationId: "conv-a", workspace: "/tmp/a" })
    const b = mint({
      conversationId: "conv-b",
      workspace: "/tmp/b",
      provider: "codex_cli",
      tools: [],
    })
    expect(resolveGrant(`Bearer ${a.token}`)?.workspace).toBe("/tmp/a")
    expect(resolveGrant(`Bearer ${b.token}`)?.workspace).toBe("/tmp/b")
    expect([
      ...(resolveGrant(`Bearer ${b.token}`)?.allowedTools ?? []),
    ]).toEqual([])
    a.revoke()
    expect(resolveGrant(`Bearer ${a.token}`)).toBeNull()
    expect(resolveGrant(`Bearer ${b.token}`)).not.toBeNull()
  })

  it("clears every grant when the bridge closes", () => {
    const a = mint()
    const b = mint({ conversationId: "conv-b" })
    revokeAllGrants()
    expect(activeGrantCount()).toBe(0)
    expect(resolveGrant(`Bearer ${a.token}`)).toBeNull()
    expect(resolveGrant(`Bearer ${b.token}`)).toBeNull()
  })
})
