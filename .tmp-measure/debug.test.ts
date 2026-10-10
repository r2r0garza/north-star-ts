import { it } from "vitest"
import { spawn } from "child_process"
import { join } from "path"
import { mkdtemp, writeFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { readFileSync } from "fs"

it("debug", async () => {
  const src = readFileSync("src/main/agent/providers/claude-subscription/windows-state.ts", "utf8")
  const worker = src.split("const workerScript = `")[1].split("\n`")[0].replace(/\\\\/g, "\\")
  const dir = await mkdtemp(join(tmpdir(), "dbg é-"))
  const path = join(dir, "quoted ' é.txt")
  await writeFile(path, "x")
  const c = spawn(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(worker, "utf16le").toString("base64")], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  let out = "", err = ""
  c.stdout.on("data", (d) => (out += d))
  c.stderr.on("data", (d) => (err += d))
  const send = (id: number, script: string, paths: string) =>
    c.stdin.write([id, Buffer.from(script).toString("base64"), Buffer.from(paths).toString("base64")].join("\t") + "\n")
  send(1, "Write-Output $PID", "")
  send(2, "$p = $env:NS_PRIVATE_PATHS; $acl = Get-Acl -LiteralPath $p; $sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'Read', 'Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl", path)
  c.stdin.end()
  await new Promise((r) => c.on("exit", r))
  console.log(JSON.stringify({ out, err: err.slice(0, 800) }))
  await rm(dir, { recursive: true, force: true })
}, 30000)
