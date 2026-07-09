<#
.SYNOPSIS
  Windows telemetry collection agent. Gathers CPU% and used memory via CIM/WMI
  and POSTs to /api/ingest/compute on an interval, with buffer-and-retry to disk
  so datapoints survive network outages and restarts.

.NOTES
  Config is read from config.json next to this script (copy config.example.json).
  Runs as an internal loop; the Task Scheduler definition keeps it alive across
  logon/wake and restarts it on failure.

  On sleep the process is suspended and produces no data (correct — no
  utilization to report); the server flags the resource offline from last_seen.
#>

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $scriptDir 'config.json'

if (-not (Test-Path $configPath)) {
  Write-Error "config.json not found at $configPath. Copy config.example.json and fill it in."
  exit 1
}
$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
$endpoint = ($cfg.endpoint.TrimEnd('/')) + '/api/ingest/compute'
$intervalSeconds = [int]$cfg.intervalSeconds
if ($intervalSeconds -lt 1) { $intervalSeconds = 15 }
$bufferFile = $cfg.bufferFile
$maxBuffer = 5000

if ($bufferFile) {
  $bufDir = Split-Path -Parent $bufferFile
  if ($bufDir -and -not (Test-Path $bufDir)) { New-Item -ItemType Directory -Force -Path $bufDir | Out-Null }
}

function Get-Metric {
  $cpu = (Get-CimInstance -ClassName Win32_Processor |
    Measure-Object -Property LoadPercentage -Average).Average
  $os = Get-CimInstance -ClassName Win32_OperatingSystem
  $usedKb = $os.TotalVisibleMemorySize - $os.FreePhysicalMemory
  return [ordered]@{
    cpu_percent  = [double]$cpu
    memory_bytes = [int64]$usedKb * 1024
    timestamp    = (Get-Date).ToUniversalTime().ToString('o')
  }
}

function Read-Buffer {
  if ($bufferFile -and (Test-Path $bufferFile)) {
    $lines = Get-Content $bufferFile -ErrorAction SilentlyContinue |
      Where-Object { $_ -and $_.Trim() -ne '' }
    if ($lines.Count -gt $maxBuffer) { $lines = $lines[-$maxBuffer..-1] }
    return [System.Collections.ArrayList]@($lines)
  }
  return [System.Collections.ArrayList]@()
}

function Save-Buffer($buf) {
  if ($bufferFile) { Set-Content -Path $bufferFile -Value $buf }
}

$headers = @{ 'x-api-key' = $cfg.apiKey; 'content-type' = 'application/json' }
$buffer = Read-Buffer
Write-Host "[agent] pushing to $endpoint every ${intervalSeconds}s"

while ($true) {
  try {
    $metric = Get-Metric
    [void]$buffer.Add(($metric | ConvertTo-Json -Compress))
    if ($buffer.Count -gt $maxBuffer) { $buffer = [System.Collections.ArrayList]@($buffer[-$maxBuffer..-1]) }

    # Flush oldest-first; stop on the first failure and keep the rest buffered.
    while ($buffer.Count -gt 0) {
      $point = $buffer[0]
      try {
        Invoke-RestMethod -Uri $endpoint -Method Post -Headers $headers -Body $point -TimeoutSec 10 | Out-Null
        $buffer.RemoveAt(0)
      } catch {
        Write-Warning "[agent] flush paused ($($_.Exception.Message)); $($buffer.Count) queued"
        break
      }
    }
    Save-Buffer $buffer
  } catch {
    Write-Warning "[agent] tick error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $intervalSeconds
}
