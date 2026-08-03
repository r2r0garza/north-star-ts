import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { systemSlug, systemDisplayName, dataDirName } from "./system-name"

// The env var is read lazily inside each function, so setting/clearing it
// per-test is enough — no module cache to reset.
beforeEach(() => {
  delete process.env.NEXT_system_name
})
afterEach(() => {
  delete process.env.NEXT_system_name
})

describe("system-name — defaults", () => {
  it("defaults to cowork when the var is unset", () => {
    expect(systemSlug()).toBe("cowork")
    expect(systemDisplayName()).toBe("Cowork")
    expect(dataDirName()).toBe(".cowork")
  })

  it("treats an empty/whitespace var as unset", () => {
    process.env.NEXT_system_name = "   "
    expect(systemSlug()).toBe("cowork")
    expect(systemDisplayName()).toBe("Cowork")
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
