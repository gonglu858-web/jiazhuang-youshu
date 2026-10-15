$ErrorActionPreference = 'Stop'
$taskPrefix = [IO.Path]::ChangeExtension($PSCommandPath, $null).TrimEnd('.')
$taskStarted = $taskPrefix + '.started.json'
$taskOutput = $taskPrefix + '.json'
if ((Test-Path -LiteralPath $taskStarted) -or (Test-Path -LiteralPath $taskOutput)) { throw 'DIAGNOSTIC_ALREADY_STARTED_DO_NOT_REPEAT' }
$taskPrep = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Codex参与者I1具体包准备-20261015.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskStart = [ordered]@{authorization='同意关闭状态下预览一次';startedAt=[DateTime]::UtcNow.ToString('o');project=$taskPrep.packageDir;tool='create_preview_qrcode';qrFormat='window';page='pages/identity-check/identity-check';allowedAttempts=1;remoteDeploymentAllowed=$false;identityCallAllowed=$false}
$taskStream=[IO.File]::Open($taskStarted,[IO.FileMode]::CreateNew)
$taskBytes=[Text.Encoding]::UTF8.GetBytes(($taskStart|ConvertTo-Json -Depth 5))
$taskStream.Write($taskBytes,0,$taskBytes.Length);$taskStream.Dispose()
$taskRaw = & 'D:/微信web开发者工具/wechatide.cmd' -c Codex create_preview_qrcode --project $taskPrep.packageDir --qr-format window --page-path pages/identity-check/identity-check 2>&1
$taskExit=$LASTEXITCODE
$taskText=($taskRaw|Out-String)
$taskFields=@([regex]::Matches($taskText, '"(success|status|taskId|code|reason|message|size|qrCodePath|qrcodePath)"\s*:\s*(true|false|null|[0-9]+|"(?:\\.|[^"\\]){0,350}")') | ForEach-Object { $_.Value })
$taskRecord=[ordered]@{basisCommit='747bc79';roundId=$taskPrep.plan.checkRoundId;finishedAt=[DateTime]::UtcNow.ToString('o');tool='create_preview_qrcode';attempts=1;outerProcessExitCode=$taskExit;safeObservedFields=$taskFields;rawOutputSaved=$false;deploymentAttempts=0;credentialFetches=0;identityCallsByAgent=0;passphraseDelivered=$false;remoteClosedBasis='Codex参与者I1部署关闭字节核对-20261015.closed.json';remoteRecheckedThisTurn=$false}
$taskStream=[IO.File]::Open($taskOutput,[IO.FileMode]::CreateNew)
$taskBytes=[Text.Encoding]::UTF8.GetBytes(($taskRecord|ConvertTo-Json -Depth 6)+"`n")
$taskStream.Write($taskBytes,0,$taskBytes.Length);$taskStream.Dispose()
$taskFields
Write-Output ('PROCESS_EXIT='+$taskExit)
