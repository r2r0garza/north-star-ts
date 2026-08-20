import { readFile, writeFile, mkdir } from "fs/promises"
import path from "path"
import type { McpServerDef, McpTransport } from "../../db/types"

// Parse, validate, and serialize mcp.json config files. One file holds MANY
// servers keyed by name; this layer knows nothing about per-machine state
// (enabled / OAuth) — that's joined in later from the DB side-store.

// Cap on a config file we'll parse, to avoid pathological reads.
const MAX_CONFIG_SIZE = 512 * 1024

// The server slug shape: lowercase alphanumeric + single hyphens. Used as the
// object key in mcp.json and as the tool prefix mcp__<name>__<tool>.
export function isValidServerName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
}

// The raw per-server entry shape in mcp.json (ecosystem standard). All fields
// optional at the JSON level; the transport is inferred and validated here.
interface RawEntry {
  command?: unknown
  args?: unknown
  env?: unknown
  url?: unknown
  headers?: unknown
  // Tolerated but ignored (some ecosystems include these); we don't use them.
  type?: unknown
  transport?: unknown
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x)).filter((s) => s.length > 0)
}

function toStringRecord(v: unknown): Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val != null) out[k] = String(val)
  }
  return out
}

// Parse a single named entry into a McpServerDef, or null if it's malformed
// (bad name, or neither a command nor a url). Transport is inferred: a `command`
// → stdio, else a `url` → http.
export function parseEntry(name: string, raw: RawEntry): McpServerDef | null {
  if (!isValidServerName(name)) return null
  const command = typeof raw.command === "string" ? raw.command : null
  const url = typeof raw.url === "string" ? raw.url : null
  let transport: McpTransport
  if (command) transport = "stdio"
  else if (url) transport = "http"
  else return null // no way to connect
  return {
    name,
    transport,
    command,
    args: toStringArray(raw.args),
    env: toStringRecord(raw.env),
    url,
    headers: toStringRecord(raw.headers),
  }
}

// Parse a whole mcp.json's text into server defs. Tolerant: a malformed file or
// entry is skipped (logged), never throwing — a broken config in one source must
// not break discovery of the others. Accepts both { mcpServers: {...} } and a
// bare {...} map of servers.
export function parseConfig(text: string, filePath: string): McpServerDef[] {
  if (text.length > MAX_CONFIG_SIZE) {
    console.warn(`Skipping ${filePath}: mcp.json too large`)
    return []
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    console.warn(`Invalid JSON in ${filePath}: ${e}`)
    return []
  }
  if (typeof json !== "object" || json === null) return []
  const container = json as Record<string, unknown>
  const map =
    typeof container.mcpServers === "object" && container.mcpServers !== null
      ? (container.mcpServers as Record<string, unknown>)
      : container
  const defs: McpServerDef[] = []
  for (const [name, entry] of Object.entries(map)) {
    if (typeof entry !== "object" || entry === null) continue
    const def = parseEntry(name, entry as RawEntry)
    if (def) defs.push(def)
    else console.warn(`Skipping MCP server "${name}" in ${filePath}: invalid`)
  }
  return defs
}

// Read + parse one mcp.json file. Missing file → [] (a source that doesn't exist
// yet is fine, like an empty agents dir).
export async function loadConfigFile(
  filePath: string
): Promise<McpServerDef[]> {
  let text: string
  try {
    text = await readFile(filePath, "utf-8")
  } catch {
    return []
  }
  return parseConfig(text, filePath)
}

// Serialize server defs back to mcp.json text (the { mcpServers: {...} } form).
// The inverse of parseConfig for the writable-file CRUD path. Only writes fields
// relevant to each server's transport, so a stdio server doesn't carry an empty
// url and vice-versa. Stable key order for clean diffs.
export function serializeConfig(defs: McpServerDef[]): string {
  const mcpServers: Record<string, unknown> = {}
  for (const def of [...defs].sort((a, b) => a.name.localeCompare(b.name))) {
    const entry: Record<string, unknown> = {}
    if (def.transport === "stdio") {
      entry.command = def.command ?? ""
      if (def.args.length > 0) entry.args = def.args
      if (Object.keys(def.env).length > 0) entry.env = def.env
    } else {
      entry.url = def.url ?? ""
      if (Object.keys(def.headers).length > 0) entry.headers = def.headers
    }
    mcpServers[def.name] = entry
  }
  return JSON.stringify({ mcpServers }, null, 2) + "\n"
}

// Read the defs from a writable mcp.json, apply a mutation to the server map, and
// write it back. Creates the file (and its dir) if absent. The mutator receives a
// name→def map it edits in place (add/replace/delete a key). This is the single
// write path for create/update/delete of a server within a file.
export async function mutateConfigFile(
  filePath: string,
  mutate: (servers: Map<string, McpServerDef>) => void
): Promise<void> {
  const defs = await loadConfigFile(filePath)
  const map = new Map(defs.map((d) => [d.name, d]))
  mutate(map)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, serializeConfig([...map.values()]), "utf-8")
}
