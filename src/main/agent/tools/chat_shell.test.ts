import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { LocalEnvironment } from "../env/local"
import type { ToolAction } from "../approval/types"
import {
  chatScratchDir,
  chatShellContext,
  deleteChatScratchDirs,
} from "./chat_shell"
import { execCommandTool, pollCommandTool } from "./command_session_tools"
import type { ToolContext } from "./types"

const posix = process.platform !== "win32"

let home: string
let skillRoot: string
let originalHome: string | undefined
let gated: ToolAction[]

beforeEach(async () => {
  originalHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "chat-shell-home-"))
  process.env.HOME = home
  skillRoot = await mkdtemp(join(tmpdir(), "chat-shell-skill-"))
  await mkdir(join(skillRoot, "scripts"))
  await writeFile(
    join(skillRoot, "scripts", "echo.sh"),
    'pwd\nfor a in "$@"; do printf "<%s>\\n" "$a"; done\n'
  )
  gated = []
})

afterEach(async () => {
  process.env.HOME = originalHome
  await rm(home, { recursive: true, force: true })
  await rm(skillRoot, { recursive: true, force: true })
})

// A Chat turn's context: no workspace, a LocalEnvironment rooted at "".
function chatCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspace: "",
    conversationId: "conv-1",
    skillResourceRoots: { demo: skillRoot },
    env: new LocalEnvironment(""),
    gate: async (action) => {
      gated.push(action)
      return "approved"
    },
    ...overrides,
  }
}

describe("chatShellContext", () => {
  it("roots the context in the conversation's scratch dir", async () => {
    const ctx = chatCtx()
    const shellCtx = await chatShellContext(ctx)

    expect(shellCtx.workspace).toBe(chatScratchDir("conv-1"))
    await access(shellCtx.workspace)
    expect(shellCtx.env).toBeInstanceOf(LocalEnvironment)
    expect(await shellCtx.env!.resolve("")).toBe(
      await realpath(chatScratchDir("conv-1"))
    )
    // read_skill registrations made later in the turn stay visible.
    expect(shellCtx.skillResourceRoots).toBe(ctx.skillResourceRoots)
  })

  it.skipIf(!posix)(
    "keeps the chat venv overlay on the re-rooted environment",
    async () => {
      const env = new LocalEnvironment("", "host-access", {
        envOverlay: {
          prependPath: ["/venv/bin"],
          vars: { VIRTUAL_ENV: "/venv" },
        },
        hostCliEnv: async () => ({ PATH: "/usr/bin" }),
      })
      const shellCtx = await chatShellContext(chatCtx({ env }))
      const result = await execCommandTool.execute(
        { command: 'printf "%s|%s" "$VIRTUAL_ENV" "$PATH"' },
        shellCtx
      )
      expect(result).toContain("/venv|/venv/bin:/usr/bin")
    }
  )

  it("refuses a conversation id that can't name a directory", async () => {
    await expect(
      chatShellContext(chatCtx({ conversationId: "../x" }))
    ).rejects.toThrow(/no scratch folder/)
    await expect(
      chatShellContext(chatCtx({ conversationId: undefined }))
    ).rejects.toThrow(/no scratch folder/)
  })

  it.skipIf(!posix)(
    "runs a skill script through exec_command in the scratch dir",
    async () => {
      const shellCtx = await chatShellContext(chatCtx())
      const result = await execCommandTool.execute(
        { command: `sh skill://demo/scripts/echo.sh "two words"` },
        shellCtx
      )

      expect(result).toContain(await realpath(chatScratchDir("conv-1")))
      expect(result).toContain("<two words>")
      expect(gated).toHaveLength(1)
      expect(gated[0].tool).toBe("exec_command")
      expect(gated[0].detail?.skillResources).toHaveLength(1)
    }
  )

  it.skipIf(!posix)(
    "lets a later call reach a background session started in the same chat",
    async () => {
      const started = JSON.parse(
        await execCommandTool.execute(
          { command: "sleep 0.2; echo done", background: true },
          await chatShellContext(chatCtx())
        )
      ) as { sessionId: string; cursor: number }

      let polled: Record<string, unknown> = {}
      for (let i = 0; i < 50; i++) {
        polled = JSON.parse(
          await pollCommandTool.execute(
            { session_id: started.sessionId, cursor: started.cursor },
            await chatShellContext(chatCtx())
          )
        ) as Record<string, unknown>
        if (polled.status !== "running") break
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(polled.status).toBe("completed")
      expect(polled.output).toContain("done")
    }
  )
})

describe("deleteChatScratchDirs", () => {
  it("removes scratch dirs and ignores unsafe ids", async () => {
    const dir = chatScratchDir("conv-2")
    await mkdir(dir, { recursive: true })
    await deleteChatScratchDirs(["conv-2", "../..", "missing"])
    await expect(access(dir)).rejects.toThrow()
    await access(home)
  })
})
