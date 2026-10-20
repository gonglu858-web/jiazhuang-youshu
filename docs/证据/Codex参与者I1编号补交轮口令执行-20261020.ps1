param([ValidateSet('Check','Show','Cleanup')][string]$Mode='Check')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$taskBase='Codex参与者I1编号补交轮'
$taskPrepPath=Join-Path $PSScriptRoot ($taskBase+'包准备-20261020.json')
function Read-PicJson([string]$p){return ([IO.File]::ReadAllText($p)|ConvertFrom-Json -DateKind String)}
function PicSha([string]$p){return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}
function Save-PicJson([string]$p,$v){$b=[Text.Encoding]::UTF8.GetBytes(($v|ConvertTo-Json -Depth 8)+"`n");$s=[IO.File]::Open($p,[IO.FileMode]::CreateNew);try{$s.Write($b,0,$b.Length)}finally{$s.Dispose()}}
$taskPrep=Read-PicJson $taskPrepPath
if($taskPrep.plan.checkRoundId -cne 'i1handoff-20261020-863ca4553633'){throw 'ROUND_MISMATCH'}
$taskFrozen=Read-PicJson (Join-Path $PSScriptRoot ($taskBase+'执行脚本冻结-20261020.json'))
if($taskFrozen.roundId -cne $taskPrep.plan.checkRoundId -or $taskFrozen.planSha256 -cne $taskPrep.planSha256 -or $taskFrozen.manifestSha256 -cne $taskPrep.manifestSha256){throw 'FREEZE_BINDING_MISMATCH'}
foreach($entry in $taskFrozen.scripts){if((PicSha (Join-Path $PSScriptRoot $entry.name)) -cne $entry.sha256){throw 'SCRIPT_DRIFT'}}
if((PicSha $taskPrep.planPath) -cne $taskPrep.planSha256 -or (PicSha (Join-Path $taskPrep.packageDir 'manifest.json')) -cne $taskPrep.manifestSha256){throw 'PACKAGE_DRIFT'}
Import-Module (Join-Path $PSScriptRoot 'CodexI2口令执行辅助-20261019.psm1') -Force
$taskRound=$taskPrep.plan.checkRoundId
$taskControl=[IO.Path]::GetFullPath((Split-Path -Parent $taskPrep.planPath))
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if(-not $taskControl.StartsWith((Join-Path $taskRoot 'artifacts/schedule-sandbox/') ,[StringComparison]::OrdinalIgnoreCase)){throw 'CONTROL_PATH_INVALID'}
$taskParent=Get-Item -LiteralPath $taskControl
while($taskParent){if(($taskParent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'CONTROL_LINK_REJECTED'};$taskParent=$taskParent.Parent}
$taskDisplay=Join-Path $taskControl '本轮1号临时口令-核验后删除.txt'
$taskAttempt=Join-Path $PSScriptRoot ($taskBase+'口令显示尝试-20261020.json')
$taskShown=Join-Path $PSScriptRoot ($taskBase+'口令显示-20261020.json')
if($Mode -eq 'Cleanup'){
 $close=Read-PicJson (Join-Path $PSScriptRoot ($taskBase+'字节核对-20261020.closed.json'))
 if($close.roundId -cne $taskRound -or $close.matched -ne 8 -or $close.status -cne 'REMOTE_FILES_MATCH_FROZEN_I2_PACKAGE'){throw 'CLOSE_NOT_VERIFIED'}
 if(Test-Path -LiteralPath $taskDisplay){
  $shown=Read-PicJson $taskShown
  if($shown.roundId -cne $taskRound -or $shown.displayPath -cne $taskDisplay -or (PicSha $taskDisplay) -cne $shown.displaySha256){throw 'DISPLAY_FILE_CHANGED_PRESERVED'}
  if(((Get-Item -LiteralPath $taskDisplay).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'DISPLAY_LINK_REJECTED'}
  Remove-Item -LiteralPath $taskDisplay
 }
 Save-PicJson (Join-Path $PSScriptRoot ($taskBase+'口令清理-20261020.json')) ([ordered]@{roundId=$taskRound;cleanedAt=[DateTimeOffset]::UtcNow.ToString('o');plaintextFileAbsent=(-not (Test-Path -LiteralPath $taskDisplay));notepadMemoryNotClaimedCleared=$true})
 '{"ok":true,"plaintextFileAbsent":true}';exit 0
}
$taskGate=Get-PicDisplayGate $taskPrep.plan.windowStartsAtIso $taskPrep.plan.windowExpiresAtIso ([DateTimeOffset]::UtcNow)
if($Mode -eq 'Check'){
 [ordered]@{ok=$true;roundId=$taskRound;timeInputType=$taskPrep.plan.windowExpiresAtIso.GetType().FullName;timeGuard=$taskGate;secretRead=$false;notepadStarted=$false;moduleHash=(PicSha (Join-Path $PSScriptRoot 'CodexI2口令执行辅助-20261019.psm1'))}|ConvertTo-Json -Depth 5
 exit 0
}
$taskApproval=Read-PicJson (Join-Path $PSScriptRoot ($taskBase+'批准-20261020.json'))
if($taskApproval.approved -ne $true -or $taskApproval.roundId -cne $taskRound -or $taskApproval.planSha256 -cne $taskPrep.planSha256 -or $taskApproval.manifestSha256 -cne $taskPrep.manifestSha256){throw 'APPROVAL_MISMATCH'}
$taskPreview=Read-PicJson (Join-Path $PSScriptRoot ($taskBase+'手动预览-20261020.json'))
if($taskPreview.roundId -cne $taskRound -or $taskPreview.manualPreviewReportedSuccess -ne $true){throw 'PREVIEW_NOT_CONFIRMED'}
if($taskPreview.mobilePreviewConfirmed -ne $true -or $taskPreview.mobilePreviewBuildId -cne $taskPrep.preview.previewBuildId -or $taskPreview.mobileConfiguredRound -cne $taskRound -or $taskPreview.participantCode -cne '1'){throw 'MOBILE_PREVIEW_VERSION_NOT_CONFIRMED'}
$taskRemote=Read-PicJson (Join-Path $PSScriptRoot ($taskBase+'部署关闭-20261020.candidate.json'))
$taskVerified=Read-PicJson (Join-Path $PSScriptRoot ($taskBase+'字节核对-20261020.candidate.json'))
if($taskRemote.roundId -cne $taskRound -or $taskVerified.roundId -cne $taskRound -or $taskVerified.matched -ne 4 -or $taskVerified.archiveSha256 -cne $taskRemote.archive.platformCodeSha256 -or $taskVerified.wxServerSdk -cne '3.0.1' -or $taskVerified.databaseVersion -cne '1.4.1'){throw 'CANDIDATE_NOT_VERIFIED'}
foreach($f in $taskVerified.files){$expected=@($taskPrep.files|Where-Object {$_.rel -ceq ('server/scheduleSandbox/'+$f.path)});if($expected.Count -ne 1 -or $expected[0].sha256 -cne $f.sha256 -or $expected[0].bytes -ne $f.bytes){throw 'CANDIDATE_FILE_MISMATCH'}}
if((Test-Path -LiteralPath (Join-Path $PSScriptRoot ($taskBase+'部署关闭-20261020.closed.started.json'))) -or (Test-Path -LiteralPath $taskAttempt) -or (Test-Path -LiteralPath $taskDisplay)){throw 'ROUND_OR_DISPLAY_ALREADY_USED'}
if(-not $taskGate.allowed){throw 'DISPLAY_WINDOW_NOT_READY'}
Save-PicJson $taskAttempt ([ordered]@{roundId=$taskRound;startedAt=[DateTimeOffset]::UtcNow.ToString('o');intent='one local passphrase display after verified deployment';secretNotYetRead=$true})
$taskContext=@{starts=$taskPrep.plan.windowStartsAtIso;expires=$taskPrep.plan.windowExpiresAtIso;digest=$taskPrep.plan.passphraseDigest}
$script:picFileCreated=$false
$taskRead={
 if([IO.Path]::GetFullPath($taskPrep.passphrase.encryptedPath) -cne (Join-Path $taskControl 'passphrase.dpapi')){throw 'CIPHER_PATH_INVALID'}
 $sec=ConvertTo-SecureString -String ([IO.File]::ReadAllText($taskPrep.passphrase.encryptedPath));$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
 try{return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
}
$taskWrite={param($value)
 $s=[IO.File]::Open($taskDisplay,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$script:picFileCreated=$true
 try{$b=[Text.Encoding]::UTF8.GetBytes("仅供1号本人，本轮863ca4553633。只提交一次。`r`n如愿意交付完整编号，请本人先勾选。`r`n临时口令：`r`n"+$value+"`r`n结果出现后立即停止并告知Codex关闭。勿截图/转发口令。");$s.Write($b,0,$b.Length)}finally{$s.Dispose();if($b){[Array]::Clear($b,0,$b.Length)}}
}
$taskLaunch={return (Start-Process -FilePath 'notepad.exe' -ArgumentList @('"'+$taskDisplay+'"') -WindowStyle Normal -PassThru).Id}
$taskRemove={if($script:picFileCreated -and (Test-Path -LiteralPath $taskDisplay)){Remove-Item -LiteralPath $taskDisplay}}
try{
 $result=Invoke-PicDisplayOnce $taskContext {[DateTimeOffset]::UtcNow} $taskRead $taskWrite $taskLaunch $taskRemove
 Save-PicJson $taskShown ([ordered]@{roundId=$taskRound;requestedAt=[DateTimeOffset]::UtcNow.ToString('o');displayPath=$taskDisplay;displaySha256=(PicSha $taskDisplay);processId=$result.processId;displayDeadlineUtc=$result.displayDeadlineUtc;displayedToUserConfirmed=$false;plaintextEmitted=$false;cleanupRequired=$true})
 '{"ok":true,"notepadLaunchRequested":true,"secretEmitted":false}'
}catch{
 & $taskRemove
 Save-PicJson (Join-Path $PSScriptRoot ($taskBase+'口令显示失败-20261020.json')) ([ordered]@{roundId=$taskRound;failedAt=[DateTimeOffset]::UtcNow.ToString('o');code='LOCAL_DISPLAY_FAILED';plaintextFileRemains=(Test-Path -LiteralPath $taskDisplay);requiresClose=$true})
 throw 'LOCAL_DISPLAY_FAILED_CLOSE_REQUIRED'
}
