// Scenario 2 fixture (plan 112.1): a small list app. The two story patches
// in ../patches change the client; the server already has both endpoints.
const http = require("http")
const fs = require("fs")
const path = require("path")

const items = [
  { id: 1, name: "Buy milk", done: false },
  { id: 2, name: "Walk the dog", done: false },
]
let nextId = 3

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type })
  res.end(body)
}

function file(res, name, type) {
  send(res, 200, type, fs.readFileSync(path.join(__dirname, "public", name)))
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"))
      } catch {
        resolve({})
      }
    })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost")
  if (req.method === "GET" && url.pathname === "/")
    return file(res, "index.html", "text/html; charset=utf-8")
  if (req.method === "GET" && url.pathname === "/app.js")
    return file(res, "app.js", "text/javascript")
  if (req.method === "GET" && url.pathname === "/api/items")
    return send(res, 200, "application/json", JSON.stringify(items))
  if (req.method === "POST" && url.pathname === "/api/items") {
    const { name } = await readJson(req)
    if (typeof name !== "string" || !name.trim())
      return send(res, 400, "application/json", '{"error":"name required"}')
    const item = { id: nextId++, name: name.trim(), done: false }
    items.push(item)
    return send(res, 201, "application/json", JSON.stringify(item))
  }
  const action = /^\/api\/items\/(\d+)\/(complete|toggle)$/.exec(url.pathname)
  if (req.method === "POST" && action) {
    const item = items.find((i) => i.id === Number(action[1]))
    if (!item) return send(res, 404, "application/json", '{"error":"no item"}')
    item.done = action[2] === "toggle" ? !item.done : true
    return send(res, 200, "application/json", JSON.stringify(item))
  }
  send(res, 404, "text/plain", "not found")
})

const port = Number(process.env.PORT) || 3000
server.listen(port, "127.0.0.1", () => console.log(`list app on port ${port}`))
