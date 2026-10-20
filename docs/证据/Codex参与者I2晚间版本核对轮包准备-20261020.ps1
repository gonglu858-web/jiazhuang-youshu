$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidencePath = [IO.Path]::ChangeExtension($PSCommandPath, '.json')
if (Test-Path -LiteralPath $evidencePath) { throw 'PREPARATION_ALREADY_EXISTS' }
$taskRound = 'i2preview-20261020-f491378eb469'
$taskStart = [DateTimeOffset]::ParseExact('2026-10-20T18:00:00+08:00', "yyyy-MM-dd'T'HH:mm:sszzz", [Globalization.CultureInfo]::InvariantCulture)
if ([DateTimeOffset]::UtcNow -ge $taskStart.AddMinutes(-30)) { throw 'INSUFFICIENT_PREPARATION_TIME' }
$taskDir = Join-Path $taskRoot ('artifacts/schedule-sandbox/i2-control-' + $taskRound)
$taskExclude = Join-Path $taskRoot '.git/info/exclude'
$taskIgnore = '/artifacts/schedule-sandbox/i2-control-' + $taskRound + '/'
[IO.File]::AppendAllText($taskExclude, [Environment]::NewLine + $taskIgnore + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
& git -C $taskRoot check-ignore --quiet -- ($taskDir + '/passphrase.dpapi')
if ($LASTEXITCODE -ne 0) { throw 'CONTROL_DIRECTORY_NOT_IGNORED' }
[IO.Directory]::CreateDirectory($taskDir) | Out-Null
$taskBytes = New-Object byte[] 16
$taskRng = [Security.Cryptography.RandomNumberGenerator]::Create()
$taskRng.GetBytes($taskBytes)
$taskRng.Dispose()
$taskPass = [BitConverter]::ToString($taskBytes).Replace('-','').ToLowerInvariant()
$taskSecure = ConvertTo-SecureString -String $taskPass -AsPlainText -Force
$taskCipher = ConvertFrom-SecureString -SecureString $taskSecure
$taskEncryptedPath = Join-Path $taskDir 'passphrase.dpapi'
[IO.File]::WriteAllText($taskEncryptedPath, $taskCipher, (New-Object Text.UTF8Encoding($false)))
$taskSha = [Security.Cryptography.SHA256]::Create()
$taskDigest = [BitConverter]::ToString($taskSha.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskPass))).Replace('-','').ToLowerInvariant()
$taskSha.Dispose()
$taskRestored = ConvertTo-SecureString -String $taskCipher
$taskPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskRestored)
try {
 $taskPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPtr)
 if ($taskPlain -cne $taskPass) { throw 'DPAPI_ROUNDTRIP_MISMATCH' }
} finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPtr); $taskPlain = $null }
$taskPass = $null
[Array]::Clear($taskBytes,0,$taskBytes.Length)
$taskPlan = [ordered]@{
 schema='participant-identity-plan/2'; requestProtocol='participant-identity-request/1'; keyDiagnostic=$false; synthetic=$false; checkRoundId=$taskRound; participantCode='2'
 appId='wxfb4db1615ac15531'; envId='cloud1-d8gcq5ag39d847723'; functionName='scheduleSandbox'; collection='schtest_v1_users'
 passphraseDigest=$taskDigest; windowStartsAtIso=$taskStart.ToString('o'); windowExpiresAtIso=$taskStart.AddMinutes(30).ToString('o')
 closeSourceDir=(Join-Path $taskRoot 'artifacts/schedule-sandbox/business-test/pic-close-source-8b3a3b71-a82570')
 note='I2 layered read-only identity check; diagnostic disabled; user 0 witnesses user 2; optional full internal ID requires participant checkbox consent; one inspectSelf; no registration or business writes; deployment not approved'
}
$taskPlanPath = Join-Path $taskDir 'plan.json'
[IO.File]::WriteAllText($taskPlanPath, (($taskPlan | ConvertTo-Json -Depth 6) + "`n"), (New-Object Text.UTF8Encoding($false)))
& node ([IO.Path]::ChangeExtension($PSCommandPath, '.cjs')) $taskPlanPath $taskEncryptedPath
if ($LASTEXITCODE -ne 0) { throw 'LOCAL_PACKAGE_PREPARATION_FAILED_NO_REMOTE_EXECUTION' }
