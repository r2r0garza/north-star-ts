import { describe, expect, it } from "vitest"
import { toolEnv } from "./tool-env"

describe("toolEnv", () => {
  it("puts Homebrew and user tool directories ahead of macOS system directories", () => {
    const env = toolEnv(
      { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      "darwin",
      "/Users/me"
    )
    const dirs = env.PATH.split(":")
    expect(dirs.indexOf("/opt/homebrew/bin")).toBeLessThan(
      dirs.indexOf("/usr/bin")
    )
    expect(dirs.indexOf("/Users/me/.local/share/mise/shims")).toBeLessThan(
      dirs.indexOf("/usr/bin")
    )
    expect(dirs.slice(-4)).toEqual(["/usr/bin", "/bin", "/usr/sbin", "/sbin"])
  })

  it("puts the login shell's PATH (nvm, pnpm, …) first", () => {
    const env = toolEnv({ PATH: "/usr/bin:/bin" }, "darwin", "/Users/me", [
      "/Users/me/.nvm/versions/node/v24.21.0/bin",
      "/Users/me/Library/pnpm/bin",
      "/usr/bin",
      "/bin",
    ])
    const dirs = env.PATH.split(":")
    expect(dirs.slice(0, 2)).toEqual([
      "/Users/me/.nvm/versions/node/v24.21.0/bin",
      "/Users/me/Library/pnpm/bin",
    ])
    expect(dirs.filter((d) => d === "/usr/bin")).toHaveLength(1)
    expect(dirs.indexOf("/usr/bin")).toBeGreaterThan(
      dirs.indexOf("/opt/homebrew/bin")
    )
  })

  it("keeps the user's own PATH order in front", () => {
    const env = toolEnv(
      { PATH: "/Users/me/.pyenv/shims:/opt/homebrew/bin:/usr/bin:/bin" },
      "darwin",
      "/Users/me"
    )
    expect(env.PATH.split(":").slice(0, 2)).toEqual([
      "/Users/me/.pyenv/shims",
      "/opt/homebrew/bin",
    ])
    expect(
      env.PATH.split(":").filter((d) => d === "/opt/homebrew/bin")
    ).toHaveLength(1)
  })
})
