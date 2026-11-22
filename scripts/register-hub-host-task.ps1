param(
  [string]$TaskName = "Happy Hallways Hub Host",
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$BunPath = (Join-Path $env:USERPROFILE ".bun\bin\bun.exe")
)

$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$resolvedBun = (Resolve-Path -LiteralPath $BunPath).Path
$runner = Join-Path $PSScriptRoot "run-hub-host-task.ps1"
$runFile = Join-Path $resolvedRoot "hub-host/run.ts"

if (-not (Test-Path -LiteralPath $runFile -PathType Leaf)) {
  throw "Hub Host entry point not found at $runFile"
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  throw "A task named '$TaskName' already exists. Review it in Task Scheduler; this script will not replace it."
}

$credential = Get-Credential -Message "Enter a dedicated school-approved Windows service account. Do not use a personal administrator account."
if (-not $credential) {
  throw "A service account is required to register a startup task."
}

$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`" -ProjectRoot `"$resolvedRoot`" -BunPath `"$resolvedBun`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $resolvedRoot
$trigger = New-ScheduledTaskTrigger -AtStartup -RandomDelay (New-TimeSpan -Seconds 30)
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Description "Runs the local Happy Hallways Hub Host independently of the kiosk browser." `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -User $credential.UserName `
  -Password $credential.GetNetworkCredential().Password `
  -RunLevel Limited | Out-Null

Write-Output "Registered '$TaskName' to start with Windows. It will start at the next system startup."
Write-Output "Review the task, service account folder permissions, environment settings, and logs before relying on it."
