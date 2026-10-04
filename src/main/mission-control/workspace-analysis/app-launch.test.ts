import { execFileSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { describe, expect, it } from "vitest"
import { appLaunchDrafts, appLaunchDraftsAtRef } from "./app-launch"
import type { ProjectRoot } from "./inventory"

function root(dir: string, ecosystems: ProjectRoot["ecosystems"]): ProjectRoot {
  return { dir, ecosystems } as ProjectRoot
}

async function drafts(files: Record<string, string>, roots: ProjectRoot[]) {
  return appLaunchDrafts({
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

describe("appLaunchDrafts", () => {
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
      [pkg({ dev: "node server.js" }), ["bun"], "bun run dev", "App (dev)"],
    ]
    for (const [manifest, ecosystems, command, label] of cases) {
      const [draft] = await drafts({ "package.json": manifest }, [
        root("", ecosystems),
      ])
      expect(draft.fix).toMatchObject({
        kind: "apply-settings",
        patch: { appLaunch: { add: [{ command, cwd: "", port: "auto" }] } },
      })
      expect(
        draft.fix.kind === "apply-settings" &&
          draft.fix.patch.appLaunch?.add?.[0].label
      ).toContain(label)
    }
  })

  it("prefers dev over start and skips projects with nothing to serve", async () => {
    const [draft] = await drafts(
      {
        "web/package.json": pkg(
          { start: "next start", dev: "next dev" },
          { next: "14" }
        ),
      },
      [root("web", ["npm"])]
    )
    expect(draft.fix).toMatchObject({
      patch: {
        appLaunch: {
          add: [{ key: "web", command: "npm run dev", cwd: "web" }],
        },
      },
    })
    expect(
      await drafts({ "package.json": pkg({ build: "tsc" }) }, [
        root("", ["npm"]),
      ])
    ).toEqual([])
    // Electron apps are launched by Playwright, not served.
    expect(
      await drafts(
        {
          "package.json": pkg({ dev: "electron-vite dev" }, { electron: "30" }),
        },
        [root("", ["pnpm"])]
      )
    ).toEqual([])
  })

  it("uses a Procfile's web process and gives each root its own key", async () => {
    const [draft] = await drafts(
      {
        "api/Procfile":
          "release: rake db:migrate\nweb: bundle exec puma -p $PORT\n",
        "web/package.json": pkg({ dev: "vite" }),
      },
      [root("api", ["bundler"]), root("web", ["npm"])]
    )
    expect(
      draft.fix.kind === "apply-settings" &&
        draft.fix.patch.appLaunch?.add?.map((s) => [s.key, s.command])
    ).toEqual([
      ["api", "bundle exec puma -p $PORT"],
      ["web", "npm run dev -- --port {port} --strictPort"],
    ])
  })

  it("proposes Django's runserver", async () => {
    const [draft] = await drafts(
      {
        "manage.py":
          "import django\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'x')",
      },
      [root("", ["pip"])]
    )
    expect(draft.fix).toMatchObject({
      patch: {
        appLaunch: {
          add: [
            {
              command:
                "python3 manage.py runserver 127.0.0.1:{port} --noreload",
            },
          ],
        },
      },
    })
  })

  it("points out compose files without proposing them", async () => {
    const result = await drafts({ "docker-compose.yml": "services: {}" }, [])
    expect(result).toEqual([
      expect.objectContaining({
        key: "app-launch:compose",
        fix: expect.objectContaining({ kind: "manual" }),
      }),
    ])
  })

  it("proposes a dependency-free Node server that reads PORT", async () => {
    const server =
      "const http = require('node:http')\nhttp.createServer(handler).listen(process.env.PORT || 3000)\n"
    // No manifest at all: the workspace root is still checked.
    const [draft] = await drafts({ "server.js": server, "index.html": "" }, [])
    expect(draft.fix).toMatchObject({
      kind: "apply-settings",
      patch: {
        appLaunch: {
          add: [
            { key: "web", command: "node server.js", cwd: "", port: "auto" },
          ],
        },
      },
    })
    expect(draft.confidence).toBe("likely")
    // A package.json with nothing to serve falls back to the server file.
    const [fallback] = await drafts(
      { "package.json": pkg({ test: "node --test" }), "server.js": server },
      [root("", ["npm"])]
    )
    expect(
      fallback.fix.kind === "apply-settings" &&
        fallback.fix.patch.appLaunch?.add?.[0].command
    ).toBe("node server.js")
    // A fixed port would collide across parallel worktrees.
    expect(await drafts({ "server.js": "server.listen(3000)" }, [])).toEqual([])
  })
})

describe("appLaunchDraftsAtRef", () => {
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
        await appLaunchDraftsAtRef({ workspace: repo, ref: "main" })
      ).toEqual([])
      const [draft] = await appLaunchDraftsAtRef({
        workspace: repo,
        ref: "integration",
      })
      expect(draft).toMatchObject({
        key: "app-launch:recipe",
        fix: { patch: { appLaunch: { add: [{ command: "node server.js" }] } } },
      })
      expect(
        await appLaunchDraftsAtRef({ workspace: repo, ref: "missing" })
      ).toEqual([])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
