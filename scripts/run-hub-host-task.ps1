param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [Parameter(Mandatory = $true)]
  [string]$BunPath
)

$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$resolvedBun = (Resolve-Path -LiteralPath $BunPath).Path
$runFile = Join-Path $resolvedRoot "hub-host/run.ts"
$logDirectory = Join-Path $resolvedRoot ".hub-data/logs"
$logFile = Join-Path $logDirectory "host-task.log"

if (-not (Test-Path -LiteralPath $runFile -PathType Leaf)) {
  throw "Hub Host entry point not found at $runFile"
}

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
Push-Location -LiteralPath $resolvedRoot
try {
  & $resolvedBun run $runFile *>> $logFile
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
