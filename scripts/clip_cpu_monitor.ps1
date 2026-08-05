# Monitors ClipSync desktop process CPU and writes a CSV log.
# Usage: .\scripts\clip_cpu_monitor.ps1 -DurationMinutes 120
param(
    [int]$DurationMinutes = 120,
    [int]$IntervalSeconds = 30
)

$logFile = "$PSScriptRoot\..\tmp\clip_cpu_log.csv"
New-Item -ItemType Directory -Force -Path (Split-Path $logFile) | Out-Null
"timestamp,process,pid,cpu_percent,working_set_mb,thread_count" | Out-File -FilePath $logFile -Encoding utf8

$end = (Get-Date).AddMinutes($DurationMinutes)
while ((Get-Date) -lt $end) {
    $procs = Get-Process -Name "clipsync-desktop" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        try {
            $c = (Get-Counter "\Process($($p.ProcessName))\% Processor Time" -ErrorAction SilentlyContinue).CounterSamples[0].CookedValue
            $cpu = [math]::Round($c, 2)
            $ws = [math]::Round($p.WorkingSet64 / 1MB, 1)
            $tc = $p.Threads.Count
            "$((Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),$($p.ProcessName),$($p.Id),$cpu,$ws,$tc" | Out-File -FilePath $logFile -Append -Encoding utf8
        } catch {
            "$((Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),$($p.ProcessName),$($p.Id),ERR,$_,$tc" | Out-File -FilePath $logFile -Append -Encoding utf8
        }
    }
    Start-Sleep -Seconds $IntervalSeconds
}
Write-Host "Log written to $logFile"
