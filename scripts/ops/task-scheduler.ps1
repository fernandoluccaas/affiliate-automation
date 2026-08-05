param(
  [ValidateSet("Preview", "Install", "Remove")]
  [string]$Action = "Preview",
  [ValidateSet("Supervisor", "Backup")]
  [string]$Task = "Supervisor",
  [switch]$ConfirmInstall,
  [switch]$ConfirmRemove
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$taskName = if ($Task -eq "Supervisor") { "AffiliateAutomationSupervisor" } else { "AffiliateAutomationBackup" }
$command = if ($Task -eq "Supervisor") {
  "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$repoRoot\scripts\ops\supervisor.ps1`" -Action Run"
} else {
  "cmd.exe /d /s /c `"cd /d `"`"$repoRoot`"`" && npm.cmd run ops:backup-db`""
}
$schedule = if ($Task -eq "Supervisor") { "ONLOGON" } else { "DAILY" }

if ($Action -eq "Preview") {
  [ordered]@{
    status = "PREVIEW_ONLY"
    task = $taskName
    schedule = $schedule
    repositoryConfigured = $true
    dispatchIncluded = $false
    playwrightIncluded = $false
    modifiesWindows = $false
  } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq "Install" -and -not $ConfirmInstall) { throw "TASK_INSTALL_CONFIRMATION_REQUIRED" }
if ($Action -eq "Remove" -and -not $ConfirmRemove) { throw "TASK_REMOVE_CONFIRMATION_REQUIRED" }

if ($Action -eq "Install") {
  $arguments = @("/Create", "/TN", $taskName, "/TR", $command, "/SC", $schedule, "/F")
  if ($Task -eq "Backup") {
    $taskTime = if ($env:AFFILIATE_BACKUP_TASK_TIME) { $env:AFFILIATE_BACKUP_TASK_TIME } else { "03:00" }
    $arguments += @("/ST", $taskTime)
  }
  & schtasks.exe @arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "TASK_INSTALL_FAILED" }
  [ordered]@{ status = "INSTALLED"; task = $taskName; dispatchIncluded = $false } | ConvertTo-Json -Compress
  exit 0
}

& schtasks.exe /Delete /TN $taskName /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "TASK_REMOVE_FAILED" }
[ordered]@{ status = "REMOVED"; task = $taskName } | ConvertTo-Json -Compress
