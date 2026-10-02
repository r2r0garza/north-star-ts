import { describe, expect, it } from "vitest"
import {
  activeFacts,
  adoptSkillBullets,
  appendFact,
  applyMerge,
  CATEGORY_ITEM_CAP,
  clusterForIncoming,
  deriveTopics,
  emptyFactStore,
  enforceStoreCaps,
  factSimilarity,
  parseFactStore,
  sharesDistinctiveToken,
  validateMerge,
  type FactStore,
} from "./facts"

const NEVER_FORBIDDEN = () => false

const ROADMAP_OLD = "The roadmap lives in .plan/ROADMAP.md."
const ROADMAP_NEW = "The roadmap moved to docs/ROADMAP.md."
const UNRELATED = "Riley prefers concise status updates."

function storeWith(...texts: string[]): FactStore {
  const store = emptyFactStore()
  for (const text of texts) appendFact(store, { text }, "2026-01-01T00:00:00Z")
  return store
}

describe("fact similarity", () => {
  it("scores a restatement above the merge floor and unrelated facts at zero", () => {
    expect(factSimilarity(ROADMAP_OLD, ROADMAP_NEW)).toBeGreaterThan(0.34)
    expect(factSimilarity(ROADMAP_OLD, UNRELATED)).toBe(0)
  })

  // The cross-scope pair that motivated this work shares one token and scores
  // far below the merge floor, which is why it gets a different filter.
  it("catches the npm/pnpm cross-scope pair that lexical similarity misses", () => {
    const global =
      "Required verification commands are `npm test` and `npm run build`."
    const workspace =
      "This project uses pnpm as its package manager; npm must not be used."
    expect(factSimilarity(global, workspace)).toBeLessThan(0.34)
    expect(sharesDistinctiveToken(global, workspace)).toBe(true)
    expect(sharesDistinctiveToken(global, UNRELATED)).toBe(false)
  })
})

describe("clustering", () => {
  it("offers only the lexical neighbourhood of the incoming facts", () => {
    const store = storeWith(ROADMAP_OLD, UNRELATED)
    const cluster = clusterForIncoming(activeFacts(store), [
      { text: ROADMAP_NEW },
    ])
    expect(cluster).toEqual([0])
  })

  it("returns nothing when no stored fact is close, so no merge call is made", () => {
    const store = storeWith(UNRELATED)
    expect(
      clusterForIncoming(activeFacts(store), [{ text: ROADMAP_NEW }])
    ).toEqual([])
  })
})

describe("merge subsumption accounting", () => {
  const inputs = [ROADMAP_OLD, UNRELATED, ROADMAP_NEW]

  it("accepts a merge that accounts for every input exactly once", () => {
    const result = validateMerge(
      inputs,
      {
        merged: [
          { text: ROADMAP_NEW, subsumes: [1, 3] },
          { text: UNRELATED, subsumes: [2] },
        ],
      },
      NEVER_FORBIDDEN
    )
    expect(result.ok).toBe(true)
  })

  it("rejects a merge that drops an input it cannot account for", () => {
    const result = validateMerge(
      inputs,
      { merged: [{ text: ROADMAP_NEW, subsumes: [1, 3] }] },
      NEVER_FORBIDDEN
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.rejection.reason).toContain(
      "unaccounted"
    )
  })

  it("rejects an input claimed by two survivors", () => {
    const result = validateMerge(
      inputs,
      {
        merged: [
          { text: ROADMAP_NEW, subsumes: [1, 3] },
          { text: ROADMAP_OLD, subsumes: [1] },
          { text: UNRELATED, subsumes: [2] },
        ],
      },
      NEVER_FORBIDDEN
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.rejection.reason).toContain(
      "claimed twice"
    )
  })

  it("rejects a survivor that subsumes nothing", () => {
    const result = validateMerge(
      inputs,
      {
        merged: [
          { text: ROADMAP_NEW, subsumes: [1, 3] },
          { text: UNRELATED, subsumes: [2] },
          { text: "An invented extra fact about deploys.", subsumes: [] },
        ],
      },
      NEVER_FORBIDDEN
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.rejection.reason).toContain(
      "subsumes nothing"
    )
  })

  it("rejects an out-of-range subsumption", () => {
    const result = validateMerge(
      inputs,
      { merged: [{ text: ROADMAP_NEW, subsumes: [1, 2, 3, 9] }] },
      NEVER_FORBIDDEN
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.rejection.reason).toContain(
      "out of range"
    )
  })

  // The shrink guard. Collapse is bounded by how alike the items actually are,
  // not by a tolerance constant: a survivor may only absorb an input it
  // resembles, so a weak model cannot summarize a category away.
  it("rejects collapsing facts that are not restatements of each other", () => {
    const result = validateMerge(
      inputs,
      { merged: [{ text: ROADMAP_NEW, subsumes: [1, 2, 3] }] },
      NEVER_FORBIDDEN
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.rejection.reason).toContain(
      "unrelated to input 2"
    )
  })

  it("rejects survivor text the subsumed inputs do not support", () => {
    const result = validateMerge(
      [ROADMAP_OLD],
      { merged: [{ text: "The user's password is hunter2.", subsumes: [1] }] },
      NEVER_FORBIDDEN
    )
    expect(result.ok).toBe(false)
  })

  it("rejects a survivor whose text is forbidden", () => {
    const result = validateMerge(
      [ROADMAP_OLD],
      { merged: [{ text: ROADMAP_OLD, subsumes: [1] }] },
      (text) => text === ROADMAP_OLD
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.rejection.reason).toContain(
      "forbidden"
    )
  })

  it("rejects an unparseable shape rather than guessing at it", () => {
    expect(validateMerge(inputs, {}, NEVER_FORBIDDEN).ok).toBe(false)
    expect(validateMerge(inputs, { merged: [] }, NEVER_FORBIDDEN).ok).toBe(
      false
    )
    expect(
      validateMerge(inputs, { merged: ["a string"] }, NEVER_FORBIDDEN).ok
    ).toBe(false)
  })
})

describe("applying a merge", () => {
  it("supersedes the predecessor and inherits its history", () => {
    const store = storeWith(ROADMAP_OLD)
    const original = store.facts[0]
    const introduced = applyMerge(
      store,
      [original.id],
      [{ text: ROADMAP_NEW, conversationId: "conv-9" }],
      [{ text: ROADMAP_NEW, subsumes: [1, 2] }],
      "2026-06-01T00:00:00Z"
    )

    expect(introduced).toHaveLength(1)
    expect(activeFacts(store).map((fact) => fact.text)).toEqual([ROADMAP_NEW])
    expect(original.status).toBe("superseded")
    expect(original.supersededBy).toBe(introduced[0].id)
    // The rewrite is the same fact, corrected — not a brand new one, or
    // recency-based eviction would treat a long-standing fact as young.
    expect(introduced[0].firstSeenAt).toBe("2026-01-01T00:00:00Z")
    expect(introduced[0].sources).toContain("conv-9")
  })

  it("confirms an unchanged survivor rather than rewriting it", () => {
    const store = storeWith(ROADMAP_OLD)
    const original = store.facts[0]
    applyMerge(
      store,
      [original.id],
      [{ text: `${ROADMAP_OLD} It is reviewed weekly.` }],
      [{ text: ROADMAP_OLD, subsumes: [1, 2] }],
      "2026-06-01T00:00:00Z"
    )

    expect(store.facts).toHaveLength(1)
    expect(store.facts[0].id).toBe(original.id)
    expect(store.facts[0].confirmations).toBe(2)
    expect(store.facts[0].lastConfirmedAt).toBe("2026-06-01T00:00:00Z")
  })
})

describe("store maintenance", () => {
  it("adopts bullets the store has never seen and leaves known ones alone", () => {
    const store = storeWith(ROADMAP_OLD)
    const adopted = adoptSkillBullets(
      store,
      [ROADMAP_OLD, UNRELATED],
      "2026-06-01T00:00:00Z"
    )
    expect(adopted).toBe(1)
    expect(activeFacts(store)).toHaveLength(2)
  })

  it("does not resurrect a superseded fact still rendered in an older file", () => {
    const store = storeWith(ROADMAP_OLD)
    store.facts[0].status = "superseded"
    expect(
      adoptSkillBullets(store, [ROADMAP_OLD], "2026-06-01T00:00:00Z")
    ).toBe(0)
  })

  it("evicts by least-recently-confirmed, not by insertion order", () => {
    const store = emptyFactStore()
    for (let i = 0; i < CATEGORY_ITEM_CAP + 1; i++) {
      const fact = appendFact(
        store,
        { text: `Deployment note number ${i}.` },
        "2026-01-01T00:00:00Z"
      )
      // The oldest row is the one still being restated; the second is stale.
      if (i === 0) fact.lastConfirmedAt = "2026-09-01T00:00:00Z"
      if (i === 1) fact.lastConfirmedAt = "2020-01-01T00:00:00Z"
    }

    enforceStoreCaps(store)

    const kept = activeFacts(store).map((fact) => fact.text)
    expect(kept).toHaveLength(CATEGORY_ITEM_CAP)
    expect(kept).toContain("Deployment note number 0.")
    expect(kept).not.toContain("Deployment note number 1.")
  })

  it("drops conflicts whose workspace fact is gone", () => {
    const store = storeWith(ROADMAP_OLD)
    store.conflicts.push({
      factId: "missing",
      globalCategory: "preferences",
      globalText: UNRELATED,
      detectedAt: "2026-01-01T00:00:00Z",
    })
    enforceStoreCaps(store)
    expect(store.conflicts).toEqual([])
  })

  it("treats an unreadable sidecar as absent so SKILL.md can be adopted back", () => {
    expect(parseFactStore("{ not json")).toBeUndefined()
    expect(parseFactStore("")).toBeUndefined()
    expect(parseFactStore('{"facts":[]}')).toEqual({
      version: 1,
      facts: [],
      conflicts: [],
    })
  })
})

describe("topic derivation", () => {
  const LESSONS = [
    "Electron IPC handlers must be registered before the window loads.",
    "Electron IPC payloads are structured-cloned, so class instances lose methods.",
    "The python venv lives under .venv and is created by the setup script.",
    "Recreate the python venv after upgrading Homebrew Python.",
    "Vitest mocks for electron are hoisted with vi.hoisted.",
  ]

  it("prefers a recurring bigram to its own words", () => {
    const topics = deriveTopics(activeFacts(storeWith(...LESSONS)), 6)
    expect(topics).toContain("electron ipc")
    expect(topics).toContain("python venv")
    // "ipc" and "venv" only ever appear inside their bigrams.
    expect(topics).not.toContain("ipc")
    expect(topics).not.toContain("venv")
    // "electron" also stands alone once, which is not enough to be a topic.
    expect(topics).not.toContain("electron")
  })

  it("ranks a recurring bigram above its word when the word recurs alone", () => {
    const topics = deriveTopics(
      activeFacts(
        storeWith(
          "Electron IPC handlers live in main.",
          "Electron IPC channels are typed.",
          "Electron IPC payloads are cloned.",
          "Electron builder signs the app.",
          "Electron fuses are flipped at package time."
        )
      ),
      6
    )
    expect(topics.slice(0, 2)).toEqual(["electron ipc", "electron"])
  })

  it("excludes terms that appear in only one fact", () => {
    const topics = deriveTopics(activeFacts(storeWith(...LESSONS)), 6)
    expect(topics).not.toContain("homebrew")
    expect(topics).not.toContain("vitest")
  })

  it("excludes generic words", () => {
    const topics = deriveTopics(
      activeFacts(
        storeWith(
          "The project should always use pnpm.",
          "The project should never use yarn.",
          "Workspace files must use pnpm."
        )
      ),
      6
    )
    expect(topics).toEqual(["pnpm"])
  })

  it("ranks heavily confirmed facts' terms higher", () => {
    const store = storeWith(
      "Docker builds need buildx.",
      "Docker images are pushed to GHCR.",
      "Kafka topics are created by Terraform.",
      "Kafka consumers commit offsets manually."
    )
    store.facts[2].confirmations = 8
    expect(deriveTopics(activeFacts(store), 6)).toEqual(["kafka", "docker"])
  })

  it("is deterministic under input reordering", () => {
    const forward = deriveTopics(activeFacts(storeWith(...LESSONS)), 6)
    const reversed = deriveTopics(
      activeFacts(storeWith(...[...LESSONS].reverse())),
      6
    )
    expect(reversed).toEqual(forward)
  })

  it("respects the limit", () => {
    const facts = activeFacts(
      storeWith(
        "alpha beta gamma delta",
        "alpha beta gamma delta",
        "epsilon zeta eta theta",
        "epsilon zeta eta theta"
      )
    )
    expect(deriveTopics(facts, 2)).toHaveLength(2)
    expect(deriveTopics(facts, 0)).toEqual([])
  })

  it("returns nothing for no facts", () => {
    expect(deriveTopics([], 6)).toEqual([])
  })
})
