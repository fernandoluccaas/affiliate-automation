param(
  [ValidateSet("Status", "Preflight", "Run")]
  [string]$Action = "Status"
)

$ErrorActionPreference = "Stop"
$enabled = $env:CLOUDFLARE_NAMED_TUNNEL_ENABLED -eq "true"
$tunnelName = if ($env:CLOUDFLARE_TUNNEL_NAME) { $env:CLOUDFLARE_TUNNEL_NAME.Trim() } else { "" }
$hostname = if ($env:CLOUDFLARE_PUBLIC_HOSTNAME) { $env:CLOUDFLARE_PUBLIC_HOSTNAME.Trim().ToLowerInvariant() } else { "" }
$trackingBase = if ($env:PUBLIC_TRACKING_BASE_URL) { $env:PUBLIC_TRACKING_BASE_URL.Trim() } else { "" }
$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
$validName = $tunnelName -match '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$'
$validHostname = $hostname -match '^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$' -and -not $hostname.EndsWith('.trycloudflare.com')
$trackingMatches = $trackingBase -eq "https://$hostname" -or $trackingBase -eq "https://$hostname/"

if ($Action -eq "Status") {
  [ordered]@{
    status = if ($enabled) { "CONFIGURED" } else { "OFF" }
    enabled = $enabled
    binaryAvailable = $null -ne $cloudflared
    tunnelNameConfigured = [bool]$validName
    stableHostnameConfigured = [bool]$validHostname
    publicTrackingMatches = [bool]$trackingMatches
    credentialsDisplayed = $false
    externalRequests = 0
    stateModified = $false
  } | ConvertTo-Json -Compress
  exit 0
}

if (-not $enabled) { throw "CLOUDFLARE_NAMED_TUNNEL_DISABLED" }
if (-not $cloudflared) { throw "CLOUDFLARED_NOT_FOUND" }
if (-not $validName) { throw "CLOUDFLARE_TUNNEL_NAME_INVALID" }
if (-not $validHostname -or -not $trackingMatches) { throw "CLOUDFLARE_STABLE_HOSTNAME_INVALID" }

if ($Action -eq "Preflight") {
  function Test-EndpointResponds([string]$Uri, [int]$TimeoutSeconds, [int]$MaximumRedirection = 0) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -Method Head -MaximumRedirection $MaximumRedirection -TimeoutSec $TimeoutSeconds -ErrorAction Stop
      return [int]$response.StatusCode -lt 500
    } catch {
      $statusCode = $_.Exception.Response.StatusCode.value__
      return $statusCode -and [int]$statusCode -lt 500
    }
  }
  $localUrl = if ($env:APP_BASE_URL) { $env:APP_BASE_URL.TrimEnd('/') } else { "http://localhost:3000" }
  $localHealthy = Test-EndpointResponds $localUrl 5 0
  $publicHealthy = Test-EndpointResponds "https://$hostname/go/readiness-check" 8 0
  [ordered]@{
    status = if ($localHealthy -and $publicHealthy) { "READY" } else { "BLOCKED" }
    binaryAvailable = $true
    tunnelNameConfigured = $true
    stableHostnameConfigured = $true
    localDashboardResponding = $localHealthy
    publicTrackingResponding = $publicHealthy
    credentialsDisplayed = $false
    stateModified = $false
  } | ConvertTo-Json -Compress
  exit 0
}

& $cloudflared.Source tunnel run $tunnelName
exit $LASTEXITCODE
