import type { ToolCallRecord } from "../db/types"

// A single streamed tool-call fragment as it arrives on `delta.tool_calls`.
// Only the fields we consume are typed; providers attach others we ignore.
export interface ToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

// Reassembles streamed tool-call fragments into complete tool calls.
//
// Standard OpenAI/Portkey streams stamp a stable numeric `index` on EVERY
// fragment, and put the call `id` only on its FIRST fragment. That works, but
// some OpenAI-compatible bridges (notably GitHub Copilot's) either omit
// `index` entirely, or reuse `index: 0` for every distinct call. Keying purely
// on `index` then collapses all parallel calls into one slot and concatenates
// their argument JSON (e.g. `{"path":"a"}{"path":"b"}`), which fails
// JSON.parse downstream — the model wasn't wrong, our reassembly was.
//
// Resolution, most-reliable signal first:
//   1. Fragment carries an `id` → it's the FIRST fragment of a call. Look it up
//      by id (dedupe if a provider repeats it); otherwise start a new call. If
//      it also has an `index`, remember which call owns that index.
//   2. Fragment has no `id` but has an `index` → it's a continuation; route it
//      to the call that owns that index.
//   3. Fragment has neither → continuation of the most recent call.
// This keeps standard streams byte-for-byte identical while surviving both the
// missing-index and reused-index-0 bridge behaviors.
export function accumulateToolCalls(
  fragments: Iterable<ToolCallDelta>
): ToolCallRecord[] {
  const calls: ToolCallRecord[] = []
  const byId = new Map<string, ToolCallRecord>()
  const ownerByIndex = new Map<number, ToolCallRecord>()

  const apply = (slot: ToolCallRecord, tc: ToolCallDelta) => {
    if (tc.id) slot.id = tc.id
    if (tc.function?.name) slot.name = tc.function.name
    if (tc.function?.arguments) slot.arguments += tc.function.arguments
  }

  const start = (tc: ToolCallDelta): ToolCallRecord => {
    const slot: ToolCallRecord = { id: "", name: "", arguments: "" }
    calls.push(slot)
    apply(slot, tc)
    if (tc.id) byId.set(tc.id, slot)
    if (typeof tc.index === "number") ownerByIndex.set(tc.index, slot)
    return slot
  }

  for (const tc of fragments) {
    if (tc.id) {
      const existing = byId.get(tc.id)
      if (existing) apply(existing, tc)
      else start(tc)
      continue
    }
    if (typeof tc.index === "number") {
      const owner = ownerByIndex.get(tc.index)
      if (owner) apply(owner, tc)
      else start(tc)
      continue
    }
    const current = calls[calls.length - 1]
    if (current) apply(current, tc)
    else start(tc)
  }

  return calls
}
