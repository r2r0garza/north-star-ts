// Dev-only: compare two scenario scorecards (plan 112.2) and print what moved
// per scenario — the acceptance evidence for 112.3–112.5. Exits 1 when a
// scenario regressed or is mixed (better on one signal, worse on another).
//
//   node scripts/compare-scorecards.mjs <before.json> <after.json> [--json]
//
// e.g. node scripts/compare-scorecards.mjs \
//        .plan/112-scorecard/2026-10-13-live-baseline.json \
//        .plan/112-scorecard/<date>-live-recipes.json

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"

const args = process.argv.slice(2)
const files = args.filter((a) => !a.startsWith("--"))
if (files.length !== 2 || !files.every((f) => existsSync(f))) {
  console.error(
    "Usage: node scripts/compare-scorecards.mjs <before.json> <after.json> [--json]"
  )
  process.exit(1)
}
const [before, after] = files.map((f) => JSON.parse(readFileSync(f, "utf8")))
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const server = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
})
try {
  const { compareScorecards, formatComparison } = await server.ssrLoadModule(
    path.join(root, "src/main/mission-control/scenarios/scorecard.ts")
  )
  const comparison = compareScorecards(before, after)
  console.log(
    args.includes("--json")
      ? JSON.stringify(comparison, null, 2)
      : formatComparison(comparison)
  )
  process.exitCode =
    comparison.regressed.length || comparison.mixed.length ? 1 : 0
} finally {
  await server.close()
}
