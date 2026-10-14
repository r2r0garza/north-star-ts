// Scenario 3 fixture (plan 112.1): an app that needs setup before it runs:
// DATA_FILE (the key is in .env.local), a migrated data file (migrate.js), and
// the database (db.js) on DB_PORT. Each one missing stops it with a clear line.
const http = require("http")
const net = require("net")
const fs = require("fs")
const path = require("path")

function fail(message) {
  console.error(`server: ${message}`)
  process.exit(1)
}

const dataFile = process.env.DATA_FILE
if (!dataFile) fail("DATA_FILE is not set (see .env.local)")
let data
try {
  data = JSON.parse(fs.readFileSync(path.resolve(dataFile), "utf8"))
} catch {
  fail(`the data file ${dataFile} is not migrated; run node migrate.js`)
}
if (data.version !== 1) fail(`the data file ${dataFile} is not migrated`)

const dbPort = Number(process.env.DB_PORT)
if (!dbPort) fail("DB_PORT is not set; the database must be running")

function ping() {
  return new Promise((resolve) => {
    const socket = net.connect({ port: dbPort, host: "127.0.0.1" })
    socket.setTimeout(2000, () => {
      socket.destroy()
      resolve(false)
    })
    socket.once("connect", () => socket.write("ping\n"))
    socket.once("data", (chunk) => {
      socket.destroy()
      resolve(String(chunk).trim() === "pong")
    })
    socket.once("error", () => resolve(false))
  })
}

ping().then((ok) => {
  if (!ok) fail(`can't reach the database on port ${dbPort}`)
  const port = Number(process.env.PORT) || 3000
  http
    .createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(`<h1>Items</h1><p>${data.items.length} items</p>`)
    })
    .listen(port, "127.0.0.1", () => console.log(`server on port ${port}`))
})
