import { isDeepStrictEqual } from "util"
import type { NativeBlock } from "./history"

export type WireDiagnostic = "tool_result_mismatch" | "unknown_cache_layout"

function plainContent(value: unknown): unknown {
  if (typeof value === "string") return [{ type: "text", text: value }]
  return value
}

function normalized(block: NativeBlock): NativeBlock | undefined {
  if (
    block.type !== "tool_result" ||
    typeof block.tool_use_id !== "string" ||
    !block.tool_use_id ||
    (block.is_error !== undefined && typeof block.is_error !== "boolean")
  )
    return
  return {
    ...block,
    content: plainContent(block.content),
    is_error: block.is_error ?? false,
  }
}

// No annotation layout is qualified yet. Exact matches (plus scalar/plain-list
// equivalence) are the only proof accepted; all other additions are protected.
export function restoreQueriedResults(
  queried: NativeBlock[],
  host: NativeBlock[],
  diagnostic: (code: WireDiagnostic) => void = () => {}
): NativeBlock[] {
  const native = queried.filter((b) => b.type === "tool_result")
  const expected = host.filter((b) => b.type === "tool_result")
  if (!native.length && !expected.length) return queried
  const ids = (blocks: NativeBlock[]) => blocks.map((b) => b.tool_use_id)
  const valid = (blocks: NativeBlock[]) =>
    blocks.every((b) => normalized(b)) &&
    new Set(ids(blocks)).size === blocks.length
  if (
    !valid(native) ||
    !valid(expected) ||
    !isDeepStrictEqual(ids(native), ids(expected)) ||
    native.some(
      (b, i) => !isDeepStrictEqual(normalized(b), normalized(expected[i]))
    ) ||
    !isDeepStrictEqual(
      queried.filter((b) => b.type !== "tool_result"),
      host.filter((b) => b.type !== "tool_result")
    )
  ) {
    diagnostic("tool_result_mismatch")
    return queried
  }
  let index = 0
  return queried.map((b) =>
    b.type === "tool_result" ? structuredClone(expected[index++]) : b
  )
}
