const assert = require("assert")
const { bill } = require("./calc")

assert.strictEqual(bill({ subtotal: 100, tax: 10, tipPercent: 0 }).total, 110)
assert.strictEqual(bill({ subtotal: 100, tax: 10, tipPercent: 20 }).tip, 22)
console.log("builder: 2 passed")
