// Dev-only: run workspace analysis (plan 106.11) against a local folder and
// print the checklist, the settings "Apply all" would produce, and — for a
// workspace you configured by hand — how that compares with your settings.
// The built-in checks only (no model), with the real tools on your PATH.
//
//   node scripts/analyze-workspace.mjs <folder> [--db <north-star.db>] [--json]
//
// --db reads the folder's current worktree setup and generated-file rules from
// the app's database (read-only), so a hand-configured workspace is a golden:
// every difference is either a finding to improve or a choice to explain.

import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}
const folder = args.find(
  (a, i) => !a.startsWith("--") && args[i - 1] !== "--db"
)
if (!folder || !existsSync(folder)) {
  console.error(
    "Usage: node scripts/analyze-workspace.mjs <folder> [--db <north-star.db>] [--json]"
  )
  process.exit(1)
}
const workspace = path.resolve(folder)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function readSettings(dbFile) {
  const empty = {
    linkPaths: [],
    steps: [],
    generatedFiles: [],
    overlapPolicy: "wait",
  }
  if (!dbFile) return { settings: empty, fromDb: false }
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(dbFile, { readOnly: true })
  const row = db
    .prepare(
      "SELECT worktree_setup, generated_files FROM workspaces WHERE path = ?"
    )
    .get(workspace)
  db.close()
  if (!row) {
    console.warn(
      `No workspace row for ${workspace} in ${dbFile}; comparing against empty settings.`
    )
    return { settings: empty, fromDb: false }
  }
  const setup = JSON.parse(row.worktree_setup ?? "{}")
  const steps = Array.isArray(setup.steps)
    ? setup.steps
    : setup.command
      ? [
          {
            id: "legacy-command",
            label: "Setup command",
            command: setup.command,
            cwd: "",
          },
        ]
      : []
  return {
    settings: {
      linkPaths: setup.linkPaths ?? [],
      steps,
      generatedFiles: JSON.parse(row.generated_files ?? "[]"),
      overlapPolicy: "wait",
    },
    fromDb: true,
  }
}

const server = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
})
try {
  const load = (p) => server.ssrLoadModule(path.join(root, p))
  const { analyzeWorkspace } = await load(
    "src/main/mission-control/workspace-analysis/analyze.ts"
  )
  const { assembleFindings } = await load(
    "src/main/mission-control/workspace-analysis/assemble.ts"
  )
  const { applyPatch } = await load(
    "src/main/mission-control/workspace-analysis/apply.ts"
  )
  const { settings, fromDb } = await readSettings(flag("--db"))
  const started = Date.now()
  const facts = await analyzeWorkspace({
    workspace,
    settings,
    checkResults: {},
    onStage: (stage) => process.stderr.write(`· ${stage}\n`),
  })
  const findings = assembleFindings({
    drafts: facts.drafts,
    settings,
    dismissals: {},
  })
  let after = {
    worktreeSetup: {
      linkPaths: settings.linkPaths,
      steps: settings.steps.map((s) => ({ source: "user", ...s })),
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
          : null
    if (patch) after = applyPatch(after, patch, f.key)
  }
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        { projects: facts.inventory.roots, findings, after },
        null,
        2
      )
    )
  } else {
    console.log(`\n${workspace} — analyzed in ${Date.now() - started} ms`)
    console.log(
      `Projects: ${facts.inventory.roots.map((r) => `${r.dir || "."} (${r.ecosystems.join(", ")})`).join("; ") || "none"}\n`
    )
    for (const f of findings) {
      const mark =
        f.status === "resolved"
          ? "✓"
          : f.status === "dismissed"
            ? "–"
            : f.severity === "blocker"
              ? "⛔"
              : f.severity === "warning"
                ? "⚠"
                : "ℹ"
      console.log(
        `${mark} [${f.category}] ${f.title}${f.confidence !== "verified" ? ` (${f.confidence})` : ""}${f.resolution ? ` — ${f.resolution}` : ""}`
      )
      if (f.status === "open") {
        console.log(`    ${f.explanation}`)
        console.log(`    fix: ${f.fix.summary}`)
      }
    }
    console.log("\nAfter Apply all (settings fixes only):")
    console.log(
      `  links: ${after.worktreeSetup.linkPaths.join(", ") || "none"}`
    )
    for (const s of after.worktreeSetup.steps)
      console.log(`  step:  ${s.cwd ? `(${s.cwd}) ` : ""}${s.command}`)
    for (const r of after.generatedFiles)
      console.log(`  regen: ${r.paths.join(", ")} ← ${r.command}`)
    if (fromDb) {
      const missing = [
        ...settings.linkPaths
          .filter(
            (p) =>
              !findings.some((f) => JSON.stringify(f.fix).includes(`"${p}"`))
          )
          .map((p) => `link ${p}`),
        ...settings.steps
          .filter(
            (s) =>
              !findings.some((f) =>
                JSON.stringify(f.fix).includes(JSON.stringify(s.command))
              )
          )
          .map((s) => `step ${s.command}`),
        ...settings.generatedFiles
          .filter(
            (r) =>
              !findings.some((f) =>
                JSON.stringify(f.fix).includes(JSON.stringify(r.command))
              )
          )
          .map((r) => `regen ${r.command}`),
      ]
      console.log(
        missing.length
          ? `\nYour settings the analysis didn't propose (golden gaps):\n  ${missing.join("\n  ")}`
          : "\nEvery hand-written setting was reproduced or confirmed."
      )
    }
  }
} finally {
  await server.close()
}
