// Scenario 5 fixture: the library's own tests. `node test.js`; exit 0 = pass.
const assert = require("assert")
const { slugify } = require("./lib")

assert.strictEqual(slugify("Hello World"), "hello-world")
assert.strictEqual(slugify("  --Trim me--  "), "trim-me")
console.log("lib: 2 passed")
