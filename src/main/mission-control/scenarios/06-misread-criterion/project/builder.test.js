// Scenario 6 fixture: the builder's tests, written against its own misreading
// of AC-2, so they pass. `node builder.test.js`; exit 0 = pass.
const assert = require("assert")
const { bill } = require("./calc")

assert.strictEqual(bill({ subtotal: 100, tax: 10, tipPercent: 0 }).total, 110)
assert.strictEqual(bill({ subtotal: 100, tax: 10, tipPercent: 20 }).tip, 22)
console.log("builder: 2 passed")
