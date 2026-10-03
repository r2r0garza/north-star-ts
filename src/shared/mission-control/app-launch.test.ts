import { describe, expect, it } from "vitest"
import {
  dependenciesOf,
  logReady,
  normalizeAppLaunch,
  placeholderKeys,
  startOrder,
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
