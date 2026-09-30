import path from "path"
import type { FindingDraft } from "./draft"
import type { IgnoredEntry } from "./ignored"
import type { ProjectRoot, Reader } from "./inventory"

// SQL and databases (plan 106.11): not an install step but a coordination
// risk for parallel stories. Migration trees that number sequentially collide
// when two stories each add one; one shared dev database makes stories that
// migrate interfere; an ignored SQLite file is missing in every worktree.

export async function databaseFindings(input: {
  tracked: string[]
  roots: ProjectRoot[]
  ignored: IgnoredEntry[]
  read: Reader
}): Promise<FindingDraft[]> {
  const out: FindingDraft[] = []
  const { tracked } = input

  // Sequentially numbered migrations.
  const sequential: Array<{
    tool: string
    dir: string
    sample: string
    resolve: string[]
  }> = []
  const django = tracked.filter((f) =>
    /(^|\/)migrations\/\d{4}_[\w]+\.py$/.test(f)
  )
  if (django.length)
    sequential.push({
      tool: "Django",
      dir: path.posix.dirname(django[0]),
      sample: django[0],
      resolve: [
        "When two stories add a migration to the same app, run `python manage.py makemigrations --merge` after merging, then commit the merge migration.",
      ],
    })
  const alembic = tracked.filter((f) =>
    /(^|\/)(alembic|migrations)\/versions\/[\w]+\.py$/.test(f)
  )
  if (alembic.length && tracked.some((f) => /(^|\/)alembic\.ini$/.test(f)))
    sequential.push({
      tool: "Alembic",
      dir: path.posix.dirname(alembic[0]),
      sample: alembic[0],
      resolve: [
        'Two stories that each add a revision leave Alembic with two heads. After merging, run `alembic merge heads -m "merge"` and commit it.',
      ],
    })
  const flyway = tracked.filter((f) =>
    /(^|\/)V\d+(_\d+)*__[\w-]+\.sql$/.test(f)
  )
  if (flyway.length)
    sequential.push({
      tool: "Flyway",
      dir: path.posix.dirname(flyway[0]),
      sample: flyway[0],
      resolve: [
        "Two stories that pick the same next version (V42__…) collide. Renumber the later one after merging, or switch to timestamp versions (V20240101120000__…).",
      ],
    })
  const numbered = tracked.filter((f) =>
    /(^|\/)(migrations|migrate|db)\/\d{1,6}_[\w-]+\.(up\.)?sql$/.test(f)
  )
  if (numbered.length)
    sequential.push({
      tool: "SQL migrations",
      dir: path.posix.dirname(numbered[0]),
      sample: numbered[0],
      resolve: [
        "Numbered migrations collide when two stories each add the next number. Renumber the later one after merging, or use timestamp prefixes.",
      ],
    })
  const drizzle = tracked.filter((f) => /(^|\/)meta\/_journal\.json$/.test(f))
  if (drizzle.length)
    sequential.push({
      tool: "Drizzle",
      dir: path.posix.dirname(path.posix.dirname(drizzle[0])),
      sample: drizzle[0],
      resolve: [
        "Drizzle's migration journal conflicts when two stories generate migrations. After merging, keep one side and re-run `drizzle-kit generate` for the other story's schema change.",
      ],
    })
  const efSnapshots = tracked.filter((f) => /ModelSnapshot\.cs$/.test(f))
  if (efSnapshots.length)
    sequential.push({
      tool: "EF Core",
      dir: path.posix.dirname(efSnapshots[0]),
      sample: efSnapshots[0],
      resolve: [
        "The EF Core model snapshot conflicts when two stories add migrations. After merging, remove the later migration (`dotnet ef migrations remove`) and add it again so the snapshot includes both.",
      ],
    })
  for (const s of sequential)
    out.push({
      key: `database:migrations:${s.dir}`,
      category: "database",
      severity: "info",
      title: `${s.tool} migrations can collide between parallel stories`,
      explanation: `Migrations in ${s.dir} are ordered by a sequence, so two stories that each add one produce conflicting or branching migrations. Mission Control can't regenerate these; the steps below resolve it after a merge.`,
      evidence: [
        {
          kind: "file",
          label: `${s.tool} migration, e.g. ${s.sample}`,
          path: s.sample,
        },
      ],
      confidence: "verified",
      source: "rule",
      fix: {
        kind: "manual",
        summary: "Resolve after merging",
        steps: s.resolve,
      },
    })

  // An ignored SQLite database: every worktree lacks it.
  for (const entry of input.ignored.filter((e) => e.class === "database")) {
    const root = input.roots.find((r) => r.dir === entry.root)
    const prepare = root ? migrateCommand(root, input.tracked) : null
    out.push({
      key: `database:sqlite:${entry.path}`,
      category: "database",
      severity: "warning",
      title: `Worktrees won't have ${path.posix.basename(entry.path)}`,
      explanation: `${entry.path} is an ignored local database. A fresh worktree doesn't have it, and linking it would make parallel stories share (and corrupt) one database. Give each worktree its own${prepare ? " by running migrations there" : ""}.`,
      evidence: [
        {
          kind: "file",
          label: `${entry.path} exists and is ignored`,
          path: entry.path,
        },
      ],
      confidence: prepare ? "likely" : "verified",
      source: "rule",
      root: entry.root,
      fix: prepare
        ? {
            kind: "apply-settings",
            summary: `Create a fresh database in each worktree: ${prepare}`,
            patch: {
              worktreeSetupSteps: {
                add: [
                  {
                    id: `analysis:database:${entry.path}`,
                    label: "Prepare the local database",
                    command: prepare,
                    cwd: entry.root,
                  },
                ],
              },
            },
          }
        : {
            kind: "manual",
            summary: "Create a database per worktree",
            steps: [
              `Add a worktree setup step that creates ${entry.path} (for example by running the project's migrations).`,
              "Don't link the database file into worktrees.",
            ],
          },
    })
  }

  // A database service from Compose, shared by every worktree.
  for (const file of tracked
    .filter((f) => /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(f))
    .slice(0, 4)) {
    const text = (await input.read(file)) ?? ""
    const image =
      /image:\s*["']?((?:postgres|postgis\/postgis|mysql|mariadb|mongo|mcr\.microsoft\.com\/mssql[^\s"']*|redis)[^\s"']*)/i.exec(
        text
      )?.[1]
    if (!image || /^redis/i.test(image)) continue
    out.push({
      key: `database:shared:${file}`,
      category: "database",
      severity: "warning",
      title: "Parallel stories would share one development database",
      explanation: `${file} runs ${image}. Every worktree connects to the same database, so stories that run migrations or reset data interfere with each other. North Star never starts databases or containers itself.`,
      evidence: [
        {
          kind: "file",
          label: `${file} defines a ${image.split(/[:@]/)[0]} service`,
          path: file,
        },
      ],
      confidence: "likely",
      source: "rule",
      fix: {
        kind: "manual",
        summary: "Isolate or serialize database work",
        steps: [
          `Start the database yourself (docker compose -f ${file} up -d) before starting the Feature.`,
          "If the framework reads the database name from an environment variable, add a worktree setup step that points each worktree at its own database.",
          "Otherwise keep overlapping stories running one at a time (Advanced settings → Overlapping stories: Wait) for stories that touch migrations.",
        ],
      },
    })
    break
  }
  return out
}

// The framework command that creates a local database from migrations.
function migrateCommand(root: ProjectRoot, tracked: string[]): string | null {
  const at = (f: string) => path.posix.join(root.dir, f)
  if (tracked.includes(at("manage.py"))) {
    const python = root.ecosystems.includes("uv")
      ? "uv run python"
      : root.ecosystems.includes("poetry")
        ? "poetry run python"
        : ".venv/bin/python"
    return `${python} manage.py migrate`
  }
  if (tracked.includes(at("bin/rails"))) return "bin/rails db:prepare"
  if (tracked.includes(at("artisan"))) return "php artisan migrate --force"
  if (tracked.some((f) => f.startsWith(at("prisma/migrations/"))))
    return "npx prisma migrate deploy"
  return null
}
