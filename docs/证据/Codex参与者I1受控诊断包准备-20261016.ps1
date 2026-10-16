$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidencePath = [IO.Path]::ChangeExtension($PSCommandPath, '.json')
if (Test-Path -LiteralPath $evidencePath) { throw 'PREPARATION_ALREADY_EXISTS' }
$taskRound = 'i1diag-20261016-' + [Guid]::NewGuid().ToString('N').Substring(0,12)
$taskDir = Join-Path $taskRoot ('artifacts/schedule-sandbox/i1-control-' + $taskRound)
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
$taskStart = [DateTime]::UtcNow
$taskPlan = [ordered]@{
 schema='participant-identity-plan/1'; keyDiagnostic=$true; synthetic=$false; checkRoundId=$taskRound; participantCode='1'
 appId='wxfb4db1615ac15531'; envId='cloud1-d8gcq5ag39d847723'; functionName='scheduleSandbox'; collection='schtest_v1_users'
 passphraseDigest=$taskDigest; windowStartsAtIso=$taskStart.ToString('o'); windowExpiresAtIso=$taskStart.AddMinutes(30).ToString('o')
 closeSourceDir=(Join-Path $taskRoot 'artifacts/schedule-sandbox/business-test/pic-close-source-8b3a3b71-a82570')
 note='I1 controlled diagnostic; fixed labels only; no raw keys or values; full ID checkbox should stay unchecked; user 0 witnesses user 1; one inspectSelf; no registration or business writes; deployment not approved'
}
$taskPlanPath = Join-Path $taskDir 'plan.json'
[IO.File]::WriteAllText($taskPlanPath, (($taskPlan | ConvertTo-Json -Depth 6) + "`n"), (New-Object Text.UTF8Encoding($false)))
& node ([IO.Path]::ChangeExtension($PSCommandPath, '.cjs')) $taskPlanPath $taskEncryptedPath
if ($LASTEXITCODE -ne 0) { throw 'LOCAL_PACKAGE_PREPARATION_FAILED_NO_REMOTE_EXECUTION' }
