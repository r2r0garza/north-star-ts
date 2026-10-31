// Per-fact storage for automatic memory.
//
// A category used to be an undifferentiated bullet list, which made three
// things impossible: telling a restatement from a new fact, telling a
// superseded fact from a current one, and tracing where a fact came from. This
// module is the sidecar (`facts.json`) that carries that metadata, plus the
// deterministic machinery that guards the model-driven merge built on top of
// it. SKILL.md is rendered from the store; the store is the source of truth.
//
// Deliberately free of Electron, `fs`, and provider imports so the guards can
// be tested directly — they are the part that must not be wrong.

export type FactStatus = "active" | "superseded"

export interface MemoryFact {
  id: string
  text: string
  firstSeenAt: string
  lastConfirmedAt: string
  // How many separate batches asserted this fact. Restatements raise it instead
  // of adding a row, which is also what makes recency-based eviction fair.
  confirmations: number
  // Conversation ids, most recent first. Bounded: provenance is for tracing a
  // bad fact back to its turn, not an audit log.
  sources: string[]
  status: FactStatus
  supersededBy?: string
  supersededAt?: string
}

// A workspace fact that contradicts a global one. Recorded on the workspace
// side only: the global file is shared by every workspace, so a fact that is
// wrong *here* must not be edited or hidden *there*.
export interface ScopeConflict {
  factId: string
  globalCategory: string
  globalText: string
  detectedAt: string
}

export interface FactStore {
  version: 1
  facts: MemoryFact[]
  conflicts: ScopeConflict[]
}

// A fact as it arrives from a staged batch, with the provenance the staging
// heading carried.
export interface IncomingFact {
  text: string
  conversationId?: string
}

export const FACT_STORE_VERSION = 1

// Active rows per category. Unchanged from the flat-list era: merge reduces the
// pressure on this cap but is not a reason to remove the backstop.
export const CATEGORY_ITEM_CAP = 200
// Superseded rows are kept for audit but must not grow without bound.
export const SUPERSEDED_RETENTION_CAP = 200
export const MAX_FACT_SOURCES = 5

// Two facts are treated as candidates for merging when their token sets overlap
// this much. The same floor gates clustering (what the model is allowed to see
// together) and subsumption (what it is allowed to collapse), so every pair the
// model is offered is a pair the guard will accept — and nothing else is.
export const MERGE_SIMILARITY_FLOOR = 0.34
// Existing rows sent to one merge call. Bounds cost and blast radius: a merge
// re-litigates the neighbourhood of the incoming facts, never all 200 rows.
// Also keeps the response inside the merge output budget — every input has to
// come back, so the cluster size is an output-token cost, not just an input one.
export const MERGE_CLUSTER_CAP = 16
// One survivor may absorb at most this many inputs. With the similarity floor
// above, this is the shrink guard: collapse is bounded by how alike the items
// actually are, not by a tolerance constant.
export const MERGE_MAX_SUBSUMED = 5

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "for",
  "on",
  "at",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "with",
  "as",
  "by",
  "from",
  "into",
  "than",
  "then",
  "when",
  "which",
  "their",
  "they",
  "them",
  "there",
  "here",
  "has",
  "have",
  "had",
  "does",
  "do",
  "did",
  "will",
  "would",
  "can",
  "could",
  "user",
  "users",
])

export function clampMemoryFact(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500)
}

export function factKey(text: string): string {
  return clampMemoryFact(text).toLowerCase()
}

export function factTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
  return new Set(tokens)
}

// Sørensen–Dice over token sets. Cheap, symmetric, and forgiving of the word
// order changes that make a restatement look novel to byte equality.
export function factSimilarity(a: string, b: string): number {
  const left = factTokens(a)
  const right = factTokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  return (2 * shared) / (left.size + right.size)
}

// Cheap pre-filter for the cross-scope check, where Dice is the wrong tool: the
// npm/pnpm contradiction shares exactly one meaningful token and scores far
// below the merge floor, yet is a real conflict. One shared token is a weak
// signal, so it only decides what the model is asked about — never the outcome.
export function sharesDistinctiveToken(a: string, b: string): boolean {
  const left = factTokens(a)
  const right = factTokens(b)
  for (const token of left) {
    if (token.length >= 3 && right.has(token)) return true
  }
  return false
}

export function emptyFactStore(): FactStore {
  return { version: FACT_STORE_VERSION, facts: [], conflicts: [] }
}

function validStatus(value: unknown): value is FactStatus {
  return value === "active" || value === "superseded"
}

function normalizeStoredFact(value: unknown): MemoryFact | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const text =
    typeof record.text === "string" ? clampMemoryFact(record.text) : ""
  if (!text) return undefined
  const id = typeof record.id === "string" && record.id.trim() ? record.id : ""
  if (!id) return undefined
  const now = new Date().toISOString()
  const firstSeenAt =
    typeof record.firstSeenAt === "string" ? record.firstSeenAt : now
  return {
    id,
    text,
    firstSeenAt,
    lastConfirmedAt:
      typeof record.lastConfirmedAt === "string"
        ? record.lastConfirmedAt
        : firstSeenAt,
    confirmations:
      typeof record.confirmations === "number" &&
      Number.isFinite(record.confirmations) &&
      record.confirmations > 0
        ? Math.floor(record.confirmations)
        : 1,
    sources: Array.isArray(record.sources)
      ? record.sources
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, MAX_FACT_SOURCES)
      : [],
    status: validStatus(record.status) ? record.status : "active",
    supersededBy:
      typeof record.supersededBy === "string" ? record.supersededBy : undefined,
    supersededAt:
      typeof record.supersededAt === "string" ? record.supersededAt : undefined,
  }
}

function normalizeConflict(value: unknown): ScopeConflict | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (typeof record.factId !== "string") return undefined
  if (typeof record.globalCategory !== "string") return undefined
  const globalText =
    typeof record.globalText === "string"
      ? clampMemoryFact(record.globalText)
      : ""
  if (!globalText) return undefined
  return {
    factId: record.factId,
    globalCategory: record.globalCategory,
    globalText,
    detectedAt:
      typeof record.detectedAt === "string"
        ? record.detectedAt
        : new Date().toISOString(),
  }
}

// A store we cannot read is treated as absent, not as empty: the caller
// reconciles against SKILL.md afterwards, so the rendered bullets are adopted
// back rather than silently dropped.
export function parseFactStore(raw: string): FactStore | undefined {
  if (!raw.trim()) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined
  }
  const record = parsed as Record<string, unknown>
  const facts = Array.isArray(record.facts)
    ? record.facts
        .map(normalizeStoredFact)
        .filter((fact): fact is MemoryFact => fact !== undefined)
    : []
  const conflicts = Array.isArray(record.conflicts)
    ? record.conflicts
        .map(normalizeConflict)
        .filter((entry): entry is ScopeConflict => entry !== undefined)
    : []
  return { version: FACT_STORE_VERSION, facts, conflicts }
}

export function serializeFactStore(store: FactStore): string {
  return `${JSON.stringify(store, null, 2)}\n`
}

let idSequence = 0

export function newFactId(store: FactStore): string {
  for (;;) {
    const id = `f${Date.now().toString(36)}${(idSequence++).toString(36)}`
    if (!store.facts.some((fact) => fact.id === id)) return id
  }
}

export function activeFacts(store: FactStore): MemoryFact[] {
  return store.facts.filter((fact) => fact.status === "active")
}

// Adopts bullets present in SKILL.md but unknown to the store. Covers the
// migration from the flat-list format (no sidecar at all) and any hand edit
// that slipped past the tool-layer refusal — in both cases the rendered file is
// evidence of a fact, and dropping it on the next write would be a silent loss.
export function adoptSkillBullets(
  store: FactStore,
  bullets: string[],
  now: string
): number {
  const known = new Set(store.facts.map((fact) => factKey(fact.text)))
  let adopted = 0
  for (const bullet of bullets) {
    const text = clampMemoryFact(bullet)
    if (!text) continue
    const key = factKey(text)
    if (known.has(key)) continue
    known.add(key)
    store.facts.push({
      id: newFactId(store),
      text,
      firstSeenAt: now,
      lastConfirmedAt: now,
      confirmations: 1,
      sources: [],
      status: "active",
    })
    adopted++
  }
  return adopted
}

export function confirmFact(
  fact: MemoryFact,
  now: string,
  conversationId?: string
): void {
  fact.lastConfirmedAt = now
  fact.confirmations += 1
  if (conversationId) {
    fact.sources = [
      conversationId,
      ...fact.sources.filter((id) => id !== conversationId),
    ].slice(0, MAX_FACT_SOURCES)
  }
}

export function appendFact(
  store: FactStore,
  incoming: IncomingFact,
  now: string
): MemoryFact {
  const fact: MemoryFact = {
    id: newFactId(store),
    text: clampMemoryFact(incoming.text),
    firstSeenAt: now,
    lastConfirmedAt: now,
    confirmations: 1,
    sources: incoming.conversationId ? [incoming.conversationId] : [],
    status: "active",
  }
  store.facts.push(fact)
  return fact
}

export function supersedeFact(
  fact: MemoryFact,
  survivorId: string,
  now: string
): void {
  fact.status = "superseded"
  fact.supersededBy = survivorId
  fact.supersededAt = now
}

// Existing rows worth showing the merge alongside a set of incoming facts.
// Returns indices into `existing`, most similar first, capped.
export function clusterForIncoming(
  existing: MemoryFact[],
  incoming: IncomingFact[]
): number[] {
  const scored: { index: number; score: number }[] = []
  existing.forEach((fact, index) => {
    let best = 0
    for (const candidate of incoming) {
      const score = factSimilarity(fact.text, candidate.text)
      if (score > best) best = score
    }
    if (best >= MERGE_SIMILARITY_FLOOR) scored.push({ index, score: best })
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, MERGE_CLUSTER_CAP).map((entry) => entry.index)
}

export interface MergeOutputItem {
  text: string
  // 1-based indices into the merge input list.
  subsumes: number[]
}

export interface MergeRejection {
  reason: string
}

export type MergeValidation =
  | { ok: true; items: MergeOutputItem[] }
  | { ok: false; rejection: MergeRejection }

// The whole point of the merge contract: the model returns a merged list *plus*
// what each survivor absorbed, so the result is checkable instead of trusted.
//
// A merge is accepted only when every input index is claimed exactly once (so
// nothing is dropped unaccounted for), no survivor absorbs more than
// MERGE_MAX_SUBSUMED inputs, and every survivor is lexically similar to each
// input it claims (so unrelated facts cannot be collapsed into one another, and
// a survivor cannot be text the model invented). Anything else is a rejection,
// and the caller falls back to the deterministic result.
export function validateMerge(
  inputs: string[],
  parsed: Record<string, unknown>,
  isForbidden: (text: string) => boolean
): MergeValidation {
  const raw = Array.isArray(parsed.merged)
    ? parsed.merged
    : Array.isArray(parsed.items)
      ? parsed.items
      : undefined
  if (!raw) return { ok: false, rejection: { reason: "no merged array" } }
  if (raw.length === 0) return { ok: false, rejection: { reason: "empty" } }
  if (raw.length > inputs.length) {
    return { ok: false, rejection: { reason: "more outputs than inputs" } }
  }

  const claimed = new Set<number>()
  const items: MergeOutputItem[] = []

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, rejection: { reason: "output item not an object" } }
    }
    const record = entry as Record<string, unknown>
    const text =
      typeof record.text === "string" ? clampMemoryFact(record.text) : ""
    if (!text) return { ok: false, rejection: { reason: "output item empty" } }
    if (isForbidden(text)) {
      return { ok: false, rejection: { reason: "output item forbidden" } }
    }
    if (!Array.isArray(record.subsumes)) {
      return { ok: false, rejection: { reason: "output item has no subsumes" } }
    }
    const subsumes: number[] = []
    for (const value of record.subsumes) {
      const n =
        typeof value === "number"
          ? value
          : typeof value === "string" && /^\d+$/.test(value.trim())
            ? Number(value.trim())
            : Number.NaN
      if (!Number.isInteger(n) || n < 1 || n > inputs.length) {
        return { ok: false, rejection: { reason: "subsumes out of range" } }
      }
      if (claimed.has(n)) {
        return { ok: false, rejection: { reason: `input ${n} claimed twice` } }
      }
      claimed.add(n)
      subsumes.push(n)
    }
    if (subsumes.length === 0) {
      return {
        ok: false,
        rejection: { reason: "output item subsumes nothing" },
      }
    }
    if (subsumes.length > MERGE_MAX_SUBSUMED) {
      return {
        ok: false,
        rejection: { reason: "output item absorbs too many" },
      }
    }
    for (const n of subsumes) {
      if (factSimilarity(text, inputs[n - 1]) < MERGE_SIMILARITY_FLOOR) {
        return {
          ok: false,
          rejection: { reason: `output unrelated to input ${n}` },
        }
      }
    }
    items.push({ text, subsumes })
  }

  if (claimed.size !== inputs.length) {
    const missing = inputs.length - claimed.size
    return {
      ok: false,
      rejection: { reason: `${missing} input item(s) unaccounted for` },
    }
  }

  return { ok: true, items }
}

// Applies a validated merge. `clusterIds` are the existing facts offered to the
// merge, in input order; `incoming` are the new facts, numbered after them.
// Returns the rows the merge actually introduced — new facts and rewrites, not
// rows that merely survived unchanged — which is what the cross-scope check
// needs to look at.
export function applyMerge(
  store: FactStore,
  clusterIds: string[],
  incoming: IncomingFact[],
  items: MergeOutputItem[],
  now: string
): MemoryFact[] {
  const byId = new Map(store.facts.map((fact) => [fact.id, fact]))
  const introduced: MemoryFact[] = []

  for (const item of items) {
    const existingClaimed: MemoryFact[] = []
    const incomingClaimed: IncomingFact[] = []
    for (const n of item.subsumes) {
      const index = n - 1
      if (index < clusterIds.length) {
        const fact = byId.get(clusterIds[index])
        if (fact) existingClaimed.push(fact)
      } else {
        incomingClaimed.push(incoming[index - clusterIds.length])
      }
    }

    const conversationId = incomingClaimed.find(
      (entry) => entry.conversationId
    )?.conversationId
    const key = factKey(item.text)
    const survivor = existingClaimed.find((fact) => factKey(fact.text) === key)

    if (survivor) {
      // Unchanged text: the existing row stands and is re-confirmed.
      if (incomingClaimed.length > 0 || existingClaimed.length > 1) {
        confirmFact(survivor, now, conversationId)
      }
      for (const fact of existingClaimed) {
        if (fact !== survivor) supersedeFact(fact, survivor.id, now)
      }
      continue
    }

    // Rewritten text — a fuller phrasing or a corrected fact. It inherits the
    // oldest first-seen date it absorbed, so a rewrite does not make a
    // long-standing fact look new to recency-based eviction.
    const created = appendFact(store, { text: item.text, conversationId }, now)
    introduced.push(created)
    if (existingClaimed.length > 0) {
      created.firstSeenAt = existingClaimed.reduce(
        (oldest, fact) =>
          fact.firstSeenAt < oldest ? fact.firstSeenAt : oldest,
        created.firstSeenAt
      )
      created.confirmations = Math.max(
        created.confirmations,
        ...existingClaimed.map((fact) => fact.confirmations)
      )
      const inherited = existingClaimed.flatMap((fact) => fact.sources)
      created.sources = [...new Set([...created.sources, ...inherited])].slice(
        0,
        MAX_FACT_SOURCES
      )
      for (const fact of existingClaimed) supersedeFact(fact, created.id, now)
    }
  }

  return introduced
}

// Enforces the caps. Active rows evict by least-recently-confirmed rather than
// insertion order: once recency is recorded, a fact restated across months is a
// worse eviction candidate than one mentioned once and never again. Ties keep
// file order, which is what a migrated store has.
export function enforceStoreCaps(store: FactStore): void {
  const active = store.facts.filter((fact) => fact.status === "active")
  if (active.length > CATEGORY_ITEM_CAP) {
    const ordered = active
      .map((fact, index) => ({ fact, index }))
      .sort((a, b) =>
        a.fact.lastConfirmedAt === b.fact.lastConfirmedAt
          ? a.index - b.index
          : a.fact.lastConfirmedAt < b.fact.lastConfirmedAt
            ? -1
            : 1
      )
    const evicted = new Set(
      ordered
        .slice(0, active.length - CATEGORY_ITEM_CAP)
        .map((entry) => entry.fact.id)
    )
    store.facts = store.facts.filter((fact) => !evicted.has(fact.id))
  }

  const superseded = store.facts.filter((fact) => fact.status === "superseded")
  if (superseded.length > SUPERSEDED_RETENTION_CAP) {
    const drop = new Set(
      superseded
        .slice(0, superseded.length - SUPERSEDED_RETENTION_CAP)
        .map((fact) => fact.id)
    )
    store.facts = store.facts.filter((fact) => !drop.has(fact.id))
  }

  const liveIds = new Set(store.facts.map((fact) => fact.id))
  store.conflicts = store.conflicts.filter((conflict) =>
    liveIds.has(conflict.factId)
  )
}
