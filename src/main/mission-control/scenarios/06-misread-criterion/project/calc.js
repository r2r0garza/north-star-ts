// Scenario 6 fixture (plan 112.1): the builder's implementation. AC-2 says the
// tip is on the pre-tax subtotal; this computes it on subtotal + tax.
function bill({ subtotal, tax, tipPercent }) {
  const total = subtotal + tax
  const tip = Math.round(total * tipPercent) / 100
  return { total, tip, grandTotal: total + tip }
}

module.exports = { bill }
