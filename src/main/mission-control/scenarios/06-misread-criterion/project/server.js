// Scenario 6 fixture (plan 112.1): the bill splitter's page.
// GET /?subtotal=100&tax=10&tip=20 shows the total, the tip, and the sum.
const http = require("http")
const { bill } = require("./calc")

const port = Number(process.env.PORT) || 3000
http
  .createServer((req, res) => {
    const q = new URL(req.url, "http://localhost").searchParams
    const result = bill({
      subtotal: Number(q.get("subtotal") ?? 0),
      tax: Number(q.get("tax") ?? 0),
      tipPercent: Number(q.get("tip") ?? 0),
    })
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(
      `<h1>Bill</h1><form><label>Subtotal <input name="subtotal"></label>` +
        `<label>Tax <input name="tax"></label><label>Tip % <input name="tip"></label>` +
        `<button>Calculate</button></form>` +
        `<p>Total: <output id="total">${result.total.toFixed(2)}</output></p>` +
        `<p>Tip: <output id="tip">${result.tip.toFixed(2)}</output></p>` +
        `<p>To pay: <output id="grand">${result.grandTotal.toFixed(2)}</output></p>`
    )
  })
  .listen(port, "127.0.0.1", () => console.log(`bill on port ${port}`))
