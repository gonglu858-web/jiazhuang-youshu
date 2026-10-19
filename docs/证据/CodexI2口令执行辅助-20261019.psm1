# 本地执行辅助：不进入小程序/云函数；调用者负责冻结包、批准与远端回读绑定。
Set-StrictMode -Version Latest
function Get-PicDisplayGate {
 param([string]$StartsIso,[string]$ExpiresIso,[DateTimeOffset]$Now)
 foreach($value in @($StartsIso,$ExpiresIso)) {
  if ($value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$') {throw 'PIC_DISPLAY_TIME_INVALID'}
 }
 try {
  $start=[DateTimeOffset]::Parse($StartsIso,[Globalization.CultureInfo]::InvariantCulture)
  $expires=[DateTimeOffset]::Parse($ExpiresIso,[Globalization.CultureInfo]::InvariantCulture)
 } catch {throw 'PIC_DISPLAY_TIME_INVALID'}
 if ($expires -le $start -or ($expires-$start).TotalMinutes -gt 30) {throw 'PIC_DISPLAY_WINDOW_INVALID'}
 $deadline=$expires.AddMinutes(-5)
 $reason=if($Now -lt $start){'NOT_OPEN'}elseif($Now -ge $deadline){'INSUFFICIENT_TIME'}else{'READY'}
 return [pscustomobject]@{allowed=($reason -eq 'READY');reason=$reason;startsUtc=$start.UtcDateTime.ToString('o');expiresUtc=$expires.UtcDateTime.ToString('o');displayDeadlineUtc=$deadline.UtcDateTime.ToString('o')}
}
function Invoke-PicDisplayOnce {
 param([hashtable]$Context,[scriptblock]$Clock,[scriptblock]$ReadSecret,[scriptblock]$WriteDisplay,[scriptblock]$Launch,[scriptblock]$RemoveDisplay)
 $written=$false;$plain=$null
 try {
  $gate=Get-PicDisplayGate $Context.starts $Context.expires (& $Clock)
  if(-not $gate.allowed){throw 'PIC_DISPLAY_NOT_READY'}
  $plain=& $ReadSecret
  if($plain -isnot [string] -or $plain -notmatch '^[a-f0-9]{32}$'){throw 'PIC_DISPLAY_SECRET_INVALID'}
  $hash=[Security.Cryptography.SHA256]::Create()
  try {$digest=[Convert]::ToHexString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($plain))).ToLowerInvariant()}finally{$hash.Dispose()}
  if($digest -cne $Context.digest){throw 'PIC_DISPLAY_DIGEST_MISMATCH'}
  $gate=Get-PicDisplayGate $Context.starts $Context.expires (& $Clock)
  if(-not $gate.allowed){throw 'PIC_DISPLAY_NOT_READY'}
  # 写前标记可能已产生文件，故写中失败也执行精确路径清理。
  $written=$true
  & $WriteDisplay $plain | Out-Null
  $plain=$null
  $gate=Get-PicDisplayGate $Context.starts $Context.expires (& $Clock)
  if(-not $gate.allowed){throw 'PIC_DISPLAY_NOT_READY'}
  $pidValue=& $Launch
  return [pscustomobject]@{ok=$true;launchRequested=$true;processId=$pidValue;displayDeadlineUtc=$gate.displayDeadlineUtc;secretEmitted=$false}
 } catch {
  if($written){try{& $RemoveDisplay | Out-Null}catch{throw 'PIC_DISPLAY_FAILED_CLEANUP_REQUIRED'}}
  throw 'PIC_DISPLAY_FAILED'
 } finally {$plain=$null}
}
Export-ModuleMember -Function Get-PicDisplayGate,Invoke-PicDisplayOnce
