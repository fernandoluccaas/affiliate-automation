param(
  [ValidateSet("Run", "Start", "Stop", "Restart", "Status", "Smoke", "BurnInSmoke")]
  [string]$Action = "Run",
  [int]$DurationSeconds = 20,
  [switch]$NoJobs,
  [switch]$BurnIn,
  [string]$TestLeaderKey = "",
  [string]$SessionId = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$stateRoot = Join-Path $repoRoot ".local\ops"
$logRoot = Join-Path $repoRoot ".local\logs"
$supervisorFile = Join-Path $stateRoot "supervisor.json"
$componentsFile = Join-Path $stateRoot "components.json"
$stopFile = Join-Path $stateRoot "stop.requested"
$lockFile = Join-Path $stateRoot "supervisor.lock"
$lastSupervisorFile = Join-Path $stateRoot "supervisor-last.json"
$burnInEventFile = Join-Path $stateRoot "burn-in-events.jsonl"
$maxCrashesValue = if ($env:AFFILIATE_SUPERVISOR_MAX_CRASHES) { $env:AFFILIATE_SUPERVISOR_MAX_CRASHES } else { "5" }
$shutdownSecondsValue = if ($env:AFFILIATE_SHUTDOWN_TIMEOUT_SECONDS) { $env:AFFILIATE_SHUTDOWN_TIMEOUT_SECONDS } else { "15" }
$maxCrashes = [Math]::Max(1, [int]$maxCrashesValue)
$shutdownSeconds = [Math]::Max(3, [int]$shutdownSecondsValue)
$stableResetValue = if ($env:AFFILIATE_SUPERVISOR_STABLE_RESET_SECONDS) { $env:AFFILIATE_SUPERVISOR_STABLE_RESET_SECONDS } else { "600" }
$stableResetSeconds = [Math]::Max(5, [int]$stableResetValue)

New-Item -ItemType Directory -Force -Path $stateRoot, $logRoot | Out-Null
$logRetentionValue = if ($env:AFFILIATE_LOG_RETENTION_DAYS) { $env:AFFILIATE_LOG_RETENTION_DAYS } else { "14" }
$logRetentionDays = [Math]::Max(1, [int]$logRetentionValue)
$logCutoff = [DateTime]::UtcNow.AddDays(-$logRetentionDays)
Get-ChildItem -LiteralPath $logRoot -Filter "supervisor.log.*" -File -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTimeUtc -lt $logCutoff } |
  Remove-Item -Force -ErrorAction SilentlyContinue

function Write-AtomicJson([string]$Path, [object]$Value) {
  $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
  $Value | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $temporary -Encoding utf8
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Read-Json([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-CommandLine([int]$ProcessId) {
  try {
    return (Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId").CommandLine
  } catch { return $null }
}

function Test-OwnedProcess([int]$ProcessId, [string]$Marker) {
  if ($ProcessId -le 0) { return $false }
  $commandLine = Get-CommandLine $ProcessId
  return $null -ne $commandLine -and
    $commandLine.ToLowerInvariant().Contains($repoRoot.ToLowerInvariant()) -and
    $commandLine.ToLowerInvariant().Contains($Marker.ToLowerInvariant())
}

function Write-SupervisorLog([string]$Level, [string]$Event, [string]$InstanceId, [string]$Component = "supervisor", [string]$ErrorCode = $null) {
  $logFile = Join-Path $logRoot "supervisor.log"
  $maxLogMb = if ($env:AFFILIATE_LOG_MAX_MB) { [int]$env:AFFILIATE_LOG_MAX_MB } else { 20 }
  if ((Test-Path -LiteralPath $logFile) -and (Get-Item -LiteralPath $logFile).Length -ge ($maxLogMb * 1MB)) {
    $rotated = "$logFile.$([DateTime]::UtcNow.ToString('yyyy-MM-dd')).$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
    try { Move-Item -LiteralPath $logFile -Destination $rotated } catch { }
  }
  $entry = [ordered]@{
    timestamp = [DateTime]::UtcNow.ToString("o")
    component = $Component
    level = $Level
    event = $Event
    instanceId = $InstanceId.Substring(0, [Math]::Min(12, $InstanceId.Length))
  }
  if ($ErrorCode) { $entry.errorCode = $ErrorCode }
  ($entry | ConvertTo-Json -Compress) | Add-Content -LiteralPath $logFile -Encoding utf8
}

function Write-BurnInEvent([string]$Event, [string]$InstanceId, [string]$Component = "supervisor") {
  if (-not $BurnIn) { return }
  $entry = [ordered]@{
    timestamp = [DateTime]::UtcNow.ToString("o")
    component = $Component
    event = $Event
    instanceId = $InstanceId.Substring(0, [Math]::Min(12, $InstanceId.Length))
    sessionId = $env:AFFILIATE_BURN_IN_SESSION_ID
  }
  ($entry | ConvertTo-Json -Compress) | Add-Content -LiteralPath $burnInEventFile -Encoding utf8
}

function Wait-Interruptible([double]$Seconds) {
  $until = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $until) {
    if (Test-Path -LiteralPath $stopFile) { return $false }
    Start-Sleep -Milliseconds 250
  }
  return $true
}

function Stop-OwnedProcess([object]$Component) {
  if (-not $Component -or $Component.pid -le 0) { return }
  if (-not (Test-OwnedProcess $Component.pid $Component.marker)) { return }
  if ($Component.smoke) {
    Stop-Process -Id $Component.pid -Force -ErrorAction SilentlyContinue
    if ($Component.stopFile) {
      Remove-Item -LiteralPath $Component.stopFile -Force -ErrorAction SilentlyContinue
    }
    return
  }
  if (-not $Component.smoke -and $Component.stopFile) {
    New-Item -ItemType File -Force -Path $Component.stopFile | Out-Null
  } else {
    & taskkill.exe /PID $Component.pid /T 2>$null | Out-Null
  }
  $deadline = [DateTime]::UtcNow.AddSeconds($shutdownSeconds)
  while ([DateTime]::UtcNow -lt $deadline -and (Get-Process -Id $Component.pid -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 250
  }
  if (Get-Process -Id $Component.pid -ErrorAction SilentlyContinue) {
    & taskkill.exe /PID $Component.pid /T /F 2>$null | Out-Null
  }
  if ($Component.stopFile) {
    Remove-Item -LiteralPath $Component.stopFile -Force -ErrorAction SilentlyContinue
  }
}

function Start-Component([string]$Name, [string]$InstanceId, [bool]$Smoke, [bool]$BurnInMode, [int]$RestartCount = 0, [int]$ConsecutiveCrashes = 0) {
  $stdout = Join-Path $logRoot "$Name.stdout.log"
  $stderr = Join-Path $logRoot "$Name.stderr.log"
  $componentStopFile = Join-Path $stateRoot "$InstanceId-$Name.stop"
  Remove-Item -LiteralPath $componentStopFile -Force -ErrorAction SilentlyContinue
  if ($Smoke) {
    $sleepSeconds = if ($Name -eq "dashboard" -and $RestartCount -eq 0) { 2 } else { 60 }
    $marker = "affiliate-smoke-$Name-$repoRoot"
    $command = "`$null='$marker'; Start-Sleep -Seconds $sleepSeconds"
    $process = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-Command", $command) -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  } else {
    $script = if ($Name -eq "dashboard") { "production:dashboard" } elseif ($BurnInMode) { "production:worker:burn-in" } else { "production:worker" }
    $marker = $script
    $processHost = Join-Path $repoRoot "scripts\ops\process-host.mjs"
    $process = Start-Process -FilePath "node.exe" -ArgumentList @($processHost, "--component", $Name, "--script", $script, "--instance-id", "$InstanceId-$Name", "--repository", $repoRoot, "--stop-file", $componentStopFile) -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden
  }
  Write-BurnInEvent "COMPONENT_STARTED" "$InstanceId-$Name" $Name
  return [ordered]@{
    component = $Name
    pid = $process.Id
    marker = $marker
    stopFile = $componentStopFile
    smoke = $Smoke
    instanceId = "$InstanceId-$Name"
    startedAt = [DateTime]::UtcNow.ToString("o")
    restartCount = $RestartCount
    consecutiveCrashes = $ConsecutiveCrashes
    status = "RUNNING"
    nextRestartAt = $null
    lastExitCode = $null
    lastExitReason = $null
    stableSince = [DateTime]::UtcNow.ToString("o")
  }
}

function Request-Stop {
  $requestedAt = [DateTime]::UtcNow
  New-Item -ItemType File -Force -Path $stopFile | Out-Null
  $state = Read-Json $supervisorFile
  if ($state -and (Test-OwnedProcess $state.pid "supervisor.ps1")) {
    $deadline = [DateTime]::UtcNow.AddSeconds($shutdownSeconds + 5)
    while ([DateTime]::UtcNow -lt $deadline -and (Get-Process -Id $state.pid -ErrorAction SilentlyContinue)) {
      Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Id $state.pid -ErrorAction SilentlyContinue) {
      Stop-Process -Id $state.pid -Force
    }
  }
  $recordedComponents = Read-Json $componentsFile
  foreach ($recordedComponent in @($recordedComponents)) {
    try { Stop-OwnedProcess $recordedComponent } catch { }
    $recordedComponent.pid = 0
    $recordedComponent.status = "STOPPED"
    $recordedComponent.lastExitReason = "RECOVERED_STOP"
    $recordedComponent.nextRestartAt = $null
  }
  if ($recordedComponents) {
    Write-AtomicJson $componentsFile @($recordedComponents)
  }
  Remove-Item -LiteralPath $supervisorFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
  Write-AtomicJson $lastSupervisorFile ([ordered]@{
    instanceId = if ($state -and $state.instanceId) { $state.instanceId } else { "none" }
    mode = if ($state -and $state.burnIn) { "BURN_IN" } else { "NORMAL" }
    state = "EXPECTED_STOPPED"
    stopReason = "REQUESTED"
    stoppedAt = $requestedAt.ToString("o")
  })
}

if ($Action -eq "Status") {
  $supervisor = Read-Json $supervisorFile
  $components = Read-Json $componentsFile
  [ordered]@{ supervisor = $supervisor; components = $components; stateModified = $false } | ConvertTo-Json -Depth 8
  exit 0
}

if ($Action -eq "Stop") { Request-Stop; exit 0 }
if ($Action -eq "Restart") { Request-Stop; $Action = "Start" }

if ($Action -eq "BurnInSmoke") { $BurnIn = $true }
if ($Action -in @("Run", "Start", "Restart", "Smoke", "BurnInSmoke")) {
  if ($env:WHATSAPP_WEB_DRY_RUN -ne "true") { throw "WHATSAPP_WEB_DRY_RUN_REQUIRED" }
  if ($env:WORKER_REQUIRE_REDIS -ne "true") { throw "WORKER_REQUIRE_REDIS_REQUIRED" }
}
if (-not $BurnIn -and $env:WORKER_BURN_IN_MODE -eq "true") {
  throw "BURN_IN_MODE_REQUIRES_EXPLICIT_COMMAND"
}
if ($BurnIn) {
  if ($env:WORKER_BURN_IN_MODE -ne "true") { throw "WORKER_BURN_IN_MODE_REQUIRED" }
  if ($env:WHATSAPP_WEB_DRY_RUN -ne "true") { throw "WHATSAPP_WEB_DRY_RUN_REQUIRED" }
  if ($env:WORKER_REQUIRE_REDIS -ne "true") { throw "WORKER_REQUIRE_REDIS_REQUIRED" }
  if ($Action -eq "BurnInSmoke" -and $TestLeaderKey -notmatch '^affiliate:test:worker:leader:[a-f0-9-]{16,80}$') {
    throw "BURN_IN_ISOLATED_TEST_KEY_REQUIRED"
  }
  if ($SessionId -notmatch '^[a-f0-9-]{16,80}$') { throw "BURN_IN_SESSION_ID_REQUIRED" }
}

if ($Action -eq "Start") {
  $existing = Read-Json $supervisorFile
  if ($existing -and (Test-OwnedProcess $existing.pid "supervisor.ps1")) {
    throw "SUPERVISOR_ALREADY_ACTIVE"
  }
  if ($existing) { Remove-Item -LiteralPath $supervisorFile -Force }
  $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath, "-Action", "Run")
  if ($BurnIn) { $arguments += "-BurnIn" }
  if ($BurnIn) { $arguments += @("-SessionId", $SessionId) }
  Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WorkingDirectory $repoRoot -WindowStyle Hidden | Out-Null
  exit 0
}

$smoke = $Action -eq "Smoke"
$burnInSmoke = $Action -eq "BurnInSmoke"
$boundedRun = $smoke -or $burnInSmoke
if (-not $smoke -and $NoJobs) { throw "NO_JOBS_ONLY_VALID_FOR_SMOKE" }
if ($smoke) { $NoJobs = $true }
$supervisorLock = $null
try {
  $supervisorLock = [System.IO.File]::Open(
    $lockFile,
    [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
} catch {
  throw "SUPERVISOR_ALREADY_ACTIVE"
}
$existing = Read-Json $supervisorFile
if ($existing -and (Test-OwnedProcess $existing.pid "supervisor.ps1")) { throw "SUPERVISOR_ALREADY_ACTIVE" }
if ($existing) { Remove-Item -LiteralPath $supervisorFile -Force }
Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue

$instanceId = [Guid]::NewGuid().ToString("N")
$startedAt = [DateTime]::UtcNow
$env:AFFILIATE_SUPERVISOR_MODE = if ($BurnIn) { "BURN_IN" } else { "NORMAL" }
$env:AFFILIATE_SUPERVISOR_INSTANCE_ID = $instanceId
$env:AFFILIATE_BURN_IN_SESSION_ID = $SessionId
if ($burnInSmoke) {
  $env:WORKER_BURN_IN_SMOKE = "true"
  $env:WORKER_LEADER_KEY_OVERRIDE = $TestLeaderKey
}
Write-AtomicJson $supervisorFile ([ordered]@{
  pid = $PID
  instanceId = $instanceId
  startedAt = $startedAt.ToString("o")
  repository = "configured"
  smoke = $smoke
  burnIn = [bool]$BurnIn
})
Write-SupervisorLog "info" "SUPERVISOR_STARTED" $instanceId
Write-BurnInEvent "SUPERVISOR_STARTED" $instanceId

$components = @(
  (Start-Component "dashboard" $instanceId $smoke $BurnIn),
  (Start-Component "worker" $instanceId $smoke $BurnIn)
)
Write-AtomicJson $componentsFile $components
$deadline = if ($boundedRun) { $startedAt.AddSeconds([Math]::Max(5, $DurationSeconds)) } else { [DateTime]::MaxValue }
$smokeRestartObserved = $false
$observedOwnedProcesses = 0
$maxConsecutiveCrashes = 0
$componentFailureObserved = $false
$runCompletedNormally = $false
$nextHealthObservation = [DateTime]::UtcNow

try {
  while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $stopFile)) {
    if ($BurnIn -and [DateTime]::UtcNow -ge $nextHealthObservation) {
      try {
        $live = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health/live" -TimeoutSec 2
        if ($live.status -eq "LIVE") { Write-BurnInEvent "LIVE_VALIDATED" $instanceId "monitor" }
      } catch { }
      try {
        $ready = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health/ready" -TimeoutSec 2
        if ($ready.mode -eq "BURN_IN" -and $ready.burnInActive -eq $true) {
          Write-BurnInEvent "READY_VALIDATED" $instanceId "monitor"
          if ($ready.lastHeartbeatAt) {
            $entry = [ordered]@{
              timestamp = [DateTime]::UtcNow.ToString("o")
              component = "monitor"
              event = "HEARTBEAT_OBSERVED"
              instanceId = $instanceId.Substring(0, [Math]::Min(12, $instanceId.Length))
              sessionId = $env:AFFILIATE_BURN_IN_SESSION_ID
              heartbeatAt = $ready.lastHeartbeatAt
            }
            ($entry | ConvertTo-Json -Compress) | Add-Content -LiteralPath $burnInEventFile -Encoding utf8
          }
        }
      } catch { }
      $nextHealthObservation = [DateTime]::UtcNow.AddSeconds(2)
    }
    for ($index = 0; $index -lt $components.Count; $index++) {
      $component = $components[$index]
      if ($component.status -eq "FAILED") { continue }
      $process = Get-Process -Id $component.pid -ErrorAction SilentlyContinue
      if ($process) {
        if (Test-OwnedProcess $component.pid $component.marker) {
          $observedOwnedProcesses += 1
        }
        $stableSince = [DateTime]::Parse($component.stableSince).ToUniversalTime()
        if ($component.consecutiveCrashes -gt 0 -and [DateTime]::UtcNow -ge $stableSince.AddSeconds($stableResetSeconds)) {
          $component.consecutiveCrashes = 0
          $component.nextRestartAt = $null
          Write-SupervisorLog "info" "COMPONENT_STABILITY_RESET" $instanceId $component.component
          Write-BurnInEvent "COMPONENT_STABILITY_RESET" $component.instanceId $component.component
          Write-AtomicJson $componentsFile $components
        }
        continue
      }
      $component.consecutiveCrashes = [int]$component.consecutiveCrashes + 1
      $maxConsecutiveCrashes = [Math]::Max($maxConsecutiveCrashes, [int]$component.consecutiveCrashes)
      $component.lastExitReason = "CRASH"
      $component.lastExitCode = 1
      Write-BurnInEvent "COMPONENT_EXITED_UNEXPECTEDLY" $component.instanceId $component.component
      if ($component.consecutiveCrashes -ge $maxCrashes) {
        $componentFailureObserved = $true
        $component.status = "FAILED"
        $component.pid = 0
        $component.nextRestartAt = $null
        Write-SupervisorLog "error" "COMPONENT_FAILED_PERMANENTLY" $instanceId $component.component "CRASH_LIMIT_REACHED"
      } else {
        $backoffSeconds = [Math]::Min(60, [Math]::Pow(2, $component.consecutiveCrashes - 1))
        $component.status = "BACKOFF"
        $component.nextRestartAt = [DateTime]::UtcNow.AddSeconds($backoffSeconds).ToString("o")
        Write-AtomicJson $componentsFile $components
        if (-not (Wait-Interruptible $backoffSeconds)) { break }
        $replacement = Start-Component $component.component $instanceId $smoke $BurnIn ([int]$component.restartCount + 1) $component.consecutiveCrashes
        $components[$index] = $replacement
        if ($smoke) { $smokeRestartObserved = $true }
        Write-SupervisorLog "warn" "COMPONENT_RESTARTED" $instanceId $component.component "PROCESS_EXITED"
      }
      Write-AtomicJson $componentsFile $components
    }
    Start-Sleep -Milliseconds 250
  }
  $runCompletedNormally = $true
} finally {
  foreach ($component in $components) {
    try { Stop-OwnedProcess $component } catch {
      Write-SupervisorLog "error" "COMPONENT_STOP_FAILED" $instanceId $component.component "OWNED_PROCESS_STOP_FAILED"
    }
  }
  foreach ($component in $components) {
    $component.pid = 0
    $component.status = "STOPPED"
    $component.lastExitReason = if ($runCompletedNormally) { "REQUESTED" } else { "UNEXPECTED_EXIT" }
    $component.nextRestartAt = $null
  }
  Write-AtomicJson $componentsFile $components
  Write-SupervisorLog "info" "SUPERVISOR_STOPPED" $instanceId
  Write-BurnInEvent "SUPERVISOR_STOPPED" $instanceId
  Write-AtomicJson $lastSupervisorFile ([ordered]@{
    instanceId = $instanceId
    mode = if ($BurnIn) { "BURN_IN" } else { "NORMAL" }
    state = if ($runCompletedNormally) { "EXPECTED_STOPPED" } else { "HUMAN_REVIEW_REQUIRED" }
    stopReason = if (-not $runCompletedNormally) { "UNEXPECTED_EXIT" } elseif ($boundedRun) { "BOUNDED_RUN_COMPLETED" } else { "REQUESTED" }
    startedAt = $startedAt.ToString("o")
    stoppedAt = [DateTime]::UtcNow.ToString("o")
  })
  Remove-Item -LiteralPath $supervisorFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
  if ($supervisorLock) {
    $supervisorLock.Dispose()
    $supervisorLock = $null
  }
}

if ($smoke) {
  $pidValidated = $observedOwnedProcesses -gt 0
  $heartbeatValidated = $observedOwnedProcesses -ge 2
  $smokeSucceeded = $smokeRestartObserved -and $pidValidated -and $heartbeatValidated
  [ordered]@{
    status = if ($smokeSucceeded) { "SMOKE_SUCCEEDED" } else { "SMOKE_FAILED" }
    pidValidated = $pidValidated
    heartbeatValidated = $heartbeatValidated
    restartValidated = $smokeRestartObserved
    ownedProcessObservations = $observedOwnedProcesses
    maxConsecutiveCrashes = $maxConsecutiveCrashes
    noJobs = [bool]$NoJobs
  } | ConvertTo-Json -Compress
  if (-not $smokeSucceeded) { exit 2 }
}

if ($burnInSmoke) {
  $burnInSupervisorSucceeded = $observedOwnedProcesses -gt 0 -and -not $componentFailureObserved
  [ordered]@{
    status = if ($burnInSupervisorSucceeded) { "BURN_IN_SUPERVISOR_COMPLETED" } else { "BURN_IN_SUPERVISOR_FAILED" }
    ownedProcessObservations = $observedOwnedProcesses
    maxConsecutiveCrashes = $maxConsecutiveCrashes
  } | ConvertTo-Json -Compress
  if (-not $burnInSupervisorSucceeded) { exit 2 }
}
