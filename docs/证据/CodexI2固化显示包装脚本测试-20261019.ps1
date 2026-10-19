param([string]$Out)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$base='Codex参与者I2固化显示续接轮';$round='i2display-20261019-49e9564b6313'
$fixture=Join-Path $repo ('artifacts/schedule-sandbox/display-wrapper-test-'+[Guid]::NewGuid().ToString('N'))
$evidence=Join-Path $fixture 'docs/证据';$control=Join-Path $fixture 'artifacts/schedule-sandbox/synthetic-control';$package=Join-Path $fixture 'package'
foreach($d in @($evidence,$control,$package)){[IO.Directory]::CreateDirectory($d)|Out-Null}
function PutJson($p,$v){[IO.File]::WriteAllText($p,(($v|ConvertTo-Json -Depth 12)+"`n"),[Text.UTF8Encoding]::new($false))}
function Hash($p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}
$wrapper=Join-Path $evidence ($base+'口令执行-20261019.ps1');[IO.File]::Copy((Join-Path $PSScriptRoot ($base+'口令执行-20261019.ps1')),$wrapper)
$module=Join-Path $evidence 'CodexI2口令执行辅助-20261019.psm1';[IO.File]::Copy((Join-Path $PSScriptRoot 'CodexI2口令执行辅助-20261019.psm1'),$module)
$planPath=Join-Path $control 'plan.json';$manifest=Join-Path $package 'manifest.json';PutJson $planPath @{synthetic=$true};PutJson $manifest @{synthetic=$true}
$synthetic='0123456789abcdef0123456789abcdef';$cipher=Join-Path $control 'passphrase.dpapi';[IO.File]::WriteAllText($cipher,(ConvertFrom-SecureString (ConvertTo-SecureString $synthetic -AsPlainText -Force)))
$hash=[Security.Cryptography.SHA256]::Create();try{$digest=[Convert]::ToHexString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($synthetic))).ToLowerInvariant()}finally{$hash.Dispose()}
$now=[DateTimeOffset]::UtcNow
$files=@();foreach($n in @('index.js','package.json','request-adapter.js','participant-identity-check.js')){$files+=@{rel=('server/scheduleSandbox/'+$n);sha256=('a'*64);bytes=1}}
$prep=@{plan=@{checkRoundId=$round;windowStartsAtIso=$now.AddMinutes(-1).ToString('o');windowExpiresAtIso=$now.AddMinutes(20).ToString('o');passphraseDigest=$digest};planPath=$planPath;planSha256=(Hash $planPath);packageDir=$package;manifestSha256=(Hash $manifest);files=$files;passphrase=@{encryptedPath=$cipher}}
PutJson (Join-Path $evidence ($base+'包准备-20261019.json')) $prep
PutJson (Join-Path $evidence ($base+'执行脚本冻结-20261019.json')) @{roundId=$round;planSha256=$prep.planSha256;manifestSha256=$prep.manifestSha256;scripts=@(@{name=[IO.Path]::GetFileName($wrapper);sha256=(Hash $wrapper)},@{name=[IO.Path]::GetFileName($module);sha256=(Hash $module)})}
$global:picSyntheticLaunchCount=0
function Start-Process {param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru) $global:picSyntheticLaunchCount++;if($FilePath -ne 'notepad.exe'){throw 'UNEXPECTED_PROCESS'};return [pscustomobject]@{Id=12345}}
$rejected=$false;try{& $wrapper -Mode Show | Out-Null}catch{$rejected=$true}
if(-not $rejected -or $global:picSyntheticLaunchCount -ne 0){throw 'MISSING_APPROVAL_ACCEPTED'}
PutJson (Join-Path $evidence ($base+'批准-20261019.json')) @{roundId=$round;approved=$true;planSha256=$prep.planSha256;manifestSha256=$prep.manifestSha256}
PutJson (Join-Path $evidence ($base+'手动预览-20261019.json')) @{roundId=$round;manualPreviewReportedSuccess=$true}
PutJson (Join-Path $evidence ($base+'部署关闭-20261019.candidate.json')) @{roundId=$round;archive=@{platformCodeSha256=('b'*64)}}
$remoteFiles=@($files|ForEach-Object {@{path=$_.rel.Substring('server/scheduleSandbox/'.Length);sha256=$_.sha256;bytes=$_.bytes}})
PutJson (Join-Path $evidence ($base+'字节核对-20261019.candidate.json')) @{roundId=$round;matched=4;archiveSha256=('b'*64);wxServerSdk='3.0.1';databaseVersion='1.4.1';files=$remoteFiles}
$output=& $wrapper -Mode Show
if(($output|Out-String).Contains($synthetic)){throw 'SECRET_OUTPUT_LEAK'}
$shown=Get-Content -Raw -LiteralPath (Join-Path $evidence ($base+'口令显示-20261019.json'))|ConvertFrom-Json -DateKind String
if($global:picSyntheticLaunchCount -ne 1 -or -not ([IO.File]::ReadAllText($shown.displayPath)).Contains($synthetic)){throw 'SHOW_CHAIN_FAILED'}
$duplicateRejected=$false;try{& $wrapper -Mode Show | Out-Null}catch{$duplicateRejected=$true}
if(-not $duplicateRejected -or $global:picSyntheticLaunchCount -ne 1){throw 'DUPLICATE_SHOW_ACCEPTED'}
PutJson (Join-Path $evidence ($base+'字节核对-20261019.closed.json')) @{roundId=$round;matched=8;status='REMOTE_FILES_MATCH_FROZEN_I2_PACKAGE'}
& $wrapper -Mode Cleanup | Out-Null
if(Test-Path -LiteralPath $shown.displayPath){throw 'CLEANUP_FAILED'}
$r=@{schema='codex-i2-display-wrapper-local-proof/1';observedAt=[DateTimeOffset]::UtcNow.ToString('o');ok=$true;wrapperCopiedWithoutByteChanges=((Hash $wrapper) -eq (Hash (Join-Path $PSScriptRoot ($base+'口令执行-20261019.ps1'))));missingApprovalRejected=$true;syntheticDpapiShowPassed=$true;duplicateShowRejected=$true;cleanupAfterSyntheticClosePassed=$true;launchStubCount=$global:picSyntheticLaunchCount;realNotepadStarted=$false;realPassphraseRead=$false;cloudOperations=0;secretOutputLeak=$false;limitations='actual wrapper copied unchanged into isolated synthetic records; only Start-Process replaced with local stub; real platform records not manufactured'}
if($Out){$b=[Text.Encoding]::UTF8.GetBytes(($r|ConvertTo-Json -Depth 6)+"`n");$s=[IO.File]::Open([IO.Path]::GetFullPath($Out),[IO.FileMode]::CreateNew);try{$s.Write($b,0,$b.Length)}finally{$s.Dispose()};'实际包装脚本合成链通过：缺批准拒绝、显示一次、重复拒绝、关闭后清理；未启动记事本。'}else{$r|ConvertTo-Json -Depth 6}
