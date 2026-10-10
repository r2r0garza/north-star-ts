import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { AsyncLocalStorage } from "async_hooks"
import { join } from "path"
import { captureProcess } from "../../env/spawn-util"
import { ClaudeSubscriptionError, aborted } from "./errors"

export async function windowsProbe(
  script: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  code: string
): Promise<string> {
  if (signal.aborted) throw aborted()
  const worker = probeScope.getStore()
  if (worker) return worker.probe(script, env, signal, code)
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT
  if (!systemRoot)
    throw new ClaudeSubscriptionError(
      code,
      "Windows system tools are unavailable."
    )
  const result = await captureProcess(
    spawn(
      join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    ),
    { signal, timeoutMs: 5000, maxOutputBytes: 4096, killGroup: true }
  )
  if (signal.aborted || result.aborted) throw aborted()
  if (
    result.exitCode !== 0 ||
    result.signal ||
    result.spawnError ||
    result.timedOut ||
    result.outputTruncated
  )
    throw new ClaudeSubscriptionError(
      code,
      result.timedOut
        ? "Windows transport security probe timed out. Recheck host configuration."
        : "Could not verify Windows transport security. Recheck host configuration."
    )
  return result.stdout.toString("utf8").trim()
}

// Probe scripts use .NET calls only: first use of cmdlets (Get-Acl, Get-Item,
// ConvertFrom-Json, New-Object, Write-Output) loads modules and roughly doubles
// cold PowerShell startup on Windows.
const aclScript = `
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
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
$userAccess = $false
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Deny') { throw 'deny access' }
  if ($rule.AccessControlType -eq 'Allow') {
    if ($allowed -notcontains $rule.IdentityReference.Value) { throw 'public access' }
    if ($rule.IdentityReference.Value -eq $sid.Value -and ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) { $userAccess = $true }
  }
}
if (-not $userAccess) { throw 'access' }
}
'private'
`

export async function windowsPrivatePath(
  path: string,
  create = false,
  signal = new AbortController().signal
): Promise<void> {
  return windowsPrivatePaths([{ path, create }], signal)
}

export async function windowsPrivatePaths(
  paths: { path: string; create?: boolean }[],
  signal = new AbortController().signal
): Promise<void> {
  if (!paths.length || paths.some(({ path }) => !path || /[\0\r\n]/.test(path)))
    throw new ClaudeSubscriptionError(
      "claude_subscription_private_state",
      "Subscription transport state is not private."
    )
  const result = await windowsProbe(
    aclScript,
    {
      ...process.env,
      NS_PRIVATE_PATHS: paths
        .map(({ path, create }) => (create ? "1" : "0") + path)
        .join("\n"),
    },
    signal,
    "claude_subscription_private_state"
  )
  if (result !== "private")
    throw new ClaudeSubscriptionError(
      "claude_subscription_private_state",
      "Subscription transport state is not private."
    )
}

export async function guardWindowsRegistry(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<void> {
  const result = await windowsProbe(
    `
$ErrorActionPreference = 'Stop'
$present = $false
foreach ($hive in @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser)) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
    try {
      $key = $base.OpenSubKey('SOFTWARE\\Policies\\ClaudeCode')
      if ($null -ne $key) { $present = $true; $key.Dispose() }
    } finally { $base.Dispose() }
  }
}
if ($present) { 'present' } else { 'absent' }
`,
    env,
    signal,
    "claude_subscription_managed_policy_probe"
  )
  if (result === "present")
    throw new ClaudeSubscriptionError(
      "claude_subscription_managed_policy",
      "Claude registry policy is present. Use an organization-approved provider; do not remove or bypass policy."
    )
  if (result !== "absent")
    throw new ClaudeSubscriptionError(
      "claude_subscription_managed_policy_probe",
      "Could not check Claude registry policy presence."
    )
}

const probeScope = new AsyncLocalStorage<WindowsProbeWorker>()

export async function withWindowsProbeWorker<T>(
  signal: AbortSignal,
  run: () => Promise<T>
): Promise<T> {
  if (process.platform !== "win32") return run()
  const worker = new WindowsProbeWorker(signal)
  let failed = false
  try {
    return await probeScope.run(worker, run)
  } catch (error) {
    failed = true
    throw error
  } finally {
    try {
      await worker.close()
    } catch (error) {
      if (!failed) throw error
    }
  }
}

// Requests: id TAB base64(script) TAB base64(paths). Responses: ok TAB id TAB
// base64(output), or "failed". Base64 keeps paths/scripts as data and avoids
// loading the JSON cmdlets.
const workerScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $parts = $line.Split([char]9)
    if ($parts.Length -ne 3) { throw 'protocol' }
    $env:NS_PRIVATE_PATHS = $utf8.GetString([Convert]::FromBase64String($parts[2]))
    $output = & ([ScriptBlock]::Create($utf8.GetString([Convert]::FromBase64String($parts[1]))))
    [Console]::WriteLine('ok' + [char]9 + $parts[0] + [char]9 + [Convert]::ToBase64String($utf8.GetBytes([string]($output -join [char]10))))
  } catch {
    [Console]::WriteLine('failed')
    exit 1
  }
}
`

class WindowsProbeWorker {
  private child?: ChildProcessWithoutNullStreams
  private result?: ReturnType<typeof captureProcess>
  private controller = new AbortController()
  private pending?: {
    id: number
    resolve: (value: string) => void
    reject: (error: unknown) => void
    code: string
  }
  private buffer = ""
  private id = 0
  private closed = false
  private onAbort = () => {
    this.controller.abort()
    this.reject(aborted())
  }

  constructor(private signal: AbortSignal) {
    if (signal.aborted) this.onAbort()
    else signal.addEventListener("abort", this.onAbort, { once: true })
  }

  private reject(error: unknown) {
    this.pending?.reject(error)
    this.pending = undefined
  }

  private fail(
    code = this.pending?.code ?? "claude_subscription_private_state"
  ) {
    this.closed = true
    this.controller.abort()
    this.reject(
      new ClaudeSubscriptionError(
        code,
        "Could not verify Windows transport security. Recheck host configuration."
      )
    )
  }

  async probe(
    script: string,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
    code: string
  ): Promise<string> {
    if (signal.aborted || this.signal.aborted) throw aborted()
    if (this.closed || this.pending) {
      this.fail(code)
      throw new ClaudeSubscriptionError(
        code,
        "Windows security worker is unavailable."
      )
    }
    if (!this.child) {
      const root = process.env.SystemRoot || process.env.SYSTEMROOT
      if (!root)
        throw new ClaudeSubscriptionError(
          code,
          "Windows system tools are unavailable."
        )
      this.child = spawn(
        join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(workerScript, "utf16le").toString("base64"),
        ],
        { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
      )
      this.result = captureProcess(this.child, {
        signal: this.controller.signal,
        timeoutMs: 2147483647,
        maxOutputBytes: 4096,
        killGroup: true,
      })
      void this.result.then(() => {
        if (!this.closed) this.fail()
      })
      this.child.stdin.on("error", () => this.fail())
      this.child.stderr.on("data", () => this.fail())
      this.child.stdout.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8")
        if (this.buffer.length > 4096) return this.fail()
        let newline: number
        while ((newline = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, newline).replace(/\r$/, "")
          this.buffer = this.buffer.slice(newline + 1)
          const match = /^ok\t(\d+)\t([A-Za-z0-9+/]*={0,2})$/.exec(line)
          if (!this.pending || !match || Number(match[1]) !== this.pending.id)
            return this.fail()
          this.pending.resolve(
            Buffer.from(match[2], "base64").toString("utf8").trim()
          )
          this.pending = undefined
        }
      })
    }
    const id = ++this.id
    const timeout = setTimeout(() => this.fail(code), 5000)
    const onAbort = () => this.onAbort()
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      return await new Promise<string>((resolve, reject) => {
        this.pending = { id, resolve, reject, code }
        this.child!.stdin.write(
          [
            id,
            Buffer.from(script, "utf8").toString("base64"),
            Buffer.from(env.NS_PRIVATE_PATHS ?? "", "utf8").toString("base64"),
          ].join("\t") + "\n",
          (error) => {
            if (error) this.fail(code)
          }
        )
      })
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.signal.removeEventListener("abort", this.onAbort)
    this.reject(aborted())
    const failed = this.controller.signal.aborted
    this.child?.stdin.end()
    const timeout = setTimeout(() => this.controller.abort(), 5000)
    try {
      const result = await this.result
      if (
        !failed &&
        !this.signal.aborted &&
        result &&
        (result.exitCode !== 0 ||
          result.signal ||
          result.spawnError ||
          result.outputTruncated ||
          result.aborted ||
          result.timedOut)
      )
        throw new ClaudeSubscriptionError(
          "claude_subscription_private_state",
          "Windows security worker did not exit cleanly."
        )
    } finally {
      clearTimeout(timeout)
    }
  }
}

export async function closeWindowsProbeWorker(): Promise<void> {
  await probeScope.getStore()?.close()
}
