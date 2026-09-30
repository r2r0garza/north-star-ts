import { execFileSync } from "child_process"
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import path from "path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import type {
  Finding,
  Fix,
} from "../../../shared/mission-control/workspace-analysis"
import type { WorktreeSetupStep } from "../../db/types"
import { analyzeWorkspace, type CurrentSettings } from "./analyze"
import { applyPatch } from "./apply"
import { assembleFindings } from "./assemble"
import { setFakeToolsForTests, type ExecResult } from "./exec"
import { FIXTURES, type Fixture } from "./__fixtures__/fixtures"

// The "as good as manual setup" corpus (plan 106.11). Deterministic stages
// only: no model. Every fixture must produce its required findings, no
// forbidden outcome, and no finding without a fix.

const dirs: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

// "{{root}}" in content is the repository's real path.
function write(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content.replaceAll("{{root}}", root))
  }
}

function build(fixture: Fixture): string {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "wa-fixture-")))
  dirs.push(base)
  const root = path.join(base, "repo")
  mkdirSync(root)
  write(root, fixture.tracked)
  const old = new Date(Date.now() - 3600_000)
  for (const rel of Object.keys(fixture.tracked))
    utimesSync(path.join(root, rel), old, old)
  if (!fixture.noGit) {
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "t@example.com")
    git(root, "config", "user.name", "T")
    git(root, "config", "commit.gpgsign", "false")
    if (!fixture.noCommit) {
      git(root, "add", "-A")
      git(root, "commit", "-q", "-m", "base")
    }
  }
  write(root, fixture.ignored ?? {})
  for (const [link, target] of Object.entries(fixture.symlinks ?? {})) {
    const full = path.join(root, link)
    mkdirSync(path.dirname(full), { recursive: true })
    symlinkSync(target, full)
  }
  write(root, fixture.dirty ?? {})
  if (fixture.linkedWorktree) {
    const worktree = path.join(base, "wt")
    git(root, "worktree", "add", "-q", "-b", "wt", worktree)
    return worktree
  }
  return fixture.workspace ? path.join(root, fixture.workspace) : root
}

// Version managers are absent unless a fixture lists them (uv is a project
// tool too, so it stays installed).
const MANAGERS = new Set([
  "mise",
  "asdf",
  "pyenv",
  "fnm",
  "volta",
  "rbenv",
  "rustup",
  "fvm",
  "corepack",
])
const executed: string[] = []

function fakeTools(fixture: Fixture) {
  const ok = (stdout: string): ExecResult => ({
    ok: true,
    exitCode: 0,
    stdout,
    stderr: "",
    missing: false,
    timedOut: false,
  })
  const missing: ExecResult = {
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: "not found",
    missing: true,
    timedOut: false,
  }
  setFakeToolsForTests({
    run: (file) => {
      executed.push(file)
      const configured = fixture.tools?.[file]
      if (configured === null) return missing
      if (typeof configured === "string") return ok(configured)
      if (MANAGERS.has(file)) return missing
      // Versioned interpreters exist only when a fixture lists them.
      if (/^python3\.\d+$/.test(file)) return missing
      return ok(`${file} 99.0.0`)
    },
    shell: (command) => {
      executed.push(command)
      const rule = fixture.shell?.find((s) => s.match.test(command))
      if (rule)
        return {
          ok: rule.ok,
          exitCode: rule.ok ? 0 : 1,
          stdout: rule.output ?? "",
          stderr: "",
          missing: false,
          timedOut: false,
        }
      return ok("")
    },
  })
}

function settingsOf(fixture: Fixture): CurrentSettings {
  return {
    linkPaths: fixture.settings?.linkPaths ?? [],
    steps: (fixture.settings?.steps ?? []).map((s, i) => ({
      id: `user-${i}`,
      label: s.command,
      ...s,
    })),
    generatedFiles: fixture.settings?.generatedFiles ?? [],
    overlapPolicy: "wait",
  }
}

function commandsOf(fix: Fix): string[] {
  if (fix.kind === "run-command") return fix.commands.map((c) => c.command)
  if (fix.kind === "run-checks") return fix.probes.map((p) => p.command ?? "")
  if (fix.kind === "apply-settings")
    return [
      ...(fix.patch.worktreeSetupSteps?.add ?? []).map((s) => s.command),
      ...(fix.patch.generatedFiles?.add ?? []).map((r) => r.command),
    ]
  return []
}

function linksProposed(findings: Finding[]): string[] {
  return findings.flatMap((f) =>
    [f.fix, ...f.alternatives].flatMap((fix) =>
      fix.kind === "apply-settings" || fix.kind === "run-command"
        ? (fix.patch?.worktreeLinkPaths?.add ?? [])
        : []
    )
  )
}

async function run(fixture: Fixture) {
  const workspace = build(fixture)
  fakeTools(fixture)
  executed.length = 0
  const settings = settingsOf(fixture)
  const facts = await analyzeWorkspace({
    workspace,
    settings,
    checkResults: {},
    platform: "darwin",
  })
  const findings = assembleFindings({
    drafts: facts.drafts,
    settings,
    dismissals: {},
  })
  return { workspace, facts, findings, settings }
}

beforeAll(() => setFakeToolsForTests(null))
afterEach(() => setFakeToolsForTests(null))
afterAll(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe("workspace analysis fixtures", () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, async () => {
      const { findings, settings } = await run(fixture)
      const byKey = new Map(findings.map((f) => [f.key, f]))
      const describeAll = () =>
        findings
          .map((f) => `${f.status.padEnd(8)} ${f.key} — ${f.title}`)
          .join("\n")
      const e = fixture.expect

      // Invariants: every finding has a usable fix.
      for (const f of findings) {
        expect(f.fix, f.key).toBeTruthy()
        if (f.fix.kind === "manual")
          expect(f.fix.steps.length, f.key).toBeGreaterThan(0)
        if (f.fix.kind === "run-command")
          expect(f.fix.commands.length, f.key).toBeGreaterThan(0)
      }
      for (const key of e.open ?? [])
        expect(
          byKey.get(key)?.status,
          `${key} should be open in:\n${describeAll()}`
        ).toBe("open")
      for (const key of e.resolved ?? [])
        expect(
          byKey.get(key)?.status,
          `${key} should be resolved in:\n${describeAll()}`
        ).toBe("resolved")
      for (const key of e.absent ?? [])
        expect(
          byKey.has(key),
          `${key} should be absent in:\n${describeAll()}`
        ).toBe(false)
      for (const [key, kind] of Object.entries(e.fixKinds ?? {}))
        expect(byKey.get(key)?.fix.kind, key).toBe(kind)
      for (const [key, commands] of Object.entries(e.commands ?? {}))
        expect(
          commandsOf(
            byKey.get(key)?.fix ?? { kind: "manual", summary: "", steps: [] }
          ),
          `${key} in:\n${describeAll()}`
        ).toEqual(commands)
      for (const [key, confidence] of Object.entries(e.confidence ?? {}))
        expect(byKey.get(key)?.confidence, key).toBe(confidence)
      for (const [key, severity] of Object.entries(e.severity ?? {}))
        expect(byKey.get(key)?.severity, key).toBe(severity)
      const links = linksProposed(findings)
      for (const forbidden of e.forbidLinks ?? [])
        expect(links, `must never propose linking ${forbidden}`).not.toContain(
          forbidden
        )
      for (const pattern of e.forbidExecuted ?? [])
        expect(
          executed.filter((c) => pattern.test(c)),
          `must not run ${pattern}`
        ).toEqual([])

      // A shared venv carries its full setup (never the main checkout's
      // --clear) and the install to run when dependencies differ.
      for (const f of findings)
        for (const step of f.fix.kind === "apply-settings"
          ? (f.fix.patch.worktreeSetupSteps?.add ?? [])
          : [])
          if (step.kind === "python-shared-venv") {
            expect(step.fallback?.length, f.key).toBeGreaterThan(0)
            expect(
              step.fallback?.some((c) => c.command.includes("--clear"))
            ).toBe(false)
            expect(
              step.refresh?.every((c) => /pip install/.test(c.command))
            ).toBe(true)
          }

      if (e.settingsAfter) {
        // Apply every open settings fix Apply all selects by default.
        let current = {
          worktreeSetup: {
            linkPaths: settings.linkPaths,
            steps: settings.steps.map((s) => ({
              ...s,
              source: "user" as const,
            })) as WorktreeSetupStep[],
          },
          generatedFiles: settings.generatedFiles,
        }
        for (const f of findings) {
          if (f.status !== "open" || f.confidence === "guess") continue
          const patch =
            f.fix.kind === "apply-settings"
              ? f.fix.patch
              : f.fix.kind === "run-command"
                ? f.fix.patch
                : undefined
          if (patch) current = applyPatch(current, patch, f.key)
        }
        if (e.settingsAfter.linkPaths)
          expect([...current.worktreeSetup.linkPaths].sort()).toEqual(
            [...e.settingsAfter.linkPaths].sort()
          )
        if (e.settingsAfter.steps)
          expect(
            current.worktreeSetup.steps.map((s) => `${s.cwd}|${s.command}`)
          ).toEqual(e.settingsAfter.steps)
        if (e.settingsAfter.generated)
          expect(current.generatedFiles.map((r) => r.command).sort()).toEqual(
            [...e.settingsAfter.generated].sort()
          )
      }
    })
  }
})
