import { beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

import * as features from "../db/repositories/features"
import * as playbooks from "../db/repositories/playbooks"
import * as processes from "../db/repositories/processes"
import type { PlaybookAltitude } from "../db/types"
import {
  DEFAULT_PLAYBOOKS,
  createDefaultPlaybook,
  diffPlaybookWithDefault,
} from "./playbook-defaults"
import {
  SHIPPED_PLAYBOOK_FINGERPRINTS,
  playbookFingerprint,
  templateFingerprint,
  upgradeDefaultPlaybooks,
} from "./playbook-upgrade"
import {
  createLegacyChecksPlaybook,
  LEGACY_PLAYBOOK_NAME,
} from "../test/legacy-playbook"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe("shipped playbook fingerprints", () => {
  it("lists every default as shipped, the current one last (append when you change a default)", () => {
    for (const altitude of Object.keys(DEFAULT_PLAYBOOKS) as PlaybookAltitude[])
      expect(SHIPPED_PLAYBOOK_FINGERPRINTS[altitude].at(-1)).toBe(
        templateFingerprint(altitude)
      )
  })
})

describe.skipIf(!sqliteLoads)("upgrading default playbooks at Start", () => {
  const feature = (key: string) =>
    features.createFeature({
      key,
      name: key,
      intent: "Ship it.",
      definitionOfDone: "Shipped.",
    }).feature

  it("fingerprints a stored default like its template", () => {
    for (const altitude of Object.keys(DEFAULT_PLAYBOOKS) as PlaybookAltitude[])
      expect(playbookFingerprint(createDefaultPlaybook(altitude))).toBe(
        templateFingerprint(altitude)
      )
  })

  it("upgrades an unedited earlier default in place", () => {
    const legacy = createLegacyChecksPlaybook()
    expect(SHIPPED_PLAYBOOK_FINGERPRINTS.user_story).toContain(
      playbookFingerprint(legacy)
    )
    const { upgraded, notices } = upgradeDefaultPlaybooks(feature("a").id)
    expect(upgraded).toEqual([
      `Updated the “${DEFAULT_PLAYBOOKS.user_story.name}” playbook to the current default`,
    ])
    expect(notices).toEqual([])
    expect(diffPlaybookWithDefault(legacy.id).differs).toBe(false)
    // Already current: nothing to say the next time.
    expect(upgradeDefaultPlaybooks(feature("b").id)).toEqual({
      upgraded: [],
      notices: [],
    })
  })

  it("leaves an edited playbook as it is and says so", () => {
    const legacy = createLegacyChecksPlaybook()
    const [spec] = processes
      .listPhases(legacy.hooks[0].processId)
      .sort((a, b) => a.position - b.position)
    processes.updatePhase(spec.id, { name: "Our own spec step" })
    const { upgraded, notices } = upgradeDefaultPlaybooks(feature("a").id)
    expect(upgraded).toEqual([])
    expect(notices).toEqual([
      expect.stringMatching(
        new RegExp(
          `“${LEGACY_PLAYBOOK_NAME}” playbook differs from the current default \\(it was edited\\).*Reset to default`
        )
      ),
    ])
    expect(playbooks.getPlaybook(legacy.id)!.name).toBe(LEGACY_PLAYBOOK_NAME)
  })

  it("doesn't change a playbook under another feature in flight", () => {
    const legacy = createLegacyChecksPlaybook()
    const other = feature("running")
    features.setFeatureStatus(other.id, "active", "test")
    const { upgraded, notices } = upgradeDefaultPlaybooks(feature("a").id)
    expect(upgraded).toEqual([])
    expect(notices).toEqual([
      expect.stringMatching(/another feature is running on it/),
    ])
    expect(diffPlaybookWithDefault(legacy.id).differs).toBe(true)
  })
})
