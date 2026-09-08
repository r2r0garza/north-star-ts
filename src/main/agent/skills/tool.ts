import { opendir } from "fs/promises"
import { dirname, join, relative } from "path"
import { TOOL_EFFECTS, type Tool } from "../tools/types"
import { registerSkillResourceRoot } from "../tools/skill_resources"
import type { SkillMetadata } from "./types"
import { renderContextEnvelope } from "../context/provenance"

const MAX_MANIFEST_ENTRIES = 200
const MAX_MANIFEST_BYTES = 16 * 1024

// Builds a read_skill tool scoped to the given skills. Taking a name (not a
// path) keeps the model from fumbling path resolution or wandering the
// filesystem — the body is returned from memory, loaded eagerly at startup.
export function createReadSkillTool(skills: SkillMetadata[]): Tool {
  const index = new Map(skills.map((s) => [s.name, s]))
  return {
    effects: TOOL_EFFECTS.readOnlySequential,
    definition: {
      type: "function",
      function: {
        name: "read_skill",
        description:
          "Read the full instructions (SKILL.md body) for a named skill from the skills library. " +
          "Call this when a skill's description matches the current task.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "The skill's name, exactly as listed in the Skills System section.",
            },
          },
          required: ["name"],
        },
      },
    },
    execute: async (args, ctx) => {
      const name = typeof args.name === "string" ? args.name : ""
      const skill = index.get(name)
      if (!skill) {
        const available = [...index.keys()].join(", ") || "(none)"
        return `No skill named "${name}". Available skills: ${available}`
      }
      const root = dirname(skill.path)
      registerSkillResourceRoot(ctx, { name: skill.name, root })
      const manifest = await bundledResourceManifest(root)
      return renderContextEnvelope(
        {
          trust: "approved_instruction",
          channel: "skill",
          source: skill.name,
          persisted: true,
        },
        [
          skill.body.trimEnd(),
          "",
          "---",
          `Skill resource root: skill://${skill.name}/`,
          "Use this read-only skill:// URI prefix for files bundled beside this SKILL.md. " +
            "Writes, edits, renames, and deletions to skill resources are not allowed.",
          manifest,
        ]
          .filter(Boolean)
          .join("\n")
      )
    },
  }
}

async function bundledResourceManifest(root: string): Promise<string> {
  const entries: string[] = []
  let bytes = 0
  let truncated = false

  async function walk(dir: string): Promise<void> {
    if (truncated) return
    let handle
    try {
      handle = await opendir(dir)
      for await (const entry of handle) {
        if (truncated) break
        const absolute = join(dir, entry.name)
        const rel = relative(root, absolute).split(/[\\/]/).join("/")
        if (rel === "SKILL.md") continue
        const rendered = entry.isDirectory() ? `${rel}/` : rel
        const entryBytes = Buffer.byteLength(rendered, "utf8") + 1
        if (
          entries.length >= MAX_MANIFEST_ENTRIES ||
          bytes + entryBytes > MAX_MANIFEST_BYTES
        ) {
          truncated = true
          break
        }
        entries.push(rendered)
        bytes += entryBytes
        if (entry.isDirectory()) await walk(absolute)
      }
    } catch {
      return
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  await walk(root)
  if (entries.length === 0) return "Bundled resource manifest: (none)"
  const suffix = truncated ? "\n[manifest truncated]" : ""
  return `Bundled resource manifest:\n${entries.sort().join("\n")}${suffix}`
}
