import { ipcMain, shell } from "electron"
import path from "path"
import { readFile } from "fs/promises"
import * as mcpState from "../db/repositories/mcp-servers"
import * as settingsService from "../settings/service"
import * as secrets from "../settings/secrets"
import { listWorkspaces } from "../db/repositories/workspaces"
import { dataDirName } from "../config/system-name"
import { getMcpManager } from "../agent/mcp"
import { userMcpDir, mcpSourceEntries } from "../agent/mcp/sources"
import { listServersInSource } from "../agent/mcp/resolve"
import { isValidServerName, mutateConfigFile } from "../agent/mcp/loader"
import {
  MCP_CONFIG_FILENAME,
  type McpFolder,
  type McpServerView,
  type McpSourceKind,
  type McpSourceRow,
  type McpTree,
} from "../agent/mcp/types"
import type { McpServerDef } from "../db/types"

// IPC for MCP servers. DEFINITIONS live in file-based mcp.json configs (like
// agents/skills) — discovered from user/workspace/custom dirs; only the enabled
// toggle + OAuth secrets live in the DB side-store (keyed by name). The renderer
// never receives OAuth ciphertext — only `hasOauth`. Writes go to mcp.json files
// in WRITABLE roots (user + custom); workspace/github configs are read-only here.

// The writable mcp.json file paths (user + registered custom folders), resolved.
function writableMcpFiles(): string[] {
  return [userMcpDir(), ...settingsService.getMcpSources().folders].map((dir) =>
    path.resolve(path.join(dir, MCP_CONFIG_FILENAME))
  )
}

// Guard: a save/delete target must be one of the writable mcp.json paths. Prevents
// writing into a read-only workspace/github config or an arbitrary path.
function assertWritableMcpFile(filePath: string): void {
  const resolved = path.resolve(filePath)
  if (!writableMcpFiles().includes(resolved)) {
    throw new Error(
      `Refusing to modify an MCP config outside a writable source: ${filePath}`
    )
  }
}

// ALL mcp.json paths the view can read (user + custom + both workspace files for
// every known workspace), for the read/reveal guard.
function allMcpFiles(): string[] {
  const dataDir = dataDirName()
  const files = [...writableMcpFiles()]
  for (const ws of listWorkspaces()) {
    files.push(path.resolve(path.join(ws.path, ".github", MCP_CONFIG_FILENAME)))
    files.push(path.resolve(path.join(ws.path, dataDir, MCP_CONFIG_FILENAME)))
  }
  return files
}

function assertReadableMcpFile(filePath: string): void {
  const resolved = path.resolve(filePath)
  if (!allMcpFiles().includes(resolved)) {
    throw new Error(`Refusing MCP path outside known sources: ${filePath}`)
  }
}

// A server view is McpServer as-is (secrets already reduced to hasOauth).
export function registerMcpHandlers(): void {
  const manager = getMcpManager()

  ipcMain.handle("mcp:secureStorageAvailable", () =>
    secrets.isSecureStorageAvailable()
  )

  // The kind-tagged source dirs for a workspace, each with its server count —
  // Settings → Capabilities. Mirrors agents:sources.
  ipcMain.handle(
    "mcp:sources",
    async (_e, workspace?: string): Promise<McpSourceRow[]> =>
      Promise.all(
        mcpSourceEntries(workspace).map(async ({ dir, kind }) => ({
          path: dir,
          kind,
          serverCount: (await listServersInSource(dir)).length,
        }))
      )
  )

  // The nested catalog for the MCP view: Global (user) + one node per known
  // workspace + one node per custom folder, each with its loaded servers.
  // Mirrors agents:tree.
  ipcMain.handle("mcp:tree", async (): Promise<McpTree> => {
    const dataDir = dataDirName()
    const toFolder = async (
      dir: string,
      label: string,
      kind: McpSourceKind
    ): Promise<McpFolder> => ({
      path: dir,
      label,
      kind,
      servers: await listServersInSource(dir),
    })

    const global = [await toFolder(userMcpDir(), "Global", "user")]

    const workspaces = await Promise.all(
      listWorkspaces().map(async (ws) => ({
        label: ws.name ?? path.basename(ws.path),
        path: ws.path,
        folders: await Promise.all([
          toFolder(path.join(ws.path, ".github"), ".github", "github"),
          toFolder(path.join(ws.path, dataDir), dataDir, "workspace"),
        ]),
      }))
    )

    const custom = await Promise.all(
      settingsService
        .getMcpSources()
        .folders.map((dir) => toFolder(dir, path.basename(dir), "custom"))
    )

    return { global, workspaces, custom }
  })

  // Read a raw mcp.json for the "edit as JSON" affordance / diagnostics.
  ipcMain.handle("mcp:readConfig", async (_e, filePath: string) => {
    assertReadableMcpFile(filePath)
    try {
      return await readFile(filePath, "utf-8")
    } catch {
      return "" // absent file → empty, the UI treats it as "no servers yet"
    }
  })

  // Create or update ONE server entry inside a writable mcp.json. The def carries
  // the server name (the object key); an existing key with the same name is
  // replaced. Returns the updated server view (joined with state).
  ipcMain.handle(
    "mcp:saveServer",
    async (_e, filePath: string, def: McpServerDef): Promise<McpServerView> => {
      assertWritableMcpFile(filePath)
      if (!isValidServerName(def.name)) {
        throw new Error(
          `Invalid MCP server name "${def.name}": use lowercase letters, digits, and single hyphens.`
        )
      }
      await mutateConfigFile(filePath, (servers) => {
        servers.set(def.name, def)
      })
      // Config changed — drop any pooled connection so the next use reconnects.
      manager.evict(def.name)
      const dir = path.dirname(filePath)
      const view = (await listServersInSource(dir)).find(
        (s) => s.name === def.name
      )
      if (!view) throw new Error("Server not found after save.")
      return view
    }
  )

  // Delete ONE server entry from a writable mcp.json by name.
  ipcMain.handle(
    "mcp:deleteServer",
    async (_e, filePath: string, name: string): Promise<void> => {
      assertWritableMcpFile(filePath)
      await mutateConfigFile(filePath, (servers) => {
        servers.delete(name)
      })
      manager.evict(name)
    }
  )

  // Reveal an mcp.json in the OS file manager.
  ipcMain.handle("mcp:reveal", async (_e, filePath: string) => {
    assertReadableMcpFile(filePath)
    shell.showItemInFolder(path.resolve(filePath))
  })

  // ── Per-machine state (keyed by server name) ────────────────────────────────
  ipcMain.handle("mcp:setEnabled", (_e, name: string, enabled: boolean) => {
    mcpState.setEnabled(name, enabled)
    manager.evict(name)
  })

  // Connect on demand and report the discovered tool count (or an error). The
  // workspace scopes which mcp.json the server is resolved from.
  ipcMain.handle(
    "mcp:test",
    (
      _e,
      name: string,
      workspace?: string
    ): Promise<{ ok: boolean; toolCount?: number; error?: string }> =>
      manager.testConnection(name, workspace)
  )

  // Run the interactive OAuth flow (opens the system browser).
  ipcMain.handle(
    "mcp:authorize",
    (
      _e,
      name: string,
      workspace?: string
    ): Promise<{ ok: boolean; error?: string }> =>
      manager.authorize(name, workspace)
  )

  ipcMain.handle("mcp:clearOauth", (_e, name: string) => {
    secrets.clearMcpOauth(name)
    manager.evict(name)
  })

  // Whether a given mcp.json path is one of the writable roots — lets the UI show
  // read-only workspace/github configs without a failed write round-trip.
  ipcMain.handle("mcp:isWritable", (_e, filePath: string): boolean =>
    writableMcpFiles().includes(path.resolve(filePath))
  )
}
