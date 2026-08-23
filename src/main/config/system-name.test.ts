import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const electronMock = vi.hoisted(() => ({
  appName: "Cowork",
}))

vi.mock("electron", () => ({
  app: {
    getName: () => electronMock.appName,
  },
}))

import {
  systemSlug,
  systemDisplayName,
  dataDirName,
  mainAgentName,
} from "./system-name"

// The env var is read lazily inside each function, so setting/clearing it
// per-test is enough — no module cache to reset.
beforeEach(() => {
  delete process.env.NEXT_system_name
  delete process.env.MAIN_AGENT_NAME
  electronMock.appName = "Cowork"
})
afterEach(() => {
  delete process.env.NEXT_system_name
  delete process.env.MAIN_AGENT_NAME
  electronMock.appName = "Cowork"
})

describe("system-name — defaults", () => {
  it("uses Electron's app name when the var is unset", () => {
    electronMock.appName = "North Star"
    expect(systemSlug()).toBe("north-star")
    expect(systemDisplayName()).toBe("North Star")
    expect(dataDirName()).toBe(".north-star")
  })

  it("falls back to cowork when both the var and Electron app name are unset", () => {
    electronMock.appName = "   "
    expect(systemSlug()).toBe("cowork")
    expect(systemDisplayName()).toBe("Cowork")
    expect(dataDirName()).toBe(".cowork")
  })

  it("defaults the main agent name to North Star when unset", () => {
    expect(mainAgentName()).toBe("North Star")
  })

  it("reads a custom main agent name (unmangled) and trims it", () => {
    process.env.MAIN_AGENT_NAME = "  Acme Agent  "
    expect(mainAgentName()).toBe("Acme Agent")
  })

  it("treats an empty/whitespace main agent name as unset", () => {
    process.env.MAIN_AGENT_NAME = "   "
    expect(mainAgentName()).toBe("North Star")
  })

  it("treats an empty/whitespace var as unset", () => {
    electronMock.appName = "North Star"
    process.env.NEXT_system_name = "   "
    expect(systemSlug()).toBe("north-star")
    expect(systemDisplayName()).toBe("North Star")
  })
})

describe("system-name — custom values", () => {
  it("derives slug, display name, and data dir from the var", () => {
    process.env.NEXT_system_name = "acme"
    expect(systemSlug()).toBe("acme")
    expect(systemDisplayName()).toBe("Acme")
    expect(dataDirName()).toBe(".acme")
  })

  it("slugifies unsafe characters for filesystem/identifier use", () => {
    process.env.NEXT_system_name = "My Co!!Work"
    // Lowercased, non-[a-z0-9-] runs folded to a single dash, edges trimmed.
    expect(systemSlug()).toBe("my-co-work")
    expect(dataDirName()).toBe(".my-co-work")
  })

  it("only capitalizes the first char for display (leaves the rest as typed)", () => {
    process.env.NEXT_system_name = "myApp"
    expect(systemDisplayName()).toBe("MyApp")
  })

  it("title-cases multi-word names while keeping the slug dashed", () => {
    process.env.NEXT_system_name = "acme-company"
    expect(systemSlug()).toBe("acme-company")
    expect(dataDirName()).toBe(".acme-company")
    expect(systemDisplayName()).toBe("Acme Company")
  })

  it("handles underscores and extra whitespace as word separators", () => {
    process.env.NEXT_system_name = "acme_widget  co"
    expect(systemSlug()).toBe("acme-widget-co")
    expect(systemDisplayName()).toBe("Acme Widget Co")
  })

  it("falls back to the default when the value slugs to nothing", () => {
    process.env.NEXT_system_name = "!!!"
    expect(systemSlug()).toBe("cowork")
  })
})
