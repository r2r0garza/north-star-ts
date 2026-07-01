import { readFile } from "fs/promises"
import { join } from "path"
import { load as parseYaml } from "js-yaml"

// Stage 2 parses a small, high-value set of workspace docs into index_metadata.
// Each descriptor names the file(s) to look for and how to turn one into a JSON
// value. `kind` is the index_metadata.kind key (one row per kind).
export interface MetadataDoc {
  kind: string
  // Candidate relative paths, tried in order; first that exists wins.
  candidates: string[]
  parse: (raw: string) => unknown
}

const asJson = (raw: string): unknown => JSON.parse(raw)
// README is stored as a short excerpt, not the whole file.
const asReadmeExcerpt = (raw: string): unknown => ({
  excerpt: raw.slice(0, 2000),
  bytes: raw.length,
})

export const METADATA_FILES: MetadataDoc[] = [
  { kind: "package_json", candidates: ["package.json"], parse: asJson },
  {
    kind: "tsconfig",
    candidates: ["tsconfig.json", "tsconfig.base.json"],
    parse: asJson,
  },
  {
    kind: "pnpm_workspace",
    candidates: ["pnpm-workspace.yaml"],
    parse: (raw) => parseYaml(raw) ?? {},
  },
  {
    kind: "readme",
    candidates: ["README.md", "README.MD", "readme.md", "README"],
    parse: asReadmeExcerpt,
  },
]

// vite config comes in several extensions; handled specially (presence + name).
const VITE_CANDIDATES = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "electron.vite.config.ts",
]

export interface ParsedMetadata {
  path: string
  value: unknown
}

// Parse one metadata doc from the workspace root. Returns null if no candidate
// exists or parsing fails (a malformed config shouldn't fail the whole stage).
export async function parseMetadataDoc(
  root: string,
  doc: MetadataDoc
): Promise<ParsedMetadata | null> {
  for (const rel of doc.candidates) {
    try {
      const raw = await readFile(join(root, rel), "utf8")
      return { path: rel, value: doc.parse(raw) }
    } catch {
      // Missing or unparseable — try the next candidate.
    }
  }
  return null
}

// Detect the vite/electron-vite config by presence (contents aren't parsed —
// they're JS, not data). Records which config file exists as a framework hint.
export async function detectViteConfig(root: string): Promise<ParsedMetadata | null> {
  for (const rel of VITE_CANDIDATES) {
    try {
      await readFile(join(root, rel), "utf8")
      return { path: rel, value: { present: true, config: rel } }
    } catch {
      // try next
    }
  }
  return null
}

// Read the current git branch from .git/HEAD without shelling out. A symbolic ref
// ("ref: refs/heads/main") yields the branch name; a detached HEAD yields the
// short SHA. Returns null when there's no git repo.
export async function readGitBranch(root: string): Promise<ParsedMetadata | null> {
  try {
    const head = (await readFile(join(root, ".git", "HEAD"), "utf8")).trim()
    if (head.startsWith("ref:")) {
      const ref = head.slice(4).trim()
      const branch = ref.replace(/^refs\/heads\//, "")
      return { path: ".git/HEAD", value: { branch, ref } }
    }
    return { path: ".git/HEAD", value: { detached: true, sha: head.slice(0, 12) } }
  } catch {
    return null
  }
}
