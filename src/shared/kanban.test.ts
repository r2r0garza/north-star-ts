import { describe, expect, it } from "vitest"
import {
  asFilter,
  compileIntakeQuery,
  matchesFilter,
  normalizeItems,
  resolveIntakeCall,
  type KanbanItem,
  type KanbanSource,
} from "./kanban"

const github: KanbanSource = {
  command: "gh issue list --json number,title,url,labels,assignees",
  fields: {
    id: "number",
    title: "title",
    url: "url",
    tags: "labels.*.name",
    assignee: "assignees.*.login",
  },
}

const ado: KanbanSource = {
  command: "az boards query -o json",
  fields: {
    id: "id",
    title: ["fields", "System.Title"],
    tags: ["fields", "System.Tags"],
    assignee: ["fields", "System.AssignedTo", "uniqueName"],
    state: ["fields", "System.State"],
  },
  tagSeparator: ";",
}

const item = (patch: Partial<KanbanItem>): KanbanItem => ({
  id: "1",
  url: null,
  title: "t",
  body: "",
  type: null,
  state: null,
  tags: [],
  assignees: [],
  updatedAt: null,
  ...patch,
})

describe("normalizeItems", () => {
  it("maps GitHub issues with wildcard paths", () => {
    const [i] = normalizeItems(
      [
        {
          number: 7,
          title: "Fix it",
          url: "https://github.com/o/r/issues/7",
          labels: [{ name: "agent-go" }, { name: "bug" }],
          assignees: [{ login: "me" }],
        },
      ],
      github
    )
    expect(i).toMatchObject({
      id: "7",
      title: "Fix it",
      url: "https://github.com/o/r/issues/7",
      tags: ["agent-go", "bug"],
      assignees: ["me"],
    })
  })

  it("maps ADO dotted keys and splits tags", () => {
    const [i] = normalizeItems(
      [
        {
          id: 42,
          fields: {
            "System.Title": "Item",
            "System.Tags": "agent-go; backend",
            "System.AssignedTo": { uniqueName: "a@b.c" },
            "System.State": "New",
          },
        },
      ],
      ado
    )
    expect(i).toMatchObject({
      id: "42",
      tags: ["agent-go", "backend"],
      assignees: ["a@b.c"],
      state: "New",
    })
  })

  it("reads itemsPath, drops rows without id/title, rejects non-http urls", () => {
    const items = normalizeItems(
      {
        issues: [
          { number: 1, title: "a", url: "javascript:alert(1)" },
          { title: "no id" },
        ],
      },
      { ...github, itemsPath: "issues" }
    )
    expect(items).toHaveLength(1)
    expect(items[0].url).toBeNull()
  })
})

describe("matchesFilter", () => {
  const f = asFilter({
    tags: ["agent-go", "ready"],
    match: "any",
    excludeTags: ["agent-skip"],
  })

  it("any/all tag match, case-insensitive", () => {
    expect(
      matchesFilter(item({ tags: ["Agent-Go"], assignees: ["me"] }), f, "me")
    ).toBe(true)
    expect(
      matchesFilter(
        item({ tags: ["agent-go"], assignees: ["me"] }),
        { ...f, match: "all" },
        "me"
      )
    ).toBe(false)
  })

  it("drops excluded tags and items whose tag was removed", () => {
    expect(
      matchesFilter(
        item({ tags: ["agent-go", "agent-skip"], assignees: ["me"] }),
        f,
        "me"
      )
    ).toBe(false)
    expect(
      matchesFilter(item({ tags: ["bug"], assignees: ["me"] }), f, "me")
    ).toBe(false)
  })

  it("drops a teammate's item and fails closed without me", () => {
    const mine = item({ tags: ["agent-go"], assignees: ["me"] })
    expect(
      matchesFilter(item({ tags: ["agent-go"], assignees: ["pat"] }), f, "me")
    ).toBe(false)
    expect(matchesFilter(mine, f, null)).toBe(false)
    expect(
      matchesFilter(mine, { ...f, assignee: { mode: "anyone" } }, null)
    ).toBe(true)
  })

  it("asFilter defaults to assigned-to-me", () => {
    expect(asFilter(null)).toEqual({
      tags: [],
      match: "any",
      excludeTags: [],
      assignee: { mode: "me" },
    })
  })
})

describe("compileIntakeQuery", () => {
  const f = asFilter({
    tags: ["agent-go", "needs plan"],
    match: "any",
    excludeTags: ["agent-skip"],
  })

  it("GitHub: OR labels, excluded labels, @me, issues only", () => {
    expect(compileIntakeQuery(f, "github")).toBe(
      'is:issue is:open label:"agent-go","needs plan" -label:"agent-skip" assignee:@me'
    )
    expect(
      compileIntakeQuery(
        { ...f, match: "all", excludeTags: [], assignee: { mode: "anyone" } },
        "github"
      )
    ).toBe('is:issue is:open label:"agent-go" label:"needs plan"')
  })

  it("Jira: labels in, keeps unlabeled when excluding, currentUser()", () => {
    expect(compileIntakeQuery(f, "jira")).toBe(
      'labels in ("agent-go", "needs plan") AND (labels is EMPTY OR labels not in ("agent-skip")) AND assignee = currentUser() AND statusCategory != Done'
    )
    expect(
      compileIntakeQuery(
        { ...f, tags: ['a"b'], match: "all", excludeTags: [] },
        "jira"
      )
    ).toContain('labels = "a\\"b"')
  })

  it("ADO: full WIQL with tag CONTAINS, @Me, quotes doubled", () => {
    const q = compileIntakeQuery(
      { ...f, assignee: { mode: "user", user: "o'neil@x.com" } },
      "ado"
    )
    expect(q).toMatch(/^SELECT \[System.Id\].* FROM WorkItems WHERE /)
    expect(q).toContain(
      "([System.Tags] CONTAINS 'agent-go' OR [System.Tags] CONTAINS 'needs plan')"
    )
    expect(q).toContain("NOT [System.Tags] CONTAINS 'agent-skip'")
    expect(q).toContain("[System.AssignedTo] = 'o''neil@x.com'")
    expect(compileIntakeQuery(f, "ado")).toContain("[System.AssignedTo] = @Me")
  })

  it("raw query overrides compilation", () => {
    expect(compileIntakeQuery(asFilter({ query: "project = X" }), "jira")).toBe(
      "project = X"
    )
  })
})

describe("resolveIntakeCall", () => {
  const f = asFilter({ tags: ["it's"], assignee: { mode: "anyone" } })

  it("binds the query into a command as one shell-quoted argument", () => {
    const call = resolveIntakeCall(
      {
        ...github,
        tracker: "github",
        command: "gh issue list --search {{query}} --json number",
      },
      f
    )
    expect(call.command).toBe(
      `gh issue list --search 'is:issue is:open label:"it'\\''s"' --json number`
    )
  })

  it("binds the query into MCP string args unquoted", () => {
    const call = resolveIntakeCall(
      {
        fields: github.fields,
        tracker: "jira",
        tool: "mcp__atlassian__search",
        args: { jql: "{{query}}", limit: 50 },
      },
      f
    )
    expect(call.args).toEqual({
      jql: `labels in ("it's") AND statusCategory != Done`,
      limit: 50,
    })
  })

  it("needs a tracker or raw query to fill the placeholder", () => {
    expect(() =>
      resolveIntakeCall({ ...github, command: "gh x {{query}}" }, f)
    ).toThrow(/tracker/)
    expect(resolveIntakeCall(github, f).command).toBe(github.command)
  })
})
