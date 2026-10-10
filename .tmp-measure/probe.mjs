import { spawnSync } from "child_process"
import { join } from "path"
const ps = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const dir = process.argv[2]
const scripts = {
  empty: "exit 0",
  json: "$null = ConvertFrom-Json '{\"a\":1}'; exit 0",
  getacl: `$null = Get-Acl -LiteralPath '${dir}'; exit 0`,
  getitem: `$null = Get-Item -LiteralPath '${dir}' -Force; exit 0`,
  dotnetacl: `$null = [System.IO.Directory]::GetAccessControl('${dir}').GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); $null=[System.IO.File]::GetAttributes('${dir}'); exit 0`,
  noautoload: `$PSModuleAutoLoadingPreference='None'; $null = [System.IO.Directory]::GetAccessControl('${dir}'); exit 0`,
}
const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)]
for (const [name, script] of Object.entries(scripts)) {
  const times = []
  for (let i = 0; i < 7; i++) {
    const t = performance.now()
    const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true })
    if (r.status !== 0) throw new Error(name + " " + r.stderr)
    times.push(Math.round(performance.now() - t))
  }
  console.log(name.padEnd(12), "median", median([...times]), "all", times.join(","))
}
