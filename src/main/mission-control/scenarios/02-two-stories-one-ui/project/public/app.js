// List app client (scenario 2 fixture).
const list = document.getElementById("items")
let items = []

async function load() {
  items = await (await fetch("/api/items")).json()
  render()
}

// The label on an item's button.
function buttonLabel(item) {
  return "Complete"
}

// Rendering: one row per item, its name and its button.
function render() {
  list.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement("li")
      const name = document.createElement("span")
      name.textContent = item.name
      if (item.done) name.className = "done"
      const button = document.createElement("button")
      button.textContent = buttonLabel(item)
      button.onclick = () => onButton(item)
      row.append(name, button)
      return row
    })
  )
}

// What clicking an item's button does.
async function onButton(item) {
  await fetch(`/api/items/${item.id}/complete`, { method: "POST" })
  await load()
}

load()
