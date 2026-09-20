import { readFileSync } from "node:fs"

const roadmapFiles = [
  ".plan/ROADMAP-NEXT.md",
  ".plan/ROADMAP-DEFERRED.md",
  ".plan/ROADMAP-SUPERSEDED.md",
  ".plan/ROADMAP-COMPLETED.md",
]

const entryPattern = /^\s*(?:\d+\.|-)\s+\*\*(.+?)\s+—/
const planIdPattern = /^\d{3}(?:\.\d+)?$/
const declarations = new Map()

for (const file of roadmapFiles) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/)

  for (const [index, line] of lines.entries()) {
    const entry = line.match(entryPattern)
    if (!entry) continue

    const ids = [...entry[1].matchAll(/`([^`]+)`/g)]
      .map((match) => match[1])
      .filter((id) => planIdPattern.test(id))

    for (const id of ids) {
      const locations = declarations.get(id) ?? []
      locations.push({ file, line: index + 1 })
      declarations.set(id, locations)
    }
  }
}

const errors = []

for (const [id, locations] of declarations) {
  if (locations.length > 1) {
    errors.push({
      message: `Plan ${id} is declared more than once:`,
      locations,
    })
  }
}

for (const [id, locations] of declarations) {
  if (id.includes(".")) continue

  const slices = [...declarations.entries()].filter(([candidate]) =>
    candidate.startsWith(`${id}.`)
  )
  if (slices.length === 0) continue

  const files = new Set([
    ...locations.map((location) => location.file),
    ...slices.flatMap(([, sliceLocations]) =>
      sliceLocations.map((location) => location.file)
    ),
  ])
  if (files.size === 1) continue

  errors.push({
    message: `Plan ${id} and its slices are assigned to different status files:`,
    locations: [
      ...locations,
      ...slices.flatMap(([, sliceLocations]) => sliceLocations),
    ],
  })
}

if (errors.length > 0) {
  console.error("Roadmap verification failed.\n")
  for (const error of errors) {
    console.error(error.message)
    for (const location of error.locations) {
      console.error(`  ${location.file}:${location.line}`)
    }
    console.error()
  }
  console.error(
    "A plan ID cannot be declared more than once or split across roadmap statuses."
  )
  process.exit(1)
}

console.log(
  `Roadmap verification passed: ${declarations.size} plan IDs across ${roadmapFiles.length} status files.`
)
