// Scenario 3 fixture: creates the data file the server needs. Idempotent.
const fs = require("fs")
const path = require("path")

const file = process.env.DATA_FILE
if (!file) {
  console.error("migrate: DATA_FILE is not set (see .env.local)")
  process.exit(1)
}
const target = path.resolve(file)
fs.mkdirSync(path.dirname(target), { recursive: true })
if (!fs.existsSync(target))
  fs.writeFileSync(target, JSON.stringify({ version: 1, items: [] }))
console.log(`migrated ${file}`)
