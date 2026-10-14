// Scenario 5 fixture (plan 112.1): a small library, nothing to start.
function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

module.exports = { slugify }
