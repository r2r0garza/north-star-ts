function bill({ subtotal, tax, tipPercent }) {
  const total = subtotal + tax
  const tip = Math.round(total * tipPercent) / 100
  return { total, tip, grandTotal: total + tip }
}

module.exports = { bill }
