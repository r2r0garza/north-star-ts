import { describe, it, expect } from "vitest"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { modelRecipe } from "./recipe-model"
import type { ProjectRoot } from "./inventory"

// The recipe model is stack-agnostic: these workspaces span ecosystems on
// purpose, and the stubbed model answers the way a model would for each. The
// main process only checks what holds for any stack.

const workspace = mkdtempSync(path.join(tmpdir(), "recipe-model-"))

function run(input: {
  files: Record<string, string>
  answer: unknown
  intent?: string
  roots?: ProjectRoot[]
}) {
  const prompts: string[] = []
  const result = modelRecipe({
    workspace,
    files: Object.keys(input.files),
    roots: input.roots ?? [],
    intent: input.intent ?? "Build the app.",
    setupSteps: [],
    hint: [],
    read: async (file) => input.files[file] ?? null,
    complete: async (_system, user) => {
      prompts.push(user)
      return typeof input.answer === "string" ? input.answer : JSON.stringify(input.answer)
    },
    signal: new AbortController().signal,
  })
  return { result, prompts }
}

type Service = { command: string } & Record<string, unknown>
interface StackCase {
  stack: string
  files: Record<string, string>
  services: Service[]
}

const service = (fields: Service): Service => ({
  label: "App",
  cwd: "",
  port: "auto",
  ready: { http: "/" },
  ...fields,
})

describe("modelRecipe", () => {
  it.each<StackCase>([
    {
      stack: "Python API + Node frontend",
      files: {
        "api/pyproject.toml": "[project]\nname='api'\ndependencies=['fastapi','uvicorn']",
        "api/app/main.py": "from fastapi import FastAPI\napp = FastAPI()",
        "web/package.json": '{"scripts":{"dev":"vite"}}',
        "web/vite.config.ts": "export default {}",
      },
      services: [
        service({ key: "api", cwd: "api", command: "uvicorn app.main:app --host 127.0.0.1 --port {port}", ready: { http: "/docs" } }),
        service({ key: "web", cwd: "web", command: "npm run dev -- --port {port} --strictPort", env: { VITE_API_URL: "http://127.0.0.1:{port:api}" }, dependsOn: ["api"] }),
      ],
    },
    {
      stack: "Spring Boot (Maven wrapper)",
      files: { "pom.xml": "<project/>", mvnw: "#!/bin/sh", "src/main/java/demo/DemoApplication.java": "class DemoApplication {}" },
      services: [service({ key: "web", command: "./mvnw spring-boot:run -Dspring-boot.run.arguments=--server.port={port}", readyTimeoutMs: 300_000 })],
    },
    {
      stack: "Elixir Phoenix",
      files: { "mix.exs": "defmodule App.MixProject do end", "lib/app_web/endpoint.ex": "" },
      services: [service({ key: "web", command: "mix phx.server" })],
    },
    {
      stack: "Rails",
      files: { Gemfile: "gem 'rails'", "bin/rails": "#!/usr/bin/env ruby", "config.ru": "run Rails.application" },
      services: [service({ key: "web", command: "bin/rails server -b 127.0.0.1 -p {port}" })],
    },
    {
      stack: ".NET",
      files: { "Api/Api.csproj": "<Project Sdk=\"Microsoft.NET.Sdk.Web\"/>", "Api/Program.cs": "var app = WebApplication.Create();" },
      services: [service({ key: "api", cwd: "Api", command: "dotnet run --urls http://127.0.0.1:{port}" })],
    },
    {
      stack: "Go",
      files: { "go.mod": "module example.com/app", "cmd/server/main.go": "package main" },
      services: [service({ key: "web", command: "go run ./cmd/server", portEnv: "HTTP_PORT" })],
    },
    {
      stack: "a worker with no port",
      files: { "Cargo.toml": "[package]\nname='worker'", "src/main.rs": "fn main() {}" },
      services: [service({ key: "worker", command: "cargo run", port: "none", ready: { log: "worker started" } })],
    },
  ])("accepts a recipe for $stack", async ({ files, services }) => {
    const { result, prompts } = run({ files, answer: { basis: "code", services, reason: "From the manifests.", evidence: Object.keys(files) } })
    const { draft, rejected } = await result
    expect(rejected).toEqual([])
    expect(draft?.source).toBe("model")
    expect(draft?.confidence).toBe("likely")
    const added = draft?.fix.kind === "apply-settings" ? draft.fix.patch.appLaunch?.add : undefined
    expect(added?.map((s) => s.command)).toEqual(services.map((s) => s.command))
    expect(added?.some((s) => s.provisional)).toBe(false)
    // The model saw the files that say how the project runs.
    for (const file of Object.keys(files)) expect(prompts[0]).toContain(file)
  })

  it("plans a provisional recipe from the intent when there's no app yet", async () => {
    const { result, prompts } = run({
      files: { "README.md": "# Inventory" },
      intent: "Inventory. A Django site where staff track stock levels.",
      answer: {
        basis: "intent",
        services: [service({ key: "web", label: "Django dev server", command: "python manage.py runserver 127.0.0.1:{port} --noreload" })],
        reason: "The intent asks for Django.",
        evidence: [],
      },
    })
    const { draft } = await result
    expect(prompts[0]).toContain("A Django site where staff track stock levels")
    expect(draft?.confidence).toBe("guess")
    expect(draft?.title).toMatch(/planned from the intent/)
    const added = draft?.fix.kind === "apply-settings" ? draft.fix.patch.appLaunch?.add : []
    expect(added).toEqual([expect.objectContaining({ key: "web", provisional: true })])
  })

  it.each([
    {
      why: "chained commands",
      services: [service({ key: "web", command: "npm install && npm start" })],
      reason: /one command per step/,
    },
    {
      why: "a wrapper that isn't in the repo",
      services: [service({ key: "web", command: "./gradlew bootRun" })],
      reason: /gradlew doesn't exist/,
    },
    {
      why: "a directory that isn't in the repo",
      services: [service({ key: "web", cwd: "frontend", command: "npm run dev" })],
      reason: /"frontend" doesn't exist/,
    },
    {
      why: "an invalid recipe",
      services: [service({ key: "web", command: "serve", port: "none", ready: { http: "/" } })],
      reason: /can't be checked over HTTP/,
    },
  ])("rejects $why", async ({ services, reason }) => {
    const { result } = run({
      files: { "package.json": "{}", "server.js": "" },
      answer: { basis: "code", services, reason: "", evidence: [] },
    })
    const { draft, rejected } = await result
    expect(draft).toBeNull()
    expect(rejected[0].reason).toMatch(reason)
  })

  it("accepts executables that worktree setup creates (a virtualenv)", async () => {
    const { result } = run({
      files: {
        "pyproject.toml": "[project]\nname='agent-os'\n[project.scripts]\nagent-os='agent_os.cli:main'",
        "dashboard/package.json": '{"scripts":{"dev":"next dev"}}',
      },
      answer: {
        basis: "code",
        services: [
          service({ key: "api", label: "API", command: ".venv/bin/agent-os api serve --host 127.0.0.1 --port {port}", ready: { http: "/health" } }),
          service({ key: "web", label: "Dashboard", cwd: "dashboard", command: "pnpm run dev --port {port}", env: { API_URL: "http://127.0.0.1:{port:api}" }, dependsOn: ["api"] }),
        ],
        reason: "",
        evidence: [],
      },
    })
    const { draft, rejected } = await result
    expect(rejected).toEqual([])
    const added = draft?.fix.kind === "apply-settings" ? draft.fix.patch.appLaunch?.add : []
    expect(added?.map((s) => s.key)).toEqual(["api", "web"])
  })

  it("asks once more with the reason, and keeps the corrected recipe", async () => {
    const answers = [
      { basis: "code", services: [service({ key: "web", command: "npm install && npm start" })], reason: "", evidence: [] },
      { basis: "code", services: [service({ key: "web", command: "npm start" })], reason: "", evidence: [] },
    ]
    const prompts: string[] = []
    const { draft } = await modelRecipe({
      workspace,
      files: ["package.json"],
      roots: [],
      intent: "",
      setupSteps: [],
      hint: [],
      read: async () => "{}",
      complete: async (_system, user) => {
        prompts.push(user)
        return JSON.stringify(answers.shift())
      },
      signal: new AbortController().signal,
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatch(/YOUR PREVIOUS ANSWER DIDN'T WORK: it was rejected: .*one command per step/)
    expect(draft?.fix.kind === "apply-settings" && draft.fix.patch.appLaunch?.add?.[0].command).toBe("npm start")
  })

  it("says what it proposed when every answer fails the checks", async () => {
    const bad = {
      basis: "code",
      services: [service({ key: "api", label: "Python API", command: "cd api && uvicorn main:app" })],
      reason: "",
      evidence: [],
    }
    const { result, prompts } = run({ files: { "api/main.py": "" }, answer: bad })
    const { draft, rejected, proposed } = await result
    expect(prompts).toHaveLength(3)
    expect(draft).toBeNull()
    expect(rejected[0].reason).toMatch(/one command per step/)
    expect(proposed).toEqual(["Python API"])
  })

  it("starts the recipe for real and fixes it from what the app printed", async () => {
    const answers = [
      service({ key: "api", label: "API", command: "agent-os api serve --port {port}" }),
      service({
        key: "api",
        label: "API",
        prepare: "agent-os state init",
        command: "agent-os api serve --port {port}",
      }),
    ].map((s) => ({ basis: "code", services: [s], reason: "", evidence: [] }))
    const prompts: string[] = []
    const tried: string[] = []
    const { draft } = await modelRecipe({
      workspace,
      files: ["pyproject.toml"],
      roots: [],
      intent: "",
      setupSteps: [],
      hint: [],
      read: async () => "",
      complete: async (_system, user) => {
        prompts.push(user)
        return JSON.stringify(answers.shift())
      },
      signal: new AbortController().signal,
      tryStart: async (recipe) => {
        tried.push(recipe.services[0].prepare ?? "")
        return recipe.services[0].prepare ? null : "API (api) didn't start: exited with 1.\n  output: no such table: runs"
      },
    })
    expect(tried).toEqual(["", "agent-os state init"])
    expect(prompts[1]).toMatch(/started in the workspace and failed:\n[\s\S]*no such table: runs/)
    expect(draft).toMatchObject({ confidence: "verified", explanation: expect.stringMatching(/came up/) })
  })

  it("gives up after three starts that fail, saying what it proposed", async () => {
    const { result } = await (async () => {
      const prompts: string[] = []
      const result = modelRecipe({
        workspace,
        files: ["pyproject.toml"],
        roots: [],
        intent: "",
        setupSteps: [],
        hint: [],
        read: async () => "",
        complete: async (_system, user) => {
          prompts.push(user)
          return JSON.stringify({ basis: "code", services: [service({ key: "api", label: "API", command: "serve" })], reason: "", evidence: [] })
        },
        signal: new AbortController().signal,
        tryStart: async () => "exited with 1",
      })
      return { result, prompts }
    })()
    const { draft, rejected, proposed } = await result
    expect(draft).toBeNull()
    expect(rejected[0].reason).toMatch(/didn't start the app after three tries/)
    expect(proposed).toEqual(["API"])
  })

  it("returns nothing for a project with nothing to start", async () => {
    const { result } = run({
      files: { "pyproject.toml": "[project]\nname='lib'" },
      answer: { basis: "none", services: [], reason: "A library.", evidence: [] },
    })
    const { draft, rejected } = await result
    expect(draft).toBeNull()
    expect(rejected[0].reason).toMatch(/Nothing to start: A library/)
  })

  it("fails loudly on an answer that isn't JSON", async () => {
    const { result } = run({ files: {}, answer: "I think you should run npm start." })
    await expect(result).rejects.toThrow(/didn't return JSON/)
  })
})
