import { describe, expect, it } from "vitest"
import {
  dependenciesOf,
  envRefs,
  globalSetup,
  logReady,
  normalizeAppLaunch,
  placeholderKeys,
  serviceSetup,
  smokePaths,
  startOrder,
  substituteEnvRefs,
  substitutePorts,
  validateAppLaunch,
  type AppService,
} from "./app-launch"

function service(patch: Partial<AppService> & { key: string }): AppService {
  return {
    label: patch.key,
    command: `run ${patch.key}`,
    cwd: "",
    port: "auto",
    ready: { http: "/" },
    source: "user",
    ...patch,
  }
}

describe("placeholders", () => {
  it("substitutes {port} and {port:<key>}", () => {
    expect(
      substitutePorts(
        "vite --port {port} --api http://localhost:{port:api}",
        5173,
        {
          api: 8000,
        }
      )
    ).toBe("vite --port 5173 --api http://localhost:8000")
    expect(placeholderKeys("a {port} b {port:api} c {port: db }")).toEqual([
      "api",
      "db",
    ])
  })

  it("throws on a key with no port", () => {
    expect(() => substitutePorts("{port:nope}", 1, {})).toThrow(/no port/)
    expect(() => substitutePorts("{port}", null, {})).toThrow(/no port/)
  })

  it("rejects an unknown key when the recipe is saved", () => {
    const result = validateAppLaunch({
      services: [service({ key: "web", command: "serve --api {port:api}" })],
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.errors.join(" ")).toMatch(/\{port:api\}.*no service "api"/)
  })

  it("rejects a placeholder naming a service without a port", () => {
    const result = validateAppLaunch({
      services: [
        service({ key: "worker", port: "none", ready: { log: "started" } }),
        service({ key: "web", env: { WORKER: "{port:worker}" } }),
      ],
    })
    expect(result.ok).toBe(false)
  })
})

describe("ordering", () => {
  const recipe = {
    services: [
      service({ key: "web", dependsOn: ["api"] }),
      service({ key: "api", env: { DB: "localhost:{port:db}" } }),
      service({ key: "db" }),
      service({ key: "docs" }),
    ],
  }

  it("starts a dependency chain in order, placeholders included", () => {
    expect(dependenciesOf(recipe.services[1])).toEqual(["db"])
    expect(startOrder(recipe).map((s) => s.key)).toEqual([
      "db",
      "api",
      "web",
      "docs",
    ])
    expect(startOrder(recipe, ["web"]).map((s) => s.key)).toEqual([
      "db",
      "api",
      "web",
    ])
  })

  it("rejects an unknown service at start", () => {
    expect(() => startOrder(recipe, ["nope"])).toThrow(/No service "nope"/)
  })

  it("rejects a cycle when the recipe is saved", () => {
    const result = validateAppLaunch({
      services: [
        service({ key: "a", dependsOn: ["b"] }),
        service({ key: "b", command: "x --a {port:a}" }),
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/cycle: a → b → a/)
    expect(normalizeAppLaunch(result.recipe)).toEqual({ services: [] })
  })
})

describe("readiness", () => {
  it("matches a log pattern over the output", () => {
    expect(
      logReady(
        "Local:\\s+http",
        "  VITE ready\n  ➜  Local:   http://localhost:5173/"
      )
    ).toBe(true)
    expect(logReady("listening on \\d+", "starting…")).toBe(false)
    expect(logReady("(", "anything")).toBe(false)
  })
})

describe("validateAppLaunch", () => {
  it("normalizes a good recipe", () => {
    const result = validateAppLaunch({
      services: [
        {
          label: "Web app",
          command: "  npm run dev  ",
          cwd: "./web/",
          port: "auto",
          ready: { http: "/health" },
          dependsOn: ["api", "api"],
        },
        {
          key: "api",
          label: "API",
          command: "uvicorn app:app --port {port}",
          port: 8000,
          portEnv: "API_PORT",
          ready: {},
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.recipe.services[0]).toMatchObject({
      key: "web-app",
      command: "npm run dev",
      cwd: "web",
      dependsOn: ["api"],
      source: "user",
    })
    expect(result.recipe.services[1]).toMatchObject({
      port: 8000,
      portEnv: "API_PORT",
      ready: { http: "/" },
    })
  })

  it("refuses bad services and keeps the good ones when read", () => {
    const value = {
      services: [
        service({ key: "web" }),
        service({ key: "web" }),
        { ...service({ key: "out" }), cwd: "../elsewhere" },
        { ...service({ key: "bad-port" }), port: 70000 },
        service({ key: "quiet", port: "none", ready: { http: "/" } }),
        service({ key: "regex", ready: { log: "(" } }),
        service({ key: "Bad Key" }),
      ],
    }
    const result = validateAppLaunch(value)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toHaveLength(6)
    expect(normalizeAppLaunch(value).services.map((s) => s.key)).toEqual([
      "web",
    ])
  })

  it("reads anything else as an empty recipe", () => {
    expect(normalizeAppLaunch(null)).toEqual({ services: [] })
    expect(normalizeAppLaunch({})).toEqual({ services: [] })
    expect(normalizeAppLaunch("x")).toEqual({ services: [] })
  })
})

describe("recipe additions (plan 112.3)", () => {
  it("reads a stored per-service prepare as a setup step scoped to it", () => {
    const recipe = normalizeAppLaunch({
      services: [{ ...service({ key: "web" }), prepare: "node migrate.js" }],
    })
    expect(recipe.services[0]).not.toHaveProperty("prepare")
    expect(recipe.setup).toEqual([
      {
        label: "Prepare web",
        command: "node migrate.js",
        cwd: "",
        service: "web",
      },
    ])
    expect(serviceSetup(recipe, "web")).toHaveLength(1)
    expect(globalSetup(recipe)).toEqual([])
  })

  it("validates setup steps: one line, inside the workspace, ports only when scoped", () => {
    const ok = validateAppLaunch({
      services: [service({ key: "web" }), service({ key: "api" })],
      setup: [
        { label: "Build", command: "npm run build", cwd: "web" },
        {
          label: "Seed",
          command: "node seed.js --api {port:api}",
          cwd: "",
          service: "web",
        },
      ],
    })
    expect(ok.ok).toBe(true)
    expect(ok.recipe.setup?.map((s) => s.label)).toEqual(["Build", "Seed"])
    const bad = validateAppLaunch({
      services: [service({ key: "web" })],
      setup: [
        { command: "a\nb" },
        { command: "x", cwd: "../out" },
        { command: "x", service: "nope" },
        { command: "seed --port {port:web}" },
        { command: "echo {env:TOKEN}", service: "web" },
      ],
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors).toHaveLength(5)
    expect(bad.recipe.setup).toBeUndefined()
  })

  it("validates prerequisites: a label and a TCP or command check", () => {
    const result = validateAppLaunch({
      services: [service({ key: "web" })],
      prerequisites: [
        {
          label: "A Postgres database on port 5432",
          check: { tcp: 5432 },
          hint: "Start Postgres.",
        },
        { key: "redis", label: "Redis", check: { command: "redis-cli ping" } },
        { label: "Nothing to check" },
        {
          label: "Postgres again",
          key: "a-postgres-database-on-port-5432",
          check: { tcp: 1 },
        },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toHaveLength(2)
    expect(result.recipe.prerequisites).toEqual([
      {
        key: "a-postgres-database-on-port-5432",
        label: "A Postgres database on port 5432",
        check: { tcp: 5432 },
        hint: "Start Postgres.",
      },
      {
        key: "redis",
        label: "Redis",
        check: { command: "redis-cli ping" },
        hint: "",
      },
    ])
  })

  it("keeps {env:KEY} references and refuses literal secrets", () => {
    const ok = validateAppLaunch({
      services: [
        service({
          key: "web",
          env: {
            DATABASE_URL: "postgres://app:{env:DB_PASSWORD}@localhost/app",
            API_KEY: "{env:API_KEY}",
            LOG_LEVEL: "debug",
          },
        }),
      ],
    })
    expect(ok.ok).toBe(true)
    for (const [name, value] of [
      ["API_KEY", "sk-live-123"],
      ["GITHUB_TOKEN", "ghp_abc"],
      ["DB_PASSWORD", "hunter2"],
      ["STRIPE_SECRET", "x"],
      ["PRIVATE_KEY_PEM", "-----BEGIN"],
    ]) {
      const result = validateAppLaunch({
        services: [service({ key: "web", env: { [name]: value } })],
      })
      expect(result.ok).toBe(false)
      if (!result.ok)
        expect(result.errors[0]).toMatch(
          new RegExp(`${name} looks like a secret.*\\{env:${name}\\}`)
        )
    }
    const malformed = validateAppLaunch({
      services: [service({ key: "web", env: { X: "{env:not a name}" } })],
    })
    expect(malformed.ok).toBe(false)
  })

  it("resolves {env:KEY} and reports what's missing", () => {
    expect(envRefs("a {env:A} b {env: B }")).toEqual(["A", "B"])
    expect(
      substituteEnvRefs("{env:A}/{env:B}/{env:C}", { A: "1", C: "" })
    ).toEqual({ text: "1//", missing: ["B"] })
  })

  it("defaults smoke to / for a service with a port, none without", () => {
    expect(smokePaths(service({ key: "web" }))).toEqual(["/"])
    expect(smokePaths(service({ key: "web", smoke: ["/", "/items"] }))).toEqual(
      ["/", "/items"]
    )
    expect(smokePaths(service({ key: "web", smoke: [] }))).toEqual([])
    expect(
      smokePaths(service({ key: "worker", port: "none", ready: { log: "up" } }))
    ).toEqual([])
    // Ready by log (a database on a port): maybe not HTTP, so nothing.
    expect(smokePaths(service({ key: "db", ready: { log: "ready" } }))).toEqual(
      []
    )
    const bad = validateAppLaunch({
      services: [
        service({ key: "web", smoke: ["items"] }),
        service({
          key: "worker",
          port: "none",
          ready: { log: "up" },
          smoke: ["/"],
        }),
      ],
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors).toHaveLength(2)
    // The default isn't written into a stored recipe.
    expect(
      validateAppLaunch({ services: [service({ key: "web" })] }).recipe
        .services[0]
    ).not.toHaveProperty("smoke")
  })

  it("keeps the detector source", () => {
    expect(
      normalizeAppLaunch({
        services: [service({ key: "web", source: "detector" })],
      }).services[0].source
    ).toBe("detector")
  })
})
