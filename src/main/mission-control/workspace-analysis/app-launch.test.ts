import { execFileSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { describe, expect, it } from "vitest"
import {
  APP_LAUNCH_COMPOSE_FINDING,
  appLaunchDraft,
  composeDraft,
  detectAppLaunch,
  detectAppLaunchAtRef,
} from "./app-launch"
import type { ProjectRoot } from "./inventory"

// The deterministic detectors (plan 112.3, ported from backup:109.03). The
// draft is saved as the recipe with `source: "detector"`; verification, not
// the user, decides whether it works.

function root(dir: string, ecosystems: ProjectRoot["ecosystems"]): ProjectRoot {
  return { dir, ecosystems } as ProjectRoot
}

async function detect(files: Record<string, string>, roots: ProjectRoot[]) {
  return detectAppLaunch({
    workspace: "/nowhere",
    roots,
    files: Object.keys(files),
    read: async (file) => files[file] ?? null,
  })
}

const pkg = (
  scripts: Record<string, string>,
  deps: Record<string, string> = {}
) => JSON.stringify({ scripts, dependencies: deps })

describe("detectAppLaunch", () => {
  it("passes the port the way each framework takes it", async () => {
    const cases: Array<[string, ProjectRoot["ecosystems"], string, string]> = [
      [
        pkg({ dev: "next dev" }, { next: "14" }),
        ["npm"],
        "npm run dev",
        "Next.js",
      ],
      [
        pkg({ dev: "vite" }),
        ["pnpm"],
        "pnpm run dev --port {port} --strictPort",
        "Vite",
      ],
      [
        pkg({ start: "ng serve" }),
        ["yarn"],
        "yarn start --port {port}",
        "Angular",
      ],
      [
        pkg({ dev: "astro dev" }),
        ["npm"],
        "npm run dev -- --port {port}",
        "Astro",
      ],
      [
        pkg({ start: "react-scripts start" }),
        ["npm"],
        "npm run start",
        "Create React App",
      ],
      [pkg({ dev: "nuxi dev" }), ["npm"], "npm run dev", "Nuxt"],
      [pkg({ dev: "node server.js" }), ["bun"], "bun run dev", "App (dev)"],
    ]
    for (const [manifest, ecosystems, command, label] of cases) {
      const { recipe } = await detect({ "package.json": manifest }, [
        root("", ecosystems),
      ])
      expect(recipe?.services[0]).toMatchObject({
        command,
        cwd: "",
        port: "auto",
        source: "detector",
      })
      expect(recipe?.services[0].label).toContain(label)
    }
  })

  it("prefers dev over start and skips projects with nothing to serve", async () => {
    const { recipe } = await detect(
      {
        "web/package.json": pkg(
          { start: "next start", dev: "next dev" },
          { next: "14" }
        ),
      },
      [root("web", ["npm"])]
    )
    expect(recipe?.services).toMatchObject([
      { key: "web", command: "npm run dev", cwd: "web" },
    ])
    expect(
      (
        await detect({ "package.json": pkg({ build: "tsc" }) }, [
          root("", ["npm"]),
        ])
      ).recipe
    ).toBeNull()
    // Electron projects get nothing.
    expect(
      (
        await detect(
          {
            "package.json": pkg(
              { dev: "electron-vite dev" },
              { electron: "30" }
            ),
          },
          [root("", ["pnpm"])]
        )
      ).recipe
    ).toBeNull()
  })

  it("uses a Procfile's web process and gives each root its own key", async () => {
    const { recipe } = await detect(
      {
        "api/Procfile":
          "release: rake db:migrate\nweb: bundle exec puma -p $PORT\n",
        "web/package.json": pkg({ dev: "vite" }),
      },
      [root("api", ["bundler"]), root("web", ["npm"])]
    )
    expect(recipe?.services.map((s) => [s.key, s.command])).toEqual([
      ["api", "bundle exec puma -p $PORT"],
      ["web", "npm run dev -- --port {port} --strictPort"],
    ])
  })

  it("drafts Django's runserver", async () => {
    const { recipe } = await detect(
      {
        "manage.py":
          "import django\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'x')",
      },
      [root("", ["pip"])]
    )
    expect(recipe?.services[0].command).toBe(
      "python3 manage.py runserver 127.0.0.1:{port} --noreload"
    )
  })

  it("points out compose files and never uses them", async () => {
    const result = await detect({ "docker-compose.yml": "services: {}" }, [])
    expect(result.recipe).toBeNull()
    expect(result.compose).toEqual(["docker-compose.yml"])
    expect(composeDraft(result.compose)).toMatchObject({
      key: APP_LAUNCH_COMPOSE_FINDING,
      severity: "info",
      fix: { kind: "manual" },
    })
    expect(composeDraft([])).toBeNull()
  })

  it("drafts a dependency-free Node server that reads PORT", async () => {
    const server =
      "const http = require('node:http')\nhttp.createServer(handler).listen(process.env.PORT || 3000)\n"
    // No manifest at all: the workspace root is still checked.
    const found = await detect({ "server.js": server, "index.html": "" }, [])
    expect(found.recipe?.services).toMatchObject([
      { key: "web", command: "node server.js", cwd: "", port: "auto" },
    ])
    expect(found.confidence).toBe("likely")
    // A package.json with nothing to serve falls back to the server file.
    const fallback = await detect(
      { "package.json": pkg({ test: "node --test" }), "server.js": server },
      [root("", ["npm"])]
    )
    expect(fallback.recipe?.services[0].command).toBe("node server.js")
    // A fixed port would collide across parallel worktrees.
    expect(
      (await detect({ "server.js": "server.listen(3000)" }, [])).recipe
    ).toBeNull()
  })
})

describe("appLaunchDraft", () => {
  const recipe = {
    services: [
      {
        key: "web",
        label: "Node server (server.js)",
        command: "node server.js",
        cwd: "",
        port: "auto" as const,
        ready: { http: "/" },
        source: "detector" as const,
      },
    ],
  }
  const state = (name: "unverified" | "verified" | "broken") => ({
    workspaceId: "w",
    branch: "main",
    state: name,
    commit: name === "verified" ? "abc" : null,
    failure:
      name === "broken"
        ? {
            stage: "prerequisites",
            class: "environment" as const,
            reason: "prerequisite_unavailable",
            summary: "the app needs a Postgres database on port 5432",
            logs: "",
          }
        : null,
    repairAttempts: 0,
    question: null,
    updatedAt: 1,
  })

  it("says how the app starts and whether it does, in plain language", () => {
    expect(
      appLaunchDraft({ recipe, state: state("unverified"), checking: false })
    ).toMatchObject({
      title: "How Mission Control starts the app",
      severity: "info",
      fix: { kind: "verify-app" },
    })
    expect(
      appLaunchDraft({ recipe, state: state("unverified"), checking: false })
        .explanation
    ).toMatch(/node server\.js.*Not checked yet/)
    expect(
      appLaunchDraft({ recipe, state: state("verified"), checking: false })
    ).toMatchObject({
      resolution: "The app starts and loads",
    })
    const broken = appLaunchDraft({
      recipe,
      state: state("broken"),
      checking: false,
    })
    expect(broken.severity).toBe("warning")
    expect(broken.explanation).toMatch(
      /The app didn't start: the app needs a Postgres database on port 5432\./
    )
    // Never a blocker: stories start anyway.
    expect(broken.severity).not.toBe("blocker")
  })

  it("offers a pending question's choices on the item itself", () => {
    const draft = appLaunchDraft({
      recipe,
      state: {
        ...state("broken"),
        question: {
          id: "q",
          featureId: "f",
          userStoryId: null,
          messageId: null,
          question:
            "The app needs a Postgres database on port 5432, and it isn't running.",
          choices: [
            {
              id: "self",
              label: "I'll start it myself",
              effect: { kind: "retry" },
            },
            {
              id: "skip",
              label: "Skip running the app for now",
              effect: { kind: "skip" },
            },
          ],
          askedAt: 1,
        },
      },
      checking: false,
    })
    expect(draft.fix).toEqual({
      kind: "answer-app-question",
      summary: "I'll start it myself",
      questionId: "q",
      choiceId: "self",
    })
    expect(draft.alternatives).toEqual([
      {
        kind: "answer-app-question",
        summary: "Skip running the app for now",
        questionId: "q",
        choiceId: "skip",
      },
    ])
  })

  it("doesn't judge a checkout the feature's work hasn't reached", () => {
    const draft = appLaunchDraft({
      recipe,
      // A failure recorded before the work landed.
      state: state("broken"),
      checking: false,
      notInCheckout: "mc/test/milestone-1/integration",
    })
    expect(draft.severity).toBe("info")
    expect(draft.explanation).toMatch(
      /isn't in your checkout yet: it's on mc\/test\/milestone-1\/integration/
    )
    expect(draft.explanation).not.toMatch(/didn't start/)
    expect(draft.fix.kind).toBe("manual")
    expect(draft.resolution).toBeUndefined()
  })

  it("has nothing to check without a recipe", () => {
    const draft = appLaunchDraft({
      recipe: { services: [] },
      state: null,
      checking: false,
    })
    expect(draft.fix.kind).toBe("manual")
    expect(draft.explanation).toMatch(/No way to start the app/)
  })
})

describe("detectAppLaunchAtRef", () => {
  it("reads a branch's tip, not the checkout", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "app-launch-ref-"))
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString()
    try {
      git("init", "-q", "-b", "main")
      git("config", "user.email", "test@example.com")
      git("config", "user.name", "Test")
      writeFileSync(path.join(repo, ".gitignore"), "node_modules\n")
      git("add", ".")
      git("commit", "-q", "-m", "init")
      git("checkout", "-q", "-b", "integration")
      writeFileSync(
        path.join(repo, "server.js"),
        "require('http').createServer(() => {}).listen(process.env.PORT)\n"
      )
      git("add", ".")
      git("commit", "-q", "-m", "server")
      git("checkout", "-q", "main")

      expect(
        (await detectAppLaunchAtRef({ workspace: repo, ref: "main" }))?.recipe
      ).toBeNull()
      const found = await detectAppLaunchAtRef({
        workspace: repo,
        ref: "integration",
      })
      expect(found?.recipe?.services).toMatchObject([
        { command: "node server.js", source: "detector" },
      ])
      expect(
        await detectAppLaunchAtRef({ workspace: repo, ref: "missing" })
      ).toBeNull()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
