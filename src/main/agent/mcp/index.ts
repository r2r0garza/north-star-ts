import { McpManager } from "./manager"

// The process-wide MCP connection pool. A single instance is shared by the IPC
// handlers (MCP view CRUD / test / authorize) and the agent loop (listToolsFor /
// callTool) so a connection opened by one is reused by the other. Constructed
// lazily on first access, like the DB connection singleton.
let instance: McpManager | undefined

export function getMcpManager(): McpManager {
  if (!instance) instance = new McpManager()
  return instance
}

export { McpManager } from "./manager"
export {
  prefixedToolName,
  parsePrefixedName,
  type McpToolDefinition,
} from "./manager"
export { enabledServerNames, loadServers } from "./resolve"
