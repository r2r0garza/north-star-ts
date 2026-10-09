import { randomBytes } from "crypto"
import { createServer } from "http"
import type { AddressInfo } from "net"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type { InventoryTool } from "./request"

export async function startInventory(tools: InventoryTool[]) {
  const path = `/${randomBytes(32).toString("hex")}`
  const active = new Set<Server>()
  let inFlight = 0
  const listener = createServer(async (req, res) => {
    if (
      req.url !== path ||
      req.headers.origin !== undefined ||
      req.headers.host !== host
    ) {
      res.writeHead(404).end()
      return
    }
    if (req.method !== "POST") {
      res.writeHead(405).end()
      return
    }
    if (inFlight >= 16) {
      res.writeHead(429).end()
      return
    }
    inFlight++
    const server = new Server(
      { name: "north_star", version: "1.0.0" },
      { capabilities: { tools: {} } }
    )
    active.add(server)
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      isError: true,
      content: [
        {
          type: "text",
          text: "Inventory only. Tool execution belongs to North Star.",
        },
      ],
    }))
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 1024 * 1024) throw new Error("limit")
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch {
      if (!res.headersSent) res.writeHead(400).end()
      else res.destroy()
    } finally {
      inFlight--
      active.delete(server)
      await server.close().catch(() => {})
      await transport.close().catch(() => {})
    }
  })
  listener.requestTimeout = 15000
  listener.headersTimeout = 10000
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", () => {
      listener.off("error", reject)
      resolve()
    })
  })
  const host = `127.0.0.1:${(listener.address() as AddressInfo).port}`
  return {
    config: {
      mcpServers: {
        north_star: { type: "http", url: `http://${host}${path}` },
      },
    },
    async close() {
      const closed = new Promise<void>((resolve) =>
        listener.close(() => resolve())
      )
      listener.closeAllConnections()
      await Promise.allSettled([...active].map((server) => server.close()))
      await closed
    },
  }
}
