import { describe, expect, it } from "vitest"
import { bashBlockCommand } from "./bash-block"

describe("clicked Bash block", () => {
  it("extracts the exact multiline script at its Markdown source offset", async () => {
    const content =
      "Example:\n\n```ts\nignore()\n```\n\n```bash\nprintf 'out\\n'\nprintf 'err\\n' >&2\n```"
    await expect(
      bashBlockCommand(content, content.indexOf("```bash"))
    ).resolves.toBe("printf 'out\\n'\nprintf 'err\\n' >&2\n")
  })
  it("uses Markdown parsing for nested block quotes", async () => {
    const content = "> ```bash\n> echo nested\n> ```"
    await expect(bashBlockCommand(content, 2)).resolves.toBe("echo nested\n")
  })
  it.each([
    "```sh\necho no\n```",
    "```bash\n  \n```",
    "'''bash\necho no\n'''",
    "    echo no",
  ])("rejects non-Bash or empty blocks: %s", async (content) => {
    await expect(bashBlockCommand(content, 0)).rejects.toThrow(
      "no longer available"
    )
  })
  it("rejects an offset pointing inside a block", async () => {
    await expect(bashBlockCommand("```bash\necho no\n```", 8)).rejects.toThrow(
      "no longer available"
    )
  })
})
