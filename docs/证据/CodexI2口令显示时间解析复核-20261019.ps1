param([string]$Out)
$ErrorActionPreference='Stop'
# 只验证时间解析，不读取口令/凭据，不启动任何外部程序或云调用。
$taskRaw='{"expires":"2026-10-19T05:30:00.0000000Z"}'
$taskAuto=$taskRaw | ConvertFrom-Json
$taskStrings=$taskRaw | ConvertFrom-Json -DateKind String
if ($taskStrings.expires -isnot [string]) { throw 'STRING_MODE_REQUIRED' }
$taskExpires=[DateTimeOffset]::Parse($taskStrings.expires,[Globalization.CultureInfo]::InvariantCulture)
$taskNow=[DateTimeOffset]::Parse('2026-10-19T05:01:58Z',[Globalization.CultureInfo]::InvariantCulture)
$taskBad=[DateTime]::Parse($taskAuto.expires).ToUniversalTime().AddMinutes(-5)
$taskGood=$taskExpires.ToUniversalTime().AddMinutes(-5)
if ($taskGood.ToString('o') -ne '2026-10-19T05:25:00.0000000+00:00') {throw 'DEADLINE_MISMATCH'}
if ($taskNow -ge $taskGood) {throw 'VALID_WINDOW_FALSE_REJECTION'}
$taskCases=@('2026-10-19T05:24:59Z','2026-10-19T05:25:00Z','2026-10-19T05:25:01Z')
$taskExpect=@($true,$false,$false)
$taskResults=@()
for ($taskI=0;$taskI -lt $taskCases.Length;$taskI++) {
 $taskAllowed=[DateTimeOffset]::Parse($taskCases[$taskI]) -lt $taskGood
 if ($taskAllowed -ne $taskExpect[$taskI]) {throw 'BOUNDARY_MISMATCH'}
 $taskResults += [ordered]@{now=$taskCases[$taskI];allowDisplay=$taskAllowed;expected=$taskExpect[$taskI]}
}
$taskReport=[ordered]@{schema='codex-local-time-parsing-proof/1';testedAt=[DateTime]::UtcNow.ToString('o');runtime=$PSVersionTable.PSVersion.ToString();localZone=[TimeZoneInfo]::Local.Id;autoType=$taskAuto.expires.GetType().FullName;autoKind=$taskAuto.expires.Kind.ToString();incorrectReparseDeadline=$taskBad.ToString('o');correctUtcDeadline=$taskGood.ToString('o');actualTimeAtFailure=$taskNow.ToString('o');falseRejectionReproduced=($taskNow.UtcDateTime -ge $taskBad);correctedAllowsActualTime=($taskNow -lt $taskGood);boundaryCases=$taskResults;secretRead=$false;networkUsed=$false;ok=$true}
$taskJson=($taskReport | ConvertTo-Json -Depth 6)+"`n"
if ($Out) { $taskBytes=[Text.Encoding]::UTF8.GetBytes($taskJson);$taskStream=[IO.File]::Open([IO.Path]::GetFullPath($Out),[IO.FileMode]::CreateNew);try {$taskStream.Write($taskBytes,0,$taskBytes.Length)} finally {$taskStream.Dispose()};Write-Output '时间解析反例及修正边界通过；未读口令、未联网。' } else {$taskJson}
