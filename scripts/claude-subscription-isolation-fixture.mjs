import { mkdir, writeFile, access } from "node:fs/promises"
import { join } from "node:path"

const markerPrefix = "NS_ISOLATION_FIXTURE_"
export async function isolationFixture(root, inventoryUrl) {
  const home = join(root, "home")
  const config = join(home, ".claude")
  const project = join(root, "project")
  const cwd = join(project, "transport", "cwd")
  const hookMarker = join(root, "hook-ran")
  const plugin = join(root, "fixture-plugin")
  const put = async (path, content) => {
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 })
    await writeFile(path, content, { mode: 0o600 })
  }
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  const hook = join(root, "marker-hook.cjs")
  await put(
    hook,
    `require("node:fs").writeFileSync(${JSON.stringify(hookMarker)}, "harmless fixture hook ran")`
  )
  const command = `"${process.execPath}" "${hook}"`
  const hooks = {
    SessionStart: [{ hooks: [{ type: "command", command }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
  }
  await put(join(config, "CLAUDE.md"), markerPrefix + "USER_MEMORY\n")
  await put(join(project, "CLAUDE.md"), markerPrefix + "PARENT_MEMORY\n")
  await put(join(project, "CLAUDE.local.md"), markerPrefix + "LOCAL_MEMORY\n")
  await put(
    join(project, ".claude", "rules", "fixture.md"),
    markerPrefix + "PROJECT_RULE\n"
  )
  const skill = (marker) =>
    `---\nname: fixture-skill\ndescription: ${marker}\n---\n${marker}\n`
  await put(
    join(config, "skills", "fixture-skill", "SKILL.md"),
    skill(markerPrefix + "USER_SKILL")
  )
  await put(
    join(project, ".claude", "skills", "fixture-skill", "SKILL.md"),
    skill(markerPrefix + "PROJECT_SKILL")
  )
  await put(
    join(config, "commands", "fixture.md"),
    markerPrefix + "USER_COMMAND\n"
  )
  await put(
    join(project, ".claude", "agents", "fixture.md"),
    `---\nname: fixture-agent\ndescription: ${markerPrefix}PROJECT_AGENT\n---\nHarmless agent fixture.\n`
  )
  await put(
    join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "isolation-fixture",
      version: "1.0.0",
      description: markerPrefix + "PLUGIN",
    })
  )
  await put(
    join(plugin, "skills", "plugin-fixture", "SKILL.md"),
    skill(markerPrefix + "PLUGIN_SKILL")
  )
  await put(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks }))
  const settings = {
    hooks,
    enabledPlugins: { "isolation-fixture@fixture": true },
  }
  await put(join(config, "settings.json"), JSON.stringify(settings))
  await put(join(project, ".claude", "settings.json"), JSON.stringify(settings))
  await put(
    join(project, ".claude", "settings.local.json"),
    JSON.stringify(settings)
  )
  await put(
    join(config, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "isolation-fixture@fixture": [
          {
            scope: "user",
            installPath: plugin,
            version: "1.0.0",
            installedAt: new Date(0).toISOString(),
            lastUpdated: new Date(0).toISOString(),
          },
        ],
      },
    })
  )
  await put(
    join(project, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        unrelated_fixture: { type: "http", url: inventoryUrl + "/unrelated" },
      },
    })
  )
  await put(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        unrelated_user_fixture: {
          type: "http",
          url: inventoryUrl + "/unrelated-user",
        },
      },
    })
  )
  return {
    cwd,
    home,
    config,
    plugin,
    async result(body) {
      let hookRan = false
      try {
        await access(hookMarker)
        hookRan = true
      } catch {}
      return {
        hookRan,
        markerLeaked: JSON.stringify(body).includes(markerPrefix),
      }
    },
  }
}
