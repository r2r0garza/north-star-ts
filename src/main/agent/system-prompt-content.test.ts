import { readFile } from "fs/promises"
import path from "path"
import { describe, expect, it } from "vitest"

const promptsDir = path.resolve(process.cwd(), "prompts")

async function readPrompt(name: string): Promise<string> {
  return readFile(path.join(promptsDir, name), "utf-8")
}

describe("shipped mode prompt content", () => {
  it.each(["interactive-system-prompt.md", "north-star-system-prompt.md"])(
    "%s grounds workspace orientation in the advisory index",
    async (name) => {
      const prompt = await readPrompt(name)

      expect(prompt).toContain("When `index_query_tool` is available")
      expect(prompt).toContain("before broad searches or manual walks")
      expect(prompt).toContain(
        "Follow a useful hit with targeted reads instead of repeating discovery"
      )
      expect(prompt).toContain(
        "try a more precise symbol or path query when appropriate"
      )
      expect(prompt).toContain(
        "use a narrowly scoped full-text search if needed"
      )
      expect(prompt).toContain('a miss means "not indexed yet," not "absent."')
    }
  )

  it("keeps Chat mode free of workspace-index guidance", async () => {
    const prompt = await readPrompt("chat-system-prompt.md")

    expect(prompt).not.toContain("index_query_tool")
    expect(prompt).not.toContain("workspace index")
  })
})
