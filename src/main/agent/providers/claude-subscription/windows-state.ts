import { spawn } from "child_process"
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
      { env, stdio: ["ignore", "pipe", "pipe"] }
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

const aclScript = `
$ErrorActionPreference = 'Stop'
$p = $env:NS_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:NS_PRIVATE_CREATE -eq '1' -and -not [System.IO.Directory]::Exists($p)) {
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
Write-Output 'private'
`

export async function windowsPrivatePath(
  path: string,
  create = false,
  signal = new AbortController().signal
): Promise<void> {
  const result = await windowsProbe(
    aclScript,
    {
      ...process.env,
      NS_PRIVATE_PATH: path,
      NS_PRIVATE_CREATE: create ? "1" : "0",
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
if ($present) { Write-Output 'present' } else { Write-Output 'absent' }
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
