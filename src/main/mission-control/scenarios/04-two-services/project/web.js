// Scenario 4 fixture (plan 112.1): the web frontend, which reads the API's
// address from API_URL and answers 502 while it can't reach it.
const http = require("http")

const api = process.env.API_URL
if (!api) {
  console.error("web: API_URL is not set")
  process.exit(1)
}
const port = Number(process.env.PORT) || 3000
http
  .createServer(async (req, res) => {
    try {
      const reply = await fetch(`${api}/api/greeting`, {
        signal: AbortSignal.timeout(2000),
      })
      const { message } = await reply.json()
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(`<h1>Web</h1><p>${message}</p>`)
    } catch {
      res.writeHead(502, { "content-type": "text/plain" })
      res.end(`API unreachable at ${api}`)
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`web on port ${port}`))
