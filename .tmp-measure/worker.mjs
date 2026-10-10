import { spawn } from "child_process"
import { join } from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
const ps = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")

const oldWorker = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
while ($null -ne ($line = [Console]::ReadLine())) {
  $command = ConvertFrom-Json $line
  $env:NS_PRIVATE_PATHS = $command.paths
  $output = & ([ScriptBlock]::Create($command.script))
  [Console]::WriteLine((ConvertTo-Json -Compress @{ id = $command.id; output = [string]($output -join "\\n") }))
}`
const oldAcl = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($entry in (ConvertFrom-Json $env:NS_PRIVATE_PATHS)) {
$p = $entry.path
if ($entry.create -and -not [System.IO.Directory]::Exists($p)) {
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $security.AddAccessRule($rule)
  [System.IO.Directory]::CreateDirectory($p, $security) | Out-Null
}
$item = Get-Item -LiteralPath $p -Force
if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
$acl = Get-Acl -LiteralPath $p
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
}
Write-Output 'private'`

const newWorker = `
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
while ($null -ne ($line = [Console]::ReadLine())) {
  $parts = $line.Split([char]9)
  $env:NS_PRIVATE_PATHS = $utf8.GetString([Convert]::FromBase64String($parts[2]))
  $output = & ([ScriptBlock]::Create($utf8.GetString([Convert]::FromBase64String($parts[1]))))
  [Console]::WriteLine('ok' + [char]9 + $parts[0] + [char]9 + [Convert]::ToBase64String($utf8.GetBytes([string]($output -join "\\n"))))
}`
const newAcl = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($entry in $env:NS_PRIVATE_PATHS.Split([char]10)) {
$p = $entry.Substring(1)
if ($entry[0] -eq [char]'1' -and -not [System.IO.Directory]::Exists($p)) {
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $security.AddAccessRule($rule)
  $null = [System.IO.Directory]::CreateDirectory($p, $security)
}
if (([System.IO.File]::GetAttributes($p) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
if ([System.IO.Directory]::Exists($p)) { $acl = [System.IO.Directory]::GetAccessControl($p) } else { $acl = [System.IO.File]::GetAccessControl($p) }
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
}
'private'`

function run(worker, line) {
  return new Promise((resolve, reject) => {
    const t = performance.now()
    const c = spawn(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(worker, "utf16le").toString("base64")], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    let out = ""
    let err = ""
    c.stderr.on("data", (d) => { err += d })
    c.on("exit", () => err && reject(new Error(err.replace(/<[^>]+>/g, " ").replace(/_x000D__x000A_/g, " ").slice(0, 1500))))
    c.stdout.on("data", (d) => {
      out += d
      if (out.includes("\n")) {
        const first = Math.round(performance.now() - t)
        const t2 = performance.now()
        c.stdin.write(line + "\n")
        out = ""
        c.stdout.removeAllListeners("data")
        c.stdout.on("data", (d) => {
          out += d
          if (out.includes("\n")) {
            const warm = Math.round(performance.now() - t2)
            c.stdin.end()
            c.on("exit", () => resolve({ first, warm, out: out.trim() }))
          }
        })
      }
    })
    c.stdin.write(line + "\n")
  })
}
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const p90 = (a) => [...a].sort((x, y) => x - y)[Math.ceil(a.length * 0.9) - 1]
const n = Number(process.argv[2] || 10)
const base = mkdtempSync(join(tmpdir(), "ns measure é '-"))
try {
  for (const [name, worker, mk] of [
    ["current", oldWorker, (p) => JSON.stringify({ id: 1, script: oldAcl, paths: JSON.stringify([{ path: p, create: true }]) })],
    ["candidate", newWorker, (p) => ["1", Buffer.from(newAcl).toString("base64"), Buffer.from("1" + p).toString("base64")].join("\t")],
  ]) {
    const first = [], warm = []
    for (let i = 0; i < n; i++) {
      const r = await run(worker, mk(join(base, `${name}-${i}`)))
      if (!r.out.includes("private") && !r.out.includes(Buffer.from("private").toString("base64"))) throw new Error(r.out)
      first.push(r.first); warm.push(r.warm)
    }
    console.log(name, { coldFirstMedian: median(first), coldFirstP90: p90(first), warmMedian: median(warm), samples: first.join(",") })
  }
} finally { rmSync(base, { recursive: true, force: true }) }
