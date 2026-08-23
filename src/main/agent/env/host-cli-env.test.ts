import { describe, expect, it } from "vitest"
import { delimiter } from "path"
import { buildHostCliEnv } from "./host-cli-env"

describe("buildHostCliEnv", () => {
  it("keeps the inherited PATH and adds common GUI-missing CLI locations", () => {
    const env = buildHostCliEnv({ PATH: "/custom/bin", HOME: "/Users/alice" })
    const paths = env.PATH!.split(delimiter)

    expect(paths[0]).toBe("/custom/bin")
    expect(paths).toContain("/usr/local/bin")
    expect(paths).toContain("/opt/homebrew/bin")
    expect(paths).toContain("/opt/podman/bin")
    expect(paths).toContain("/Applications/Docker.app/Contents/Resources/bin")
    expect(paths).toContain("/Users/alice/.local/bin")
  })

  it("merges the login shell PATH before fallback locations", () => {
    const env = buildHostCliEnv(
      { PATH: "/gui/bin", HOME: "/Users/alice" },
      ["/shell/bin", "/opt/podman/bin"].join(delimiter)
    )
    const paths = env.PATH!.split(delimiter)

    expect(paths.slice(0, 3)).toEqual([
      "/gui/bin",
      "/shell/bin",
      "/opt/podman/bin",
    ])
  })

  it("deduplicates paths while preserving order", () => {
    const env = buildHostCliEnv(
      {
        PATH: ["/opt/homebrew/bin", "/bin"].join(delimiter),
        HOME: "/Users/alice",
      },
      ["/bin", "/shell/bin"].join(delimiter)
    )
    const paths = env.PATH!.split(delimiter)

    expect(paths.filter((p) => p === "/opt/homebrew/bin")).toHaveLength(1)
    expect(paths.filter((p) => p === "/bin")).toHaveLength(1)
    expect(paths.indexOf("/opt/homebrew/bin")).toBe(0)
    expect(paths.filter((p) => p === "/shell/bin")).toHaveLength(1)
  })
})
