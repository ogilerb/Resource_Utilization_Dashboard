<#
.SYNOPSIS
  Register the Windows telemetry agent as a scheduled task that runs at boot/logon.
.NOTES
  Run in an elevated PowerShell. Requires config.json next to this script
  (copy config.example.json and fill in endpoint + apiKey).
#>
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$agentPs1  = Join-Path $scriptDir 'agent.ps1'
$taskXml   = Join-Path $scriptDir 'telemetry-agent-task.xml'
$taskName  = 'TelemetryAgent'

if (-not (Test-Path (Join-Path $scriptDir 'config.json'))) {
  Write-Error "config.json not found. Copy config.example.json and fill it in first."
  exit 1
}

# Inject the absolute agent path into a temp copy of the task XML.
$xml = (Get-Content $taskXml -Raw).Replace('__AGENT_PS1__', $agentPs1)
$tmp = Join-Path $env:TEMP 'telemetry-agent-task.xml'
Set-Content -Path $tmp -Value $xml -Encoding Unicode

schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null
schtasks.exe /Create /TN $taskName /XML $tmp /F
schtasks.exe /Run /TN $taskName

Write-Host "Installed and started scheduled task '$taskName'."
Write-Host "Manage with: schtasks /Query /TN $taskName  |  schtasks /End /TN $taskName"
