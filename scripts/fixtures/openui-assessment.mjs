import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

// Run against an isolated, exact-version installation; never import into the app.
assert.ok(process.argv[2], "Pass the installed lang-core dist/index.mjs path")
process.env.OPENUI_RUNTIME_TELEMETRY_ENABLED = "0"
const { createParser } = await import(
  pathToFileURL(resolve(process.argv[2])).href
)
const parser = createParser({
  $defs: {
    Stack: {
      type: "object",
      properties: { children: { type: "array" } },
      required: ["children"],
    },
    Text: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  properties: { Stack: {}, Text: {} },
})

const complete = parser.parse('root = Stack([Text("Synthetic data")]);')
assert.equal(complete.meta.incomplete, false)
assert.deepEqual(complete.meta.errors, [])
assert.equal(complete.root.props.children[0].props.text, "Synthetic data")

const partial = parser.parse(
  'root = Stack([Text("Kept"), Missing("Dropped")]);'
)
assert.equal(partial.root.props.children.length, 1)
assert.equal(partial.meta.errors[0].code, "unknown-component")
assert.equal(partial.meta.incomplete, false)

const incomplete = parser.parse('root = Text("Synthetic"')
assert.ok(incomplete.root)
assert.equal(incomplete.meta.incomplete, true)
assert.deepEqual(incomplete.meta.errors, [])

const query = parser.parse(
  'q = Query("not_connected", {});\nroot = Text("Synthetic");'
)
assert.equal(query.queryStatements.length, 1)
assert.deepEqual(query.meta.errors, [])
const expression = parser.parse("root = Text(@Sum([1,2]));")
assert.equal(expression.root.hasDynamicProps, true)
assert.deepEqual(expression.meta.errors, [])

const expansion = []
// Deliberately stop at 12: demonstrate amplification without stress-testing the host.
for (const depth of [4, 8, 12]) {
  const lines = ['leaf = Text("Synthetic");']
  let previous = "leaf"
  for (let i = 0; i < depth; i++) {
    const name = i === depth - 1 ? "root" : `level${i}`
    lines.push(`${name} = Stack([${previous}, ${previous}]);`)
    previous = name
  }
  const source = lines.join("\n")
  const start = performance.now()
  const result = parser.parse(source)
  const parseMs = performance.now() - start
  let nodes = 0
  const pending = [result.root]
  while (pending.length) {
    const node = pending.pop()
    assert.equal(node.type, "element")
    nodes++
    pending.push(...(node.props.children ?? []))
  }
  assert.deepEqual(result.meta.errors, [])
  assert.equal(nodes, 2 ** (depth + 1) - 1)
  expansion.push({
    depth,
    bytes: Buffer.byteLength(source),
    statements: result.meta.statementCount,
    nodes,
    parseMs,
  })
}
console.log(JSON.stringify({ checks: 6, expansion }, null, 2))
