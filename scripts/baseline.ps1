# Day 1 / Day 10 / Day 15 baseline: does installing and using IHatePDF slow a PC down over time? See docs/USAGE_LOG.md, "Checking the PC over time".
# Run it the same way each time: right after a restart, with nothing else open, then leave the PC alone until it finishes (~1 minute).
# Usage (PowerShell):  powershell -ExecutionPolicy Bypass -File baseline.ps1 -Label "Day 1"
# Each run adds one row to baseline.csv next to this script.
param([string]$Label = "run")

$exe = "C:\Program Files\IHatePDF\IHatePDF.exe"
$csv = Join-Path $PSScriptRoot "baseline.csv"
$os = Get-CimInstance Win32_OperatingSystem
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"

Start-Sleep 20   # let Windows settle after login
$availMB = (Get-Counter '\Memory\Available MBytes').CounterSamples[0].CookedValue
$cpuAvg = ((Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 2 -MaxSamples 5).CounterSamples.CookedValue | Measure-Object -Average).Average
$cpuIdle = [math]::Round($cpuAvg, 1)

# App: time until its window appears, then its memory after 10 s on the home screen.
Get-Process IHatePDF -ErrorAction SilentlyContinue | Stop-Process -Force
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Process $exe
$win = $null
while ($sw.Elapsed.TotalSeconds -lt 120 -and -not $win) {
  $win = Get-Process IHatePDF -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'IHatePDF*' }
  Start-Sleep -Milliseconds 200
}
$startS = [math]::Round($sw.Elapsed.TotalSeconds, 1)
Start-Sleep 10
$appMB = [math]::Round((Get-Process IHatePDF | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
Get-Process IHatePDF | Stop-Process -Force

$installMB = [math]::Round((Get-ChildItem "C:\Program Files\IHatePDF" -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
$dataDir = Join-Path $env:APPDATA "ihatepdf"
$dataMB = if (Test-Path $dataDir) { [math]::Round((Get-ChildItem $dataDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB, 1) } else { 0 }
$ver = (Get-Item $exe).VersionInfo.ProductVersion

$row = [pscustomobject]@{
  Label = $Label; Date = (Get-Date -Format 'yyyy-MM-dd HH:mm'); AppVersion = $ver
  UptimeMin = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalMinutes)
  RamTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
  RamInUseGB = [math]::Round(($os.TotalVisibleMemorySize / 1KB - $availMB) / 1024, 1)
  CpuBusyPct = $cpuIdle
  DiskFreeGB = [math]::Round($disk.FreeSpace / 1GB, 1)
  AppStartS = $startS; AppIdleMB = $appMB; AppInstallMB = $installMB; AppDataMB = $dataMB
}
$row | Export-Csv $csv -Append -NoTypeInformation
$row | Format-List
"Saved to $csv"
