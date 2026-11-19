import { describe, expect, it, vi } from "vitest"
import { kanbanOpenRepoTool } from "./kanban_open_repo"

describe("kanban_open_repo", () => {
  it("is unavailable outside a board card in a folder of repos", async () => {
    const out = await kanbanOpenRepoTool.execute(
      { repo: "backend" },
      { workspace: "/w" }
    )
    expect(out).toContain("unavailable")
  })

  it("opens the repo through the board and reports its errors", async () => {
    const open = vi
      .fn()
      .mockResolvedValueOnce({
        path: "/card/backend",
        branch: "b",
        base: "HEAD",
        links: ["[ -e x ] || ln -s y x"],
      })
      .mockRejectedValueOnce(new Error("not one of the workspace's repos"))
    const ctx = { workspace: "/card", kanbanOpenRepo: open }
    expect(
      JSON.parse(
        await kanbanOpenRepoTool.execute(
          { repo: " backend ", base: "dev" },
          ctx
        )
      )
    ).toMatchObject({
      path: "/card/backend",
      branch: "b",
      linkDependencies: ["[ -e x ] || ln -s y x"],
    })
    expect(open).toHaveBeenCalledWith("backend", "dev")
    expect(await kanbanOpenRepoTool.execute({ repo: "x" }, ctx)).toContain(
      "not one of the workspace's repos"
    )
    expect(await kanbanOpenRepoTool.execute({}, ctx)).toContain("bad_args")
  })
})
