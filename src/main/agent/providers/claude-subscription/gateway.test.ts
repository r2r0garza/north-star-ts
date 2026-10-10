import { describe, expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  gatewayEnvironment,
  gatewayRoute,
  gatewayChildEnvironment,
} from "./gateway"
import { guardEnvironment } from "./setup"
import { BedrockCapture } from "./bedrock-stream"

import { bedrockFrame } from "./fixtures/bedrock"

describe("static CLI gateway configuration", () => {
  it("retains the personal environment when there is no gateway", async () => {
    const home = await mkdtemp(join(tmpdir(), "ns-gateway-"))
    try {
      const env = { HOME: home }
      expect(await gatewayEnvironment(env)).toBe(env)
      expect(gatewayRoute(env)).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  it("loads only static gateway env without hooks, auto mode or secret persistence", async () => {
    const home = await mkdtemp(join(tmpdir(), "ns-gateway-"))
    try {
      await mkdir(join(home, ".claude"))
      await writeFile(
        join(home, ".claude/settings.json"),
        JSON.stringify({
          hooks: { SessionStart: "do-not-run" },
          env: {
            ANTHROPIC_BASE_URL: "https://gateway.example/prefix",
            ANTHROPIC_AUTH_TOKEN: "synthetic-token",
            ANTHROPIC_CUSTOM_HEADERS:
              "x-portkey-api-key:synthetic-portkey\nx-portkey-provider: @aws-bedrock-use2",
            ANTHROPIC_MODEL: "us.anthropic.claude-sonnet-4-8",
            CLAUDE_CODE_USE_BEDROCK: "1",
            CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
            CLAUDE_CODE_ENABLE_AUTO_MODE: "1",
          },
        })
      )
      const env = guardEnvironment(await gatewayEnvironment({ HOME: home }))
      expect(gatewayRoute(env)).toEqual({
        upstream: "https://gateway.example/prefix",
        protocol: "bedrock",
      })
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("synthetic-token")
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain("synthetic-portkey")
      expect(env.ANTHROPIC_MODEL).toBe("us.anthropic.claude-sonnet-4-8")
      expect(
        gatewayChildEnvironment(env, "http://127.0.0.1:1/secret")
          .ANTHROPIC_BEDROCK_BASE_URL
      ).toBe("http://127.0.0.1:1/secret")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  it.each([
    "http://gateway.example",
    "https://user:secret@gateway.example",
    "https://gateway.example?token=secret",
    "https://gateway.example#secret",
  ])("rejects unsafe destination %s without echoing it", (url) => {
    expect(() =>
      gatewayRoute({ ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: "secret" })
    ).toThrow("not qualified")
    expect(() =>
      gatewayRoute({ ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: "secret" })
    ).not.toThrow("secret")
  })
  it("rejects missing credentials and signing Bedrock routes", () => {
    expect(() =>
      gatewayRoute({ ANTHROPIC_BASE_URL: "https://gateway.example" })
    ).toThrow()
    expect(() =>
      gatewayRoute({
        ANTHROPIC_BASE_URL: "https://gateway.example",
        ANTHROPIC_AUTH_TOKEN: "secret",
        CLAUDE_CODE_USE_BEDROCK: "1",
      })
    ).toThrow()
  })
})

describe("Bedrock authoritative event stream", () => {
  it("captures fragmented binary frames with checksums", () => {
    const capture = new BedrockCapture()
    const frames = [
      {
        type: "message_start",
        message: {
          id: "msg_fixture",
          role: "assistant",
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "fixture" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ].map(bedrockFrame)
    const wire = Buffer.concat(frames)
    for (let i = 0; i < wire.length; i += 7)
      capture.push(wire.subarray(i, i + 7))
    expect(capture.finish().text).toBe("fixture")
  })
  it("rejects corrupt checksums, excessive frames and truncated completion", () => {
    const frame = bedrockFrame({ type: "message_stop" })
    frame[frame.length - 1] ^= 1
    expect(() => new BedrockCapture().push(frame)).toThrow()
    const oversized = Buffer.alloc(12)
    oversized.writeUInt32BE(2 * 1024 * 1024)
    expect(() => new BedrockCapture().push(oversized)).toThrow()
    const capture = new BedrockCapture()
    capture.push(frame.subarray(0, 5))
    expect(() => capture.finish()).toThrow()
  })
})
