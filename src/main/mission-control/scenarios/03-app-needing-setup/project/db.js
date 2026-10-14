// Scenario 3 fixture (plan 112.1): a stand-in database, so the scenario needs
// a prerequisite service without Docker. A TCP server that answers "pong".
const net = require("net")

const port = Number(process.env.PORT)
if (!port) {
  console.error("db: PORT is not set")
  process.exit(1)
}
net
  .createServer((socket) => {
    socket.on("data", () => socket.end("pong\n"))
    socket.on("error", () => {})
  })
  .listen(port, "127.0.0.1", () => console.log(`db ready on port ${port}`))
