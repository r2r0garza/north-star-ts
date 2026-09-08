import { describe, expect, it } from "vitest"
import { delimiter } from "path"
import { buildHostCliEnv, parseProbeOutput } from "./host-cli-env"

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

  it("puts the login shell PATH ahead of the inherited one", () => {
    const env = buildHostCliEnv(
      { PATH: "/gui/bin", HOME: "/Users/alice" },
      { PATH: ["/shell/bin", "/opt/podman/bin"].join(delimiter) }
    )
    const paths = env.PATH!.split(delimiter)

    expect(paths.slice(0, 3)).toEqual([
      "/shell/bin",
      "/opt/podman/bin",
      "/gui/bin",
    ])
  })

  // The GUI PATH always contains /usr/bin, so appending the login shell PATH
  // silently resolved every tool that also ships with macOS to the system copy.
  it("prefers a login shell tool over a system-wide twin", () => {
    const env = buildHostCliEnv(
      { PATH: "/usr/bin", HOME: "/Users/alice" },
      { PATH: ["/opt/python@3.12/bin", "/usr/bin"].join(delimiter) }
    )
    const paths = env.PATH!.split(delimiter)

    expect(paths.indexOf("/opt/python@3.12/bin")).toBeLessThan(
      paths.indexOf("/usr/bin")
    )
  })

  it("deduplicates paths while preserving order", () => {
    const env = buildHostCliEnv(
      {
        PATH: ["/opt/homebrew/bin", "/bin"].join(delimiter),
        HOME: "/Users/alice",
      },
      { PATH: ["/bin", "/shell/bin"].join(delimiter) }
    )
    const paths = env.PATH!.split(delimiter)

    expect(paths.filter((p) => p === "/opt/homebrew/bin")).toHaveLength(1)
    expect(paths.filter((p) => p === "/bin")).toHaveLength(1)
    expect(paths.filter((p) => p === "/shell/bin")).toHaveLength(1)
    expect(paths.slice(0, 3)).toEqual([
      "/bin",
      "/shell/bin",
      "/opt/homebrew/bin",
    ])
  })

  it("carries login shell variables beyond PATH", () => {
    const env = buildHostCliEnv(
      { PATH: "/gui/bin", HOME: "/Users/alice" },
      {
        PATH: "/shell/bin",
        PNPM_HOME: "/Users/alice/Library/pnpm",
        NVM_DIR: "/Users/alice/.nvm",
        JAVA_HOME: "/opt/jdk",
      }
    )

    expect(env.PNPM_HOME).toBe("/Users/alice/Library/pnpm")
    expect(env.NVM_DIR).toBe("/Users/alice/.nvm")
    expect(env.JAVA_HOME).toBe("/opt/jdk")
  })

  it("lets the login shell win over the inherited value", () => {
    const env = buildHostCliEnv(
      { PATH: "/gui/bin", LANG: "C" },
      { LANG: "en_US.UTF-8" }
    )

    expect(env.LANG).toBe("en_US.UTF-8")
  })

  it("preserves inherited variables the login shell does not define", () => {
    const env = buildHostCliEnv(
      { PATH: "/gui/bin", ELECTRON_INTERNAL: "keep" },
      { PATH: "/shell/bin" }
    )

    expect(env.ELECTRON_INTERNAL).toBe("keep")
  })

  it("ignores login shell bookkeeping variables", () => {
    const env = buildHostCliEnv(
      { PATH: "/gui/bin", PWD: "/app", TMPDIR: "/app/tmp", TERM: "dumb" },
      { PWD: "/Users/alice", OLDPWD: "/tmp", SHLVL: "3", TMPDIR: "/shell/tmp" }
    )

    expect(env.PWD).toBe("/app")
    expect(env.TMPDIR).toBe("/app/tmp")
    expect(env.TERM).toBe("dumb")
    expect(env.OLDPWD).toBeUndefined()
    expect(env.SHLVL).toBeUndefined()
  })

  it("degrades to the inherited environment plus fallbacks with no probe result", () => {
    const env = buildHostCliEnv(
      { PATH: "/gui/bin", HOME: "/Users/alice" },
      null
    )
    const paths = env.PATH!.split(delimiter)

    expect(paths[0]).toBe("/gui/bin")
    expect(paths).toContain("/opt/homebrew/bin")
  })
})

describe("parseProbeOutput", () => {
  const framed = (body: string) =>
    `__NS_HOST_ENV_BEGIN__${body}__NS_HOST_ENV_END__`

  it("reads null-delimited variables between the sentinels", () => {
    const parsed = parseProbeOutput(
      framed("PATH=/shell/bin\0HOME=/Users/alice")
    )

    expect(parsed).toEqual({ PATH: "/shell/bin", HOME: "/Users/alice" })
  })

  it("discards rc-file banner output printed around the payload", () => {
    const parsed = parseProbeOutput(
      `Welcome to your shell!\n${framed("PATH=/shell/bin")}\nnvm: revision 1`
    )

    expect(parsed).toEqual({ PATH: "/shell/bin" })
  })

  it("keeps values containing newlines and equals signs", () => {
    const parsed = parseProbeOutput(
      framed("MULTI=one\ntwo\0EQUALS=a=b=c\0EMPTY=")
    )

    expect(parsed?.MULTI).toBe("one\ntwo")
    expect(parsed?.EQUALS).toBe("a=b=c")
    expect(parsed?.EMPTY).toBe("")
  })

  it("rejects truncated output whose end sentinel never arrived", () => {
    expect(parseProbeOutput("__NS_HOST_ENV_BEGIN__PATH=/shell/bin")).toBeNull()
  })

  it("rejects output with no sentinels at all", () => {
    expect(parseProbeOutput("command not found: env")).toBeNull()
  })
})
