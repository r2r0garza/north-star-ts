import { readFile, realpath, stat } from "fs/promises"
import { extname, isAbsolute, join, relative, resolve } from "path"

// Where Mission Control seats save evidence (plan 109.04): app data, one
// directory per phase run, never the user's repo. Set once from main/index.ts
// (it needs app.getPath); tests point it at a temp dir. With no root, no
// evidence exists, so proofs that need it can't be accepted.

let root: string | null = null

export function setEvidenceRoot(dir: string | null): void {
  root = dir
}

export function evidenceDir(phaseRunId: string): string | null {
  return root ? join(root, phaseRunId) : null
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

async function realFile(path: string): Promise<string | null> {
  try {
    const real = await realpath(path)
    return (await stat(real)).isFile() ? real : null
  } catch {
    return null
  }
}

// The cited artifacts that are files in a phase run's evidence directory
// (plan 109.05). A path may be absolute, as the tools return it, or relative
// to that directory. Symlinks out of it don't count.
export async function savedEvidence(
  phaseRunId: string,
  paths: string[]
): Promise<Set<string>> {
  const dir = evidenceDir(phaseRunId)
  const found = new Set<string>()
  if (!dir || !paths.length) return found
  let realDir: string
  try {
    realDir = await realpath(dir)
  } catch {
    return found
  }
  for (const path of paths) {
    const file = await realFile(resolve(dir, path))
    if (file && inside(realDir, file)) found.add(path)
  }
  return found
}

const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

// The real path of a saved evidence file, or null for anything outside the
// evidence root.
export async function locateEvidence(path: string): Promise<string | null> {
  if (!root || !isAbsolute(path)) return null
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    return null
  }
  const file = await realFile(path)
  return file && inside(realRoot, file) ? file : null
}

// A saved evidence file for the proof view: an image as a data URL, anything
// else as just its path.
export async function readEvidence(
  path: string
): Promise<{ path: string; dataUrl: string | null } | null> {
  const file = await locateEvidence(path)
  if (!file) return null
  const type = IMAGE_TYPES[extname(file).toLowerCase()]
  if (!type) return { path: file, dataUrl: null }
  const data = await readFile(file)
  return {
    path: file,
    dataUrl: `data:${type};base64,${data.toString("base64")}`,
  }
}
