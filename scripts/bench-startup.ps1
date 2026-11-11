# Startup time + idle memory of the desktop app (process tree: app + renderer/WebView2 children).
# usage: powershell -File scripts/bench-startup.ps1 -Exe <path> [-Args '.'] [-Runs 5]
param([string]$Exe, [string]$AppArgs = '', [int]$Runs = 5)
function Tree($rootId) {
  $all = Get-CimInstance Win32_Process
  $ids = @($rootId); $i = 0
  while ($i -lt $ids.Count) { $ids += ($all | Where-Object { $_.ParentProcessId -eq $ids[$i] }).ProcessId; $i++ }
  $ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
}
$res = @()
for ($r = 0; $r -lt $Runs; $r++) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = if ($AppArgs) { Start-Process $Exe -ArgumentList $AppArgs -PassThru } else { Start-Process $Exe -PassThru }
  $ready = $null
  while ($sw.ElapsedMilliseconds -lt 30000) {
    $p.Refresh()
    if ($p.MainWindowHandle -ne 0 -and $p.MainWindowTitle -like 'IHatePDF*') { $ready = $sw.ElapsedMilliseconds; break }
    Start-Sleep -Milliseconds 25
  }
  Start-Sleep -Seconds 6
  $procs = Tree $p.Id
  $ws = ($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB
  $pm = ($procs | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB
  $res += [pscustomobject]@{ run = $r; windowMs = $ready; procs = @($procs).Count; workingSetMB = [math]::Round($ws); privateMB = [math]::Round($pm) }
  Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in $procs.Id } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}
$res | Format-Table -AutoSize
"median windowMs: " + (($res.windowMs | Sort-Object)[[int]($Runs / 2)]) + "  median workingSetMB: " + (($res.workingSetMB | Sort-Object)[[int]($Runs / 2)])
