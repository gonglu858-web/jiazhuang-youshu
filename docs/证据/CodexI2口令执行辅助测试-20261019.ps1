param([string]$Out)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'CodexI2口令执行辅助-20261019.psm1') -Force
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$testDir=Join-Path $root ('artifacts/schedule-sandbox/passphrase-local-test-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testDir)|Out-Null
$rows=@();$starts='2026-10-19T05:00:00.0000000Z';$expires='2026-10-19T05:30:00.0000000Z'
foreach($case in @(@('2026-10-19T04:59:59Z',$false),@('2026-10-19T05:00:00Z',$true),@('2026-10-19T05:01:58Z',$true),@('2026-10-19T05:24:59Z',$true),@('2026-10-19T05:25:00Z',$false),@('2026-10-19T05:25:01Z',$false))) {
 $r=Get-PicDisplayGate $starts $expires ([DateTimeOffset]::Parse($case[0]));if($r.allowed -ne $case[1]){throw 'GATE_ASSERT'};$rows+=@{case=$case[0];allowed=$r.allowed;ok=$true}
}
# 相同绝对时间以+08:00表示仍一致；JSON显式保留原字符串。
$raw=('{"starts":"'+$starts+'","expires":"'+$expires+'"}')|ConvertFrom-Json -DateKind String
if($raw.expires -isnot [string]){throw 'JSON_STRING_REQUIRED'}
if(-not (Get-PicDisplayGate '2026-10-19T13:00:00+08:00' '2026-10-19T13:30:00+08:00' ([DateTimeOffset]::Parse('2026-10-19T05:01:58Z'))).allowed){throw 'OFFSET_ASSERT'}
$invalid=@('2026-10-19T05:30:00','bad','2026-99-99T05:30:00Z');foreach($x in $invalid){$rejected=$false;try{Get-PicDisplayGate $starts $x ([DateTimeOffset]::UtcNow)|Out-Null}catch{$rejected=$true};if(-not $rejected){throw 'INVALID_ACCEPTED'}}
$synthetic='0123456789abcdef0123456789abcdef'
$secure=ConvertTo-SecureString $synthetic -AsPlainText -Force
$cipher=ConvertFrom-SecureString $secure
$sha=[Security.Cryptography.SHA256]::Create();try{$digest=[Convert]::ToHexString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($synthetic))).ToLowerInvariant()}finally{$sha.Dispose()}
$scenarios=@();foreach($kind in @('normal','beforeOpen','atDeadline','afterReadExpired','beforeLaunchExpired','digestMismatch','writeFailure','launchFailure','clockThrows')){
 $script:reads=0;$script:writes=0;$script:launches=0;$script:removes=0;$script:clocks=0
 $file=Join-Path $testDir ($kind+'.txt');$ctx=@{starts=$starts;expires=$expires;digest=$digest}
 if($kind -eq 'digestMismatch'){$ctx.digest='0'*64}
 $clock={ $script:clocks++;if($kind -eq 'clockThrows'){throw 'synthetic clock'};if($kind -eq 'beforeOpen'){return [DateTimeOffset]::Parse('2026-10-19T04:59:59Z')};if($kind -eq 'atDeadline' -or ($kind -eq 'afterReadExpired' -and $script:clocks -ge 2) -or ($kind -eq 'beforeLaunchExpired' -and $script:clocks -ge 3)){return [DateTimeOffset]::Parse('2026-10-19T05:25:00Z')};return [DateTimeOffset]::Parse('2026-10-19T05:01:58Z')}
 $read={ $script:reads++;$ss=ConvertTo-SecureString $cipher;$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss);try{return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}}
 $write={param($value) $script:writes++;$stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew);try{$b=[Text.Encoding]::UTF8.GetBytes($value);$stream.Write($b,0,$b.Length)}finally{$stream.Dispose()};if($kind -eq 'writeFailure'){throw 'synthetic disk failure'}}
 $launch={$script:launches++;if($kind -eq 'launchFailure'){throw 'synthetic launch'};return 12345}
 $remove={$script:removes++;if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file}}
 $ok=$false;try{$result=Invoke-PicDisplayOnce $ctx $clock $read $write $launch $remove;$ok=$result.ok}catch{if($_.Exception.Message -ne 'PIC_DISPLAY_FAILED'){throw}}
 if($kind -eq 'normal'){if(-not $ok -or $script:reads -ne 1 -or $script:writes -ne 1 -or $script:launches -ne 1){throw 'NORMAL_ASSERT'};if([IO.File]::ReadAllText($file) -cne $synthetic){throw 'ROUNDTRIP_ASSERT'};Remove-Item -LiteralPath $file}
 else {if($ok -or (Test-Path -LiteralPath $file)){throw 'FAIL_CLOSED_ASSERT'};if($kind -in @('beforeOpen','atDeadline','clockThrows') -and $script:reads -ne 0){throw 'EARLY_READ_ASSERT'};if($kind -in @('afterReadExpired','digestMismatch') -and $script:writes -ne 0){throw 'EARLY_WRITE_ASSERT'};if($kind -eq 'beforeLaunchExpired' -and $script:launches -ne 0){throw 'EARLY_LAUNCH_ASSERT'}}
 $scenarios+=@{case=$kind;ok=$ok;secretReads=$script:reads;writes=$script:writes;launchAttempts=$script:launches;cleanupCalls=$script:removes;plaintextRemaining=(Test-Path -LiteralPath $file)}
}
$r=[ordered]@{schema='codex-local-display-executor-test/1';observedAt=[DateTime]::UtcNow.ToString('o');runtime=$PSVersionTable.PSVersion.ToString();moduleSha256=(Get-FileHash (Join-Path $PSScriptRoot 'CodexI2口令执行辅助-20261019.psm1') -Algorithm SHA256).Hash.ToLowerInvariant();ok=$true;timeCases=$rows;explicitOffsetEquivalent=$true;invalidTimeCasesRejected=3;syntheticDpapiScenarios=$scenarios;realCredentialRead=$false;actualNotepadStarted=$false;networkInvoked=$false;limitation='synthetic DPAPI and files are real; clocks and process launch are injected; no platform verification'}
$json=($r|ConvertTo-Json -Depth 8)+"`n";if($Out){$b=[Text.Encoding]::UTF8.GetBytes($json);$s=[IO.File]::Open([IO.Path]::GetFullPath($Out),[IO.FileMode]::CreateNew);try{$s.Write($b,0,$b.Length)}finally{$s.Dispose()};'本地执行辅助通过：时间边界6、非法时间3、合成DPAPI链9；真实口令未读。'}else{$json}
