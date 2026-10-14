// Scenario 4 fixture (plan 112.1): the API service.
const http = require("http")

const port = Number(process.env.PORT) || 4000
http
  .createServer((req, res) => {
    if (req.url === "/api/greeting") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ message: "hello from the api" }))
    }
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("api ok")
  })
  .listen(port, "127.0.0.1", () => console.log(`api on port ${port}`))
