import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"
import { getDb } from "../../db/connection"
import * as dashboards from "../../db/repositories/dashboards"

// Author a live dashboard (plan 033.2). The agent fetches data through its
// existing tools (run_shell / web_fetch / MCP) then calls this to SAVE a
// dashboard: a set of widgets (each with a render config + a data-fetch RECIPE
// describing how to re-pull the data) plus the initial data it just fetched.
// Like todo_write, it writes only its own tables, so it does NOT route through
// the approval gate — the *fetching* it did beforehand was already gated by
// those tools. A whole-dashboard replace write (mirrors replaceTodos): the
// widget list sent becomes the dashboard's widgets. Returns the saved shape.
//
// The `recipe` is stored for the deterministic refresh executor (plan 033.3);
// today it's advisory metadata — refresh re-prompts the agent until 033.3 lands.
export const dashboardWriteTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "dashboard_write",
      description:
        "Save a live dashboard: a titled set of widgets that visualize data you have " +
        "already fetched (via run_shell, web_fetch, or other tools). Call this AFTER you " +
        "have pulled the data — pass both the data (so it renders immediately) and a " +
        "`recipe` describing how to re-pull it later.\n\n" +
        "Provide `name` and a `widgets` array. Omit `dashboardId` to create a new " +
        "dashboard; pass an existing `dashboardId` to REPLACE its widgets with the ones " +
        "you send (send the full set each time).\n\n" +
        "Each widget is { title, type, config, recipe, data }:\n" +
        "- type: 'chart' | 'stat' | 'table'.\n" +
        "- config: render options. For a chart: { chartKind: 'line'|'bar'|'area', xKey, " +
        "series: [{ key, label?, color? }] }. For a stat: { valueKey, unit?, label? }. " +
        "For a table: { columns: [{ key, label? }] }.\n" +
        "- data: the rows to render now — an array of flat objects (e.g. " +
        "[{ month: 'Jan', count: 12 }]). For a stat, a single object works.\n" +
        "- recipe: how to re-fetch this widget's data later — { command?, url?, note? }. " +
        "Store the exact shell command or URL you used so the dashboard can refresh " +
        "WITHOUT you. CRITICAL: the recipe must emit a JSON ARRAY OF FLAT OBJECTS (the " +
        "same shape as `data`) to stdout / as the response body — refresh runs it " +
        "deterministically with no LLM to reshape the output. Prefer JSON-native flags " +
        "and pipe through jq, e.g. `az ... -o json`, `gh ... --json field1,field2`, or " +
        "`some-cmd | jq '[.items[] | {name, count}]'`. A command that prints a table or " +
        "prose will fail to refresh.\n\n" +
        "Returns the saved dashboard id and a per-widget summary.",
      parameters: {
        type: "object",
        properties: {
          dashboardId: {
            type: "string",
            description:
              "Existing dashboard to update (replace its widgets). Omit to create a new one.",
          },
          name: {
            type: "string",
            description: "Dashboard title. Required when creating.",
          },
          description: {
            type: "string",
            description:
              "Optional one-line description of what the dashboard shows.",
          },
          widgets: {
            type: "array",
            description:
              "The widgets to save. Replaces the dashboard's existing widgets.",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Widget heading." },
                type: {
                  type: "string",
                  enum: ["chart", "stat", "table"],
                  description: "Render kind.",
                },
                config: {
                  type: "object",
                  description:
                    "Render config (chart kind + keys, stat valueKey, table columns).",
                },
                recipe: {
                  type: "object",
                  description:
                    "How to re-fetch this widget's data, emitting a JSON array of flat " +
                    "objects: { command?, url?, note? }. `command` is a shell command run " +
                    "in the workspace; `url` is an http(s) endpoint returning JSON. Provide " +
                    "one of command/url. (The workspace directory is captured automatically " +
                    "for a command — no need to set it.)",
                },
                data: {
                  type: "array",
                  description:
                    "The rows to render now (array of flat objects). A stat may send one object.",
                  items: { type: "object" },
                },
              },
              required: ["title", "type"],
            },
          },
        },
        required: [],
      },
    },
  },
  execute: async (args, ctx) => {
    const {
      dashboardId,
      name,
      description,
      widgets: rawWidgets,
    } = args as {
      dashboardId?: unknown
      name?: unknown
      description?: unknown
      widgets?: unknown
    }

    // LLMs sometimes send arrays/objects as JSON strings; parse defensively.
    let widgets = rawWidgets
    if (typeof widgets === "string") {
      try {
        widgets = JSON.parse(widgets)
      } catch {
        return toolError(
          "bad_args",
          "`widgets` must be an array of widget objects, not an unparseable string."
        )
      }
    }
    if (widgets !== undefined && !Array.isArray(widgets)) {
      return toolError(
        "bad_args",
        "`widgets` must be an array of widget objects."
      )
    }

    const id = typeof dashboardId === "string" ? dashboardId : undefined
    const dashName = typeof name === "string" ? name.trim() : ""

    if (!id && !dashName) {
      return toolError(
        "bad_args",
        "Provide `name` to create a dashboard, or `dashboardId` to update one."
      )
    }
    if (id && !dashboards.getDashboard(id)) {
      return toolError("not_found", `No dashboard with id ${id}.`)
    }

    const items = (widgets ?? []) as Array<Record<string, unknown>>
    if (items.length > dashboards.MAX_WIDGETS) {
      return toolError(
        "too_many",
        `A dashboard can have at most ${dashboards.MAX_WIDGETS} widgets (got ${items.length}).`
      )
    }
    const workspace = ctx.workspace?.trim() || undefined
    if (items.some((raw) => hasCommandRecipe(raw) && !workspace)) {
      return toolError(
        "bad_args",
        "Command recipes require an active workspace so refresh can run from a server-owned working directory."
      )
    }

    // Create/update the definition, then replace its widgets + seed each
    // widget's data cache — all in one transaction so a partial write can't
    // leave a half-authored dashboard.
    const db = getDb()
    const savedId = db.transaction(() => {
      const dash = id
        ? dashboards.updateDashboard(id, {
            ...(dashName ? { name: dashName } : {}),
            ...(typeof description === "string" ? { description } : {}),
          })
        : dashboards.createDashboard({
            name: dashName,
            description: typeof description === "string" ? description : null,
          })

      // Replace-all: drop existing widgets (their cache cascades), re-create.
      for (const w of dashboards.listWidgets(dash.id)) {
        dashboards.deleteWidget(w.id)
      }
      items.forEach((raw, i) => {
        const item = raw && typeof raw === "object" ? raw : {}
        const widget = dashboards.createWidget({
          dashboardId: dash.id,
          title: String(item.title ?? `Widget ${i + 1}`),
          type: item.type,
          config: item.config ?? null,
          recipe: withCwd(item.recipe, workspace),
          position: i,
        })
        if (item.data !== undefined && item.data !== null) {
          dashboards.upsertWidgetData({
            widgetId: widget.id,
            data: item.data,
            status: "ok",
          })
        }
      })
      return dash.id
    })()

    const graph = dashboards.getDashboardGraph(savedId)!
    return JSON.stringify({
      dashboardId: savedId,
      name: graph.dashboard.name,
      widgets: graph.widgets.map((w) => ({
        id: w.id,
        title: w.title,
        type: w.type,
        hasData: graph.data.some((d) => d.widgetId === w.id),
      })),
    })
  },
}

function hasCommandRecipe(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false
  const recipe = (raw as Record<string, unknown>).recipe
  return (
    !!recipe &&
    typeof recipe === "object" &&
    typeof (recipe as Record<string, unknown>).command === "string"
  )
}

// Capture the authoring working directory into a `command` recipe so the
// deterministic refresh executor (033.3) can re-run the command from the same
// place AND match the workspace-scoped allowlist grant the agent's own run_shell
// earned. A recipe with only a `url` (or no command) is left untouched — a web
// fetch needs no directory. Model-supplied cwd values are ignored: the workspace
// is server-owned state, not authorable recipe input.
function withCwd(recipe: unknown, workspace: string | undefined): unknown {
  if (!recipe || typeof recipe !== "object") return recipe ?? null
  const r = recipe as Record<string, unknown>
  if (typeof r.command === "string" && workspace) {
    return { ...r, cwd: workspace, workspace }
  }
  return recipe
}
