import { app } from "electron"
import { mkdir } from "fs/promises"
import path from "path"
import { dataDirName } from "../../config/system-name"

// The plan document a plan-mode turn writes: ~/.<name>/plans/<conversationId>.md.
// Fixed, server-computed path (never model-supplied), reusing the same
// ~/.<name>/... data-dir convention as userSkillsDir(). Shared by write_plan_tool
// (writes it) and present_plan_tool (reads it back for approval).
export function planFilePath(conversationId: string): string {
  return path.join(
    app.getPath("home"),
    dataDirName(),
    "plans",
    `${conversationId}.md`
  )
}

// Ensure the ~/.<name>/plans directory exists before a write. Mirrors the
// mkdir-recursive pattern used for the skills dir.
export async function ensurePlansDir(conversationId: string): Promise<string> {
  const file = planFilePath(conversationId)
  await mkdir(path.dirname(file), { recursive: true })
  return file
}
