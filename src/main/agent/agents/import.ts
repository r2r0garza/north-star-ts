import { readFile, writeFile } from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { MAX_AGENT_FILE_SIZE, parseAgent, validateName } from "./loader"

// The flat-file suffix for agent definitions. Kept in sync with the loader's
// AGENT_SUFFIX (module-private there); an agent is a single `<name>.agent.md`.
const AGENT_SUFFIX = ".agent.md"

// Import a hand-authored agent from disk into a writable agent root. Unlike a
// skill (a folder), an agent is a single flat file, so there is no zip path and
// no folder-layout normalization. The file is copied VERBATIM (byte-for-byte, no
// serializeAgent round-trip) so a hand-tuned agent's YAML formatting survives.
//
// Validation only GATES the copy — it never rewrites the file. Rejections:
//   - not a `.agent.md` file
//   - too large (DoS guard)
//   - missing valid frontmatter (name + description)
//   - frontmatter `name` !== the file stem (the loader's hard rule)
//   - a collision with an existing agent in the target root
//
// The source filename is preserved (we do NOT rename by frontmatter — that would
// break byte-for-byte identity; the name===stem check guarantees they agree).
// Callers must have already validated that targetRoot is a writable agent root.
export async function importAgentFromMarkdown(
  sourcePath: string,
  targetRoot: string
): Promise<string> {
  const base = path.basename(sourcePath)
  if (!base.endsWith(AGENT_SUFFIX)) {
    throw new Error("Import a .agent.md file.")
  }
  const stem = base.slice(0, -AGENT_SUFFIX.length)

  const content = await readFile(sourcePath, "utf-8")
  if (content.length > MAX_AGENT_FILE_SIZE) {
    throw new Error("Agent file is too large.")
  }

  const parsed = parseAgent(content, sourcePath, stem, targetRoot)
  if (!parsed) {
    throw new Error(
      "The agent file is missing valid frontmatter (name + description)."
    )
  }

  // The hard name===stem reject (parseAgent only warns) — matches how
  // agents:save / agents:create enforce it in index.ts.
  const err = validateName(parsed.name, stem)
  if (err) throw new Error(err)

  const filePath = path.join(targetRoot, base)
  if (existsSync(filePath)) {
    throw new Error(`An agent named '${parsed.name}' already exists here.`)
  }
  await writeFile(filePath, content, "utf-8")
  return filePath
}
