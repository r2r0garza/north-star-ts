import { describe, expect, it } from "vitest"
import {
  asDependencyLinks,
  asFilter,
  cardNeedsAttention,
  compileIntakeQuery,
  fillCommand,
  fillInstructions,
  matchesFilter,
  matchesPromoteGate,
  mergeAgentColumns,
  placeholderProblem,
  COMMAND_PLACEHOLDERS,
  INSTRUCTION_PLACEHOLDERS,
  normalizeItems,
  resolveIntakeCall,
  wipLimitProblem,
  type KanbanColumn,
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

describe("asDependencyLinks", () => {
  it("keeps relative paths inside the workspace, cleaned and deduped", () => {
    expect(
      asDependencyLinks([
        " ./apps/web/node_modules/ ",
        "apps\\web\\node_modules",
        "/etc",
        "C:/x",
        "../up",
        "a/../b",
        "a//b",
        "",
        7,
      ])
    ).toEqual(["apps/web/node_modules"])
    expect(asDependencyLinks([])).toEqual([])
    expect(asDependencyLinks(null)).toBeNull()
  })
})

describe("cardNeedsAttention", () => {
  it.each(["waiting", "blocked", "failed"] as const)(
    "flags %s cards",
    (runState) => {
      expect(cardNeedsAttention({ runState })).toBe(true)
    }
  )
  it.each(["idle", "running", "done"] as const)(
    "does not flag %s cards without approvals",
    (runState) => {
      expect(cardNeedsAttention({ runState })).toBe(false)
    }
  )
  it("flags running cards waiting on a tool approval", () => {
    expect(
      cardNeedsAttention({
        runState: "running",
        pendingApproval: {
          requestId: "r",
          tool: "exec_command",
          summary: "Run command",
          reason: "Approval required",
        },
      })
    ).toBe(true)
  })
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

  it.each([
    [
      "https://org.visualstudio.com/_apis/wit/workItems/42",
      "My Project",
      "https://org.visualstudio.com/My%20Project/_workitems/edit/42",
    ],
    [
      "https://dev.azure.com/org/_apis/wit/workItems/42?api-version=7.1",
      "My Project",
      "https://dev.azure.com/org/My%20Project/_workitems/edit/42",
    ],
    [
      "https://org.visualstudio.com/Project/_apis/wit/workItems/42",
      undefined,
      "https://org.visualstudio.com/Project/_workitems/edit/42",
    ],
    [
      "https://dev.azure.com/org/Project/_apis/wit/workItems/42",
      undefined,
      "https://dev.azure.com/org/Project/_workitems/edit/42",
    ],
    [
      "https://org.visualstudio.com/_apis/wit/workItems/42",
      undefined,
      "https://org.visualstudio.com/_workitems/edit/42",
    ],
    [
      "https://org.visualstudio.com/Project/_workitems/edit/42",
      "Other",
      "https://org.visualstudio.com/Project/_workitems/edit/42",
    ],
    [
      "https://example.com/_apis/wit/workItems/42",
      "Project",
      "https://example.com/_apis/wit/workItems/42",
    ],
  ])("maps work item URL %s to its browser page", (url, project, expected) => {
    const [i] = normalizeItems(
      [
        {
          id: 42,
          url,
          fields: { "System.Title": "Item", "System.TeamProject": project },
        },
      ],
      { ...ado, fields: { ...ado.fields, url: "url" } }
    )
    expect(i.url).toBe(expected)
  })

  it("prefers ADO's HTML link over its REST API URL", () => {
    const [i] = normalizeItems(
      [
        {
          id: 42,
          url: "https://org.visualstudio.com/_apis/wit/workItems/42",
          fields: { "System.Title": "Item" },
          _links: {
            html: {
              href: "https://org.visualstudio.com/Project/_workitems/edit/42",
            },
          },
        },
      ],
      { ...ado, fields: { ...ado.fields, url: "url" } }
    )
    expect(i.url).toBe(
      "https://org.visualstudio.com/Project/_workitems/edit/42"
    )
  })

  it("rejects unsafe ADO HTML links and builds the browser URL instead", () => {
    const [i] = normalizeItems(
      [
        {
          id: 42,
          url: "https://org.visualstudio.com/_apis/wit/workItems/42",
          fields: { "System.Title": "Item", "System.TeamProject": "Project" },
          _links: { html: { href: "javascript:alert(1)" } },
        },
      ],
      { ...ado, fields: { ...ado.fields, url: "url" } }
    )
    expect(i.url).toBe(
      "https://org.visualstudio.com/Project/_workitems/edit/42"
    )
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
      types: [],
      states: [],
    })
  })

  it("checks types and states case-insensitively, failing an item without one", () => {
    const g = asFilter({
      assignee: { mode: "anyone" },
      types: ["Bug"],
      states: ["Ready"],
    })
    expect(matchesFilter(item({ type: "bug", state: "ready" }), g, null)).toBe(
      true
    )
    expect(
      matchesFilter(item({ type: "Feature", state: "Ready" }), g, null)
    ).toBe(false)
    expect(matchesFilter(item({ type: "Bug", state: "New" }), g, null)).toBe(
      false
    )
    expect(matchesFilter(item({ type: null, state: "Ready" }), g, null)).toBe(
      false
    )
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

describe("mergeAgentColumns", () => {
  const column = (name: string, owner: "agent" | "user"): KanbanColumn => ({
    id: name.toLowerCase(),
    boardId: "b",
    name,
    position: 0,
    agentName: null,
    instructions: "",
    gate: "agent",
    owner,
    outcomes: [],
    actions: [],
    command: owner === "user" ? "npm run deploy" : null,
    commandTimeoutMs: null,
    notify: false,
    wipLimit: null,
  })
  const existing = [
    column("Plan", "agent"),
    column("Deploy", "user"),
    column("Review", "agent"),
    column("Sign off", "user"),
  ]

  it("keeps each user column right after the agent column it followed, with its settings", () => {
    const merged = mergeAgentColumns(existing, [
      { name: "Plan" },
      { name: "Build", owner: "user", command: "rm -rf ." },
      { name: "Review" },
    ])
    expect(merged.map((c) => c.name)).toEqual([
      "Plan",
      "Deploy",
      "Build",
      "Review",
      "Sign off",
    ])
    // The agent can't make a user column or give one a command.
    expect(merged[2]).toEqual({ name: "Build", owner: "agent" })
    expect(merged[1]).toMatchObject({
      id: "deploy",
      owner: "user",
      command: "npm run deploy",
    })
  })

  it("falls back to the same count of agent columns when its column was removed", () => {
    expect(
      mergeAgentColumns(existing, [{ name: "Build" }, { name: "Review" }]).map(
        (c) => c.name
      )
    ).toEqual(["Build", "Deploy", "Review", "Sign off"])
  })

  it("keeps user columns when the agent sends fewer columns", () => {
    expect(
      mergeAgentColumns(existing, [{ name: "Plan" }]).map((c) => c.name)
    ).toEqual(["Plan", "Deploy", "Sign off"])
    expect(mergeAgentColumns([], [{ name: "A" }])).toEqual([
      { name: "A", owner: "agent" },
    ])
  })

  it("refuses a name that is one of the user's columns", () => {
    expect(() => mergeAgentColumns(existing, [{ name: "Deploy" }])).toThrow(
      /user's own columns/
    )
  })
})

describe("column placeholders", () => {
  const vars = {
    id: "12346",
    url: "https://dev.azure.com/o/p/_workitems/edit/12346",
    branch: "ns/kanban/b/12346",
    title: "Fix it'; rm -rf / # {{url}}",
  }

  it("fills a command's placeholders shell-quoted, in one pass", () => {
    expect(
      fillCommand(
        "./repo-3/script.sh --ticket-id {{id}} --title {{ title }}",
        vars
      )
    ).toBe(
      `./repo-3/script.sh --ticket-id '12346' --title 'Fix it'\\''; rm -rf / # {{url}}'`
    )
  })

  it("fills instructions as plain text, never with tracker text", () => {
    expect(fillInstructions("Write plan-{{id}}.md on {{branch}}", vars)).toBe(
      "Write plan-12346.md on ns/kanban/b/12346"
    )
    expect(fillInstructions("{{title}}", vars)).toBe("{{title}}")
  })

  it("refuses placeholders a field doesn't allow", () => {
    expect(
      placeholderProblem(
        "plan-{{id}}.md",
        INSTRUCTION_PLACEHOLDERS,
        "the instructions"
      )
    ).toBeNull()
    expect(
      placeholderProblem(
        "{{title}}",
        INSTRUCTION_PLACEHOLDERS,
        "the instructions"
      )
    ).toBe(
      "the instructions uses {{title}}, which isn't available there. Use {{id}}, {{url}}, {{branch}}."
    )
    expect(
      placeholderProblem("x {{ticket}}", COMMAND_PLACEHOLDERS, "the command")
    ).toContain("{{ticket}}")
    expect(
      placeholderProblem("{ado_item_id}", COMMAND_PLACEHOLDERS, "x")
    ).toBeNull()
  })
})

describe("intake types and states", () => {
  const f = asFilter({
    assignee: { mode: "anyone" },
    types: ["Bug"],
    states: ["Ready", "Active"],
  })

  it("GitHub: issue types in the query; states only re-checked locally", () => {
    expect(compileIntakeQuery(f, "github")).toBe('is:issue is:open type:"Bug"')
  })

  it("Jira: issuetype and status in, replacing the default Done exclusion", () => {
    expect(compileIntakeQuery(f, "jira")).toBe(
      'issuetype in ("Bug") AND status in ("Ready", "Active")'
    )
  })

  it("ADO: work item type and state IN, replacing the default state exclusion", () => {
    const q = compileIntakeQuery(f, "ado")
    expect(q).toContain("[System.WorkItemType] IN ('Bug')")
    expect(q).toContain("[System.State] IN ('Ready', 'Active')")
    expect(q).not.toContain("NOT IN")
  })
})

describe("matchesPromoteGate", () => {
  it("is off when empty, and needs each filled-in list to match", () => {
    const ready = item({ state: "Ready", tags: ["agent-go"] })
    expect(matchesPromoteGate(ready, { states: [], tags: [] })).toBe(false)
    expect(matchesPromoteGate(ready, { states: ["ready"], tags: [] })).toBe(
      true
    )
    expect(
      matchesPromoteGate(ready, { states: [], tags: ["go", "Agent-Go"] })
    ).toBe(true)
    expect(matchesPromoteGate(ready, { states: ["Ready"], tags: ["go"] })).toBe(
      false
    )
    expect(
      matchesPromoteGate(item({ state: null }), { states: ["Ready"], tags: [] })
    ).toBe(false)
  })
})

describe("wipLimitProblem", () => {
  it("accepts empty or 1–4 and refuses anything else", () => {
    expect(wipLimitProblem(null)).toBeNull()
    expect(wipLimitProblem(1)).toBeNull()
    expect(wipLimitProblem(4)).toBeNull()
    for (const bad of [0, 5, 2.5, "3"])
      expect(wipLimitProblem(bad)).toMatch(/1–4/)
  })
})

describe("custom field rules", () => {
  const f = asFilter({
    assignee: { mode: "anyone" },
    fields: [
      { field: "Custom.QAAssigned", values: ["Ana Ruiz", "Bo"] },
      { field: "", values: ["dropped"] },
      { field: "Empty", values: [] },
    ],
  })

  it("keeps only rules with a field and values", () => {
    expect(f.fields).toEqual([
      { field: "Custom.QAAssigned", values: ["Ana Ruiz", "Bo"] },
    ])
    expect(asFilter({}).fields).toBeUndefined()
  })

  it("ADO: selects and filters the field; refuses a non-reference name", () => {
    const q = compileIntakeQuery(f, "ado")
    expect(q).toContain(", [Custom.QAAssigned] FROM WorkItems")
    expect(q).toContain("[Custom.QAAssigned] IN ('Ana Ruiz', 'Bo')")
    expect(() =>
      compileIntakeQuery(
        asFilter({ fields: [{ field: "X] = 1 OR [Y", values: ["a"] }] }),
        "ado"
      )
    ).toThrow(/field reference/)
  })

  it("Jira: quotes names, keeps cf[n] bare; GitHub refuses", () => {
    expect(
      compileIntakeQuery(
        asFilter({
          assignee: { mode: "anyone" },
          fields: [
            { field: 'QA "Assigned"', values: ["Ana"] },
            { field: "cf[10042]", values: ["x"] },
          ],
        }),
        "jira"
      )
    ).toBe(
      '"QA \\"Assigned\\"" in ("Ana") AND cf[10042] in ("x") AND statusCategory != Done'
    )
    expect(() => compileIntakeQuery(f, "github")).toThrow(/custom fields/)
  })

  it("maps custom values and re-checks them locally", () => {
    const [i] = normalizeItems(
      [
        {
          id: 3,
          fields: {
            "System.Title": "T",
            "Custom.QAAssigned": { displayName: "ana ruiz" },
          },
        },
      ],
      {
        command: "x",
        fields: {
          id: "id",
          title: ["fields", "System.Title"],
          custom: {
            "Custom.QAAssigned": ["fields", "Custom.QAAssigned", "displayName"],
          },
        },
      }
    )
    expect(i.custom).toEqual({ "Custom.QAAssigned": ["ana ruiz"] })
    expect(matchesFilter(i, f, null)).toBe(true)
    expect(matchesFilter(item({}), f, null)).toBe(false)
    expect(
      matchesPromoteGate(i, { states: [], tags: [], fields: f.fields })
    ).toBe(true)
    expect(
      matchesPromoteGate(i, {
        states: [],
        tags: [],
        fields: [{ field: "Custom.QAAssigned", values: ["Bo"] }],
      })
    ).toBe(false)
  })
})
