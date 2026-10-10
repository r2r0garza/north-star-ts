import { spawnSync } from "child_process"
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
for (const args of [["--version"], ["auth", "status", "--json"]]) {
  const times = []
  let codes = new Set()
  for (let i = 0; i < 7; i++) {
    const t = performance.now()
    const r = spawnSync("claude", args, { windowsHide: true, shell: false })
    times.push(Math.round(performance.now() - t))
    codes.add(r.status)
  }
  console.log(args.join(" "), "median", median(times), "all", times.join(","), "exit", [...codes].join(","))
}
