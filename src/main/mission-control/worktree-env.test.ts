const nodeCommand = (code: string) =>
  `"${process.execPath}" -e "eval(Buffer.from('${Buffer.from(code).toString("base64")}', 'base64').toString('utf8'))"`

import { execFileSync } from "child_process"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import path from "path"
import { afterEach, describe, expect, it } from "vitest"
import type { WorktreeSetupStep } from "../db/types"
import {
  localizeDivergedLinks,
  prepareWorktreeEnvironment,
  renderEnvironment,
} from "./worktree-env"

const dirs: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

// A repository whose main checkout has an ignored .venv, plus a worktree of it
// (which, like a user story's, has only tracked files).
function repoWithWorktree() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wt-env-")))
  dirs.push(root)
  git(root, "init", "-b", "main")
  git(root, "config", "core.autocrlf", "false")
  git(root, "config", "core.eol", "lf")
  git(root, "config", "user.email", "t@example.com")
  git(root, "config", "user.name", "T")
  writeFileSync(path.join(root, ".gitignore"), ".venv/\n")
  writeFileSync(path.join(root, "app.py"), "print('hi')\n")
  git(root, "add", ".")
  git(root, "commit", "-m", "base")
  mkdirSync(path.join(root, ".venv", "bin"), { recursive: true })
  writeFileSync(path.join(root, ".venv", "bin", "pytest"), "#!/bin/sh\n")
  const worktree = `${root}-story`
  dirs.push(worktree)
  git(root, "worktree", "add", "-q", "-b", "story", worktree)
  return { root, worktree }
}

function step(id: string, command: string): WorktreeSetupStep {
  return { id, label: id, command, cwd: "", source: "user" }
}

function result(s: WorktreeSetupStep, status: "ok" | "failed" | "skipped") {
  return {
    id: s.id,
    label: s.label,
    command: s.command,
    cwd: s.cwd,
    status,
    exitCode: status === "ok" ? 0 : null,
    durationMs: 1,
    outputTail: "",
    error: null,
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe("prepareWorktreeEnvironment", () => {
  it("links ignored paths from the main checkout without git picking them up", async () => {
    const { root, worktree } = repoWithWorktree()
    const env = await prepareWorktreeEnvironment({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      setup: { linkPaths: [".venv", "node_modules"], steps: [] },
    })
    expect(env).toEqual({
      linked: [".venv"],
      missing: ["node_modules"],
      steps: [],
      error: null,
    })
    expect(lstatSync(path.join(worktree, ".venv")).isSymbolicLink()).toBe(true)
    expect(existsSync(path.join(worktree, ".venv", "bin", "pytest"))).toBe(true)
    // A symlink isn't matched by ".venv/", so without the exclude it'd commit.
    expect(git(worktree, "status", "--porcelain")).toBe("")
  })

  it("runs the setup steps in the worktree and reports a failure instead of throwing", async () => {
    const { root, worktree } = repoWithWorktree()
    const ok = await prepareWorktreeEnvironment({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      setup: {
        linkPaths: [],
        steps: [
          step(
            "ready",
            nodeCommand("require('fs').writeFileSync('.ready', '')")
          ),
        ],
      },
    })
    expect(ok).toMatchObject({ error: null })
    expect(ok?.steps).toMatchObject([
      { id: "ready", status: "ok", exitCode: 0 },
    ])
    expect(existsSync(path.join(worktree, ".ready"))).toBe(true)

    const failed = await prepareWorktreeEnvironment({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      setup: {
        linkPaths: [],
        steps: [
          step("boom", nodeCommand("console.error('nope'); process.exit(4)")),
          step(
            "after",
            nodeCommand("require('fs').writeFileSync('.after', '')")
          ),
        ],
      },
    })
    expect(failed?.error).toContain("boom")
    expect(failed?.steps).toMatchObject([
      { id: "boom", status: "failed", exitCode: 4 },
      { id: "after", status: "skipped" },
    ])
    expect(failed?.steps[0].outputTail).toContain("nope")
    expect(existsSync(path.join(worktree, ".after"))).toBe(false)
  })

  it("runs each step in its own directory, in order", async () => {
    const { root, worktree } = repoWithWorktree()
    mkdirSync(path.join(worktree, "api"))
    const env = await prepareWorktreeEnvironment({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      setup: {
        linkPaths: [],
        steps: [
          {
            ...step(
              "one",
              nodeCommand("require('fs').writeFileSync('first', '')")
            ),
            cwd: "api",
          },
          step(
            "two",
            nodeCommand(
              "const fs = require('fs'); fs.accessSync('api/first'); fs.writeFileSync('second', '')"
            )
          ),
        ],
      },
    })
    expect(env?.error).toBeNull()
    expect(existsSync(path.join(worktree, "api", "first"))).toBe(true)
    expect(existsSync(path.join(worktree, "second"))).toBe(true)
  })

  it("does nothing when the workspace configures no setup", async () => {
    const { root, worktree } = repoWithWorktree()
    expect(
      await prepareWorktreeEnvironment({
        mainWorkspace: root,
        worktreeWorkspace: worktree,
        setup: { linkPaths: [], steps: [] },
      })
    ).toBeNull()
  })
})

describe("renderEnvironment", () => {
  it("tells agents what's ready and not to search the machine", () => {
    const text = renderEnvironment({
      linked: [".venv"],
      missing: [],
      steps: [result(step("pip", "pip install -e '.[dev]'"), "ok")],
      error: null,
    }).join("\n")
    expect(text).toContain("## Environment")
    expect(text).toContain("`.venv`")
    expect(text).toContain("already ran here")
    expect(text).toContain("don't search the machine")
  })

  it("asks agents to report, not improvise, when setup failed", () => {
    const text = renderEnvironment({
      linked: [],
      missing: [],
      steps: [
        {
          ...result(step("uv", "uv sync"), "failed"),
          error: "uv: command not found",
        },
        result(step("gen", "pnpm gen"), "skipped"),
      ],
      error: "Install: uv: command not found",
    }).join("\n")
    expect(text).toContain("failed (uv: command not found)")
    expect(text).toContain("didn't run: `pnpm gen`")
    expect(text).toContain("say so in your result")
  })
})

// A real interpreter, when the machine has one; the shared-venv step is
// mostly about what Python actually imports.
const python = (() => {
  for (const exe of ["python3.12", "python3.13", "python3.11", "python3"]) {
    try {
      execFileSync(exe, ["-c", "import venv"], { stdio: "ignore" })
      return exe
    } catch {
      // try the next
    }
  }
  return null
})()

describe.skipIf(!python)("python-shared-venv", () => {
  // The main checkout: a venv with a dependency installed and an editable
  // install of the project pointing at the MAIN checkout's src.
  function project() {
    const { root, worktree } = repoWithWorktree()
    for (const [base, value] of [
      [root, "main"],
      [worktree, "worktree"],
    ] as const) {
      mkdirSync(path.join(base, "src", "shop"), { recursive: true })
      writeFileSync(
        path.join(base, "src", "shop", "__init__.py"),
        `VALUE = "${value}"\ndef cli():\n    print("cli", VALUE)\n`
      )
      writeFileSync(
        path.join(base, "pyproject.toml"),
        '[project]\nname = "shop"\ndependencies = ["dep"]\n\n[project.scripts]\nshop = "shop:cli"\n'
      )
    }
    rmSync(path.join(root, ".venv"), { recursive: true, force: true })
    execFileSync(python!, [
      "-m",
      "venv",
      "--without-pip",
      path.join(root, ".venv"),
    ])
    const site = execFileSync(
      path.join(root, ".venv", "bin", "python"),
      ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
      { encoding: "utf8" }
    ).trim()
    writeFileSync(path.join(site, "dep.py"), "OK = 1\n")
    // A tool a dependency installed, as pip writes launchers.
    const bin = path.join(root, ".venv", "bin")
    writeFileSync(
      path.join(bin, "deptool"),
      `#!${path.join(bin, "python")}\nimport shop\nprint(shop.VALUE)\n`
    )
    chmodSync(path.join(bin, "deptool"), 0o755)
    writeFileSync(
      path.join(site, "_shop_editable.pth"),
      `${path.join(root, "src")}\n`
    )
    return { root, worktree }
  }

  const step = {
    id: "shared",
    label: "Reuse the main environment's packages",
    command: "reuse .venv packages",
    cwd: "",
    source: "analysis" as const,
    kind: "python-shared-venv" as const,
    venv: ".venv",
    fallback: [{ label: "venv", command: "touch fallback-ran" }],
    refresh: [{ label: "install", command: "touch refresh-ran" }],
  }

  it("imports the worktree's code with the main checkout's packages, and nothing installed", async () => {
    const { root, worktree } = project()
    const env = await prepareWorktreeEnvironment({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      setup: { linkPaths: [], steps: [step] },
    })
    expect(env?.error).toBeNull()
    const py = path.join(worktree, ".venv", "bin", "python")
    const out = execFileSync(
      py,
      ["-c", "import shop, dep; print(shop.VALUE, dep.OK)"],
      {
        encoding: "utf8",
      }
    ).trim()
    expect(out).toBe("worktree 1")
    // The project's own command runs the worktree's code too.
    expect(
      execFileSync(path.join(worktree, ".venv", "bin", "shop"), {
        encoding: "utf8",
      }).trim()
    ).toBe("cli worktree")
    expect(existsSync(path.join(worktree, "fallback-ran"))).toBe(false)
    expect(existsSync(path.join(worktree, "refresh-ran"))).toBe(false)
    // A dependency's tool (like pytest) runs with the worktree's Python.
    expect(
      execFileSync(path.join(worktree, ".venv", "bin", "deptool"), {
        encoding: "utf8",
      }).trim()
    ).toBe("worktree")
    // Agents are told how to use the environment.
    expect(renderEnvironment(env).join("\n")).toContain(
      "`.venv/bin/python -m pytest`"
    )
  })

  it("installs on top when the worktree's dependencies differ, and falls back without a main venv", async () => {
    const { root, worktree } = project()
    writeFileSync(
      path.join(worktree, "pyproject.toml"),
      '[project]\nname = "shop"\ndependencies = ["dep", "newdep"]\n'
    )
    await prepareWorktreeEnvironment({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      setup: { linkPaths: [], steps: [step] },
    })
    expect(existsSync(path.join(worktree, "refresh-ran"))).toBe(true)

    rmSync(path.join(root, ".venv"), { recursive: true, force: true })
    rmSync(path.join(worktree, ".venv"), { recursive: true, force: true })
    await prepareWorktreeEnvironment({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      setup: { linkPaths: [], steps: [step] },
    })
    expect(existsSync(path.join(worktree, "fallback-ran"))).toBe(true)
  })
})

// Plan 112.5: a story that changes its dependencies gets its own install.
describe("localizeDivergedLinks", () => {
  function nodeRepo() {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wt-deps-")))
    dirs.push(root)
    git(root, "init", "-b", "main")
    git(root, "config", "user.email", "t@example.com")
    git(root, "config", "user.name", "T")
    writeFileSync(path.join(root, ".gitignore"), "node_modules/\n")
    writeFileSync(path.join(root, "package.json"), '{"dependencies":{}}\n')
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n")
    git(root, "add", ".")
    git(root, "commit", "-m", "base")
    mkdirSync(path.join(root, "node_modules", "left-pad"), { recursive: true })
    const worktree = `${root}-story`
    dirs.push(worktree)
    git(root, "worktree", "add", "-q", "-b", "story", worktree)
    return { root, worktree }
  }
  const setup = { linkPaths: ["node_modules"], steps: [] }

  it("keeps the shared link while the manifests match", async () => {
    const { root, worktree } = nodeRepo()
    await prepareWorktreeEnvironment({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      setup,
    })
    const runs: string[] = []
    const results = await localizeDivergedLinks({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      setup,
      run: async (_cwd, command) => {
        runs.push(command)
      },
    })
    expect(results).toEqual([])
    expect(runs).toEqual([])
    expect(
      lstatSync(path.join(worktree, "node_modules")).isSymbolicLink()
    ).toBe(true)
  })

  it("installs in the worktree on divergence, leaving the main checkout's alone", async () => {
    const { root, worktree } = nodeRepo()
    await prepareWorktreeEnvironment({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      setup,
    })
    writeFileSync(
      path.join(worktree, "package.json"),
      '{"dependencies":{"is-even":"1.0.0"}}\n'
    )
    const runs: Array<{ cwd: string; command: string }> = []
    const results = await localizeDivergedLinks({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      setup,
      run: async (cwd, command) => {
        runs.push({ cwd, command })
        mkdirSync(path.join(cwd, "node_modules", "is-even"), {
          recursive: true,
        })
      },
    })
    expect(runs).toEqual([{ cwd: worktree, command: "pnpm install" }])
    expect(results).toMatchObject([{ status: "ok", cwd: "" }])
    expect(results[0].label).toContain("package.json")
    const local = path.join(worktree, "node_modules")
    expect(lstatSync(local).isSymbolicLink()).toBe(false)
    expect(existsSync(path.join(local, "is-even"))).toBe(true)
    // The shared directory is untouched.
    expect(existsSync(path.join(root, "node_modules", "is-even"))).toBe(false)
    expect(existsSync(path.join(root, "node_modules", "left-pad"))).toBe(true)
    // Removing the worktree removes the local install with it.
    git(root, "worktree", "remove", "--force", worktree)
    expect(existsSync(local)).toBe(false)
    expect(existsSync(path.join(root, "node_modules", "left-pad"))).toBe(true)
  })

  it("puts the link back when the install fails", async () => {
    const { root, worktree } = nodeRepo()
    await prepareWorktreeEnvironment({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      setup,
    })
    writeFileSync(
      path.join(worktree, "pnpm-lock.yaml"),
      "lockfileVersion: 10\n"
    )
    const results = await localizeDivergedLinks({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      // The workspace's own setup step for that root is what runs.
      setup: {
        linkPaths: ["node_modules"],
        steps: [step("deps", "make deps")],
      },
      run: async (_cwd, command) => {
        throw new Error(`${command}: offline`)
      },
    })
    expect(results).toMatchObject([
      { status: "failed", command: "make deps", error: "make deps: offline" },
    ])
    expect(
      lstatSync(path.join(worktree, "node_modules")).isSymbolicLink()
    ).toBe(true)
  })
})
