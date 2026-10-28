# Read-only named-process query. No command lines, environment, termination or helper launch.
$queryStart = [DateTimeOffset]::Now.ToString('o')
$queryRows = @()
$queryError = $null
try {
  $queryProcesses = [System.Diagnostics.Process]::GetProcessesByName('psr-l2-member-diag')
  foreach ($queryProcess in $queryProcesses) {
    try {
      $queryRows += [ordered]@{ pid = $queryProcess.Id; pathMatches = [String]::Equals($queryProcess.MainModule.FileName, 'C:\Users\30591\Documents\ChatGPT\装修进度验收APP\artifacts\psr-l2\member-diag-v2\psr-l2-member-diag.exe', [StringComparison]::OrdinalIgnoreCase); pathReadable = $true }
    } catch { $queryRows += [ordered]@{ pid = $queryProcess.Id; pathMatches = $null; pathReadable = $false } }
    finally { $queryProcess.Dispose() }
  }
} catch { $queryError = 'QUERY_FAILED' }
[ordered]@{ schema='codex-l2-member-current-presence/1'; startedAt=$queryStart; endedAt=[DateTimeOffset]::Now.ToString('o'); queriedName='psr-l2-member-diag'; queryError=$queryError; matches=@($queryRows); noNamedHelperObserved=($null -eq $queryError -and $queryRows.Count -eq 0); historicalJobCleanupConfirmed=$false; processTerminated=$false } | ConvertTo-Json -Depth 5
