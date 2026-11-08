# Samples, once per second, the GPU video-encode engine utilisation of every process belonging to the app
# (descendants of -RootPid) plus the app's CPU use. Prints one JSON line when done.
param([int]$RootPid, [int]$Seconds = 12)
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$set = @{ $RootPid = $true }
do { $n = $set.Count; foreach ($p in $all) { if ($set.ContainsKey([int]$p.ParentProcessId)) { $set[[int]$p.ProcessId] = $true } } } while ($set.Count -ne $n)
$byLuid = @{}; $prev = @{}; $cpu = @()
for ($i = 0; $i -lt $Seconds; $i++) {
  try { $s = (Get-Counter '\GPU Engine(*engtype_VideoEncode)\Utilization Percentage' -ErrorAction Stop).CounterSamples } catch { $s = @() }
  foreach ($c in $s) {
    if ($c.InstanceName -notmatch 'pid_(\d+)_luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)') { continue }
    if (-not $set.ContainsKey([int]$Matches[1])) { continue }
    $l = $Matches[2]; if (-not $byLuid.ContainsKey($l)) { $byLuid[$l] = @() }
    $byLuid[$l] += [double]$c.CookedValue
  }
  $d = 0.0; foreach ($id in @($set.Keys)) { $pr = Get-Process -Id $id -ErrorAction SilentlyContinue; if (-not $pr) { continue }; $c = $pr.TotalProcessorTime.TotalSeconds; if ($prev.ContainsKey($id)) { $d += [math]::Max(0, $c - $prev[$id]) }; $prev[$id] = $c }
  if ($i -eq 1) { $sw = [Diagnostics.Stopwatch]::StartNew() }; if ($i -gt 0) { $cpu += $d }
  Start-Sleep -Milliseconds 500
}
$enc = @{}; foreach ($k in $byLuid.Keys) { $v = $byLuid[$k]; $enc[$k] = @{ max = ($v | Measure-Object -Maximum).Maximum; avg = [math]::Round(($v | Measure-Object -Average).Average, 1); samples = $v.Count } }
# adapter memory per LUID, to tell the big discrete card from the integrated GPU
$mem = @{}; try { foreach ($c in (Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage').CounterSamples) { if ($c.InstanceName -match 'luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)') { $mem[$Matches[1]] = [math]::Round($c.CookedValue / 1MB) } } } catch {}
@{ encodeByLuid = $enc; dedicatedMB = $mem; appCpuCores = [math]::Round((($cpu | Measure-Object -Sum).Sum) / [math]::Max(0.1, $sw.Elapsed.TotalSeconds), 2); appPids = $set.Count } | ConvertTo-Json -Depth 5 -Compress
