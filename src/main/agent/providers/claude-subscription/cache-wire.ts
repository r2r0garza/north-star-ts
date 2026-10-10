import { isDeepStrictEqual } from "util"
import type { ReplayFrame } from "./history"
import {
  restoreQueriedResults,
  type WireDiagnostic,
} from "./tool-result-restoration"

export const MAX_WIRE_BYTES = 32 * 1024 * 1024

// Native cache relocation is deliberately disabled until a CLI layout has
// byte-level qualification. Never move native identity or system/tool markers.
export function transformCacheWire(
  raw: Buffer,
  frames: ReplayFrame[],
  diagnostic: (code: WireDiagnostic) => void = () => {}
): Buffer {
  try {
    const body = JSON.parse(raw.toString("utf8"))
    const latest = body.messages?.at(-1)
    const host = frames.at(-1)?.message
    if (
      !latest ||
      latest.role !== "user" ||
      !Array.isArray(latest.content) ||
      !host
    ) {
      diagnostic("unknown_cache_layout")
      return raw
    }
    if (
      !latest.content.some((b: any) => b?.type === "tool_result") &&
      !host.content.some((b) => b.type === "tool_result") &&
      !isDeepStrictEqual(latest.content, host.content)
    ) {
      diagnostic("unknown_cache_layout")
      return raw
    }
    const restored = restoreQueriedResults(
      latest.content,
      host.content,
      diagnostic
    )
    if (isDeepStrictEqual(restored, latest.content)) return raw
    latest.content = restored
    return Buffer.from(JSON.stringify(body))
  } catch {
    diagnostic("unknown_cache_layout")
    return raw
  }
}
