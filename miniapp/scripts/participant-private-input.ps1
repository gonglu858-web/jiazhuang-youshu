# 指定本人私密编号输入器（本机原生窗口；每包一人）。
# 任务：docs/CodeBuddy任务-指定本人登记与私密编号输入本地实现-20261021.md §3。
# - 完整编号双次输入须严格一致且格式正确（u_+40 位小写十六进制）；默认遮挡；取消不保存。
# - 不读取剪贴板/聊天/原图；不向日志、终端、异常输出完整编号；明文只经 stdin 交给登记存储管线。
# - 错误提示固定文案，不回显输入值。
# - SelfTestCheck 模式仅用合成值验证校验逻辑（不打开窗口、不写盘）。
#
# 20261026 固定Node返修（docs/Codex方案-私密输入入口固定Node返修-20261025.md）：
# - 实际保存与 SelfTestTransport 共用同一套内部固定 Node 定义、校验和启动逻辑。
# - 固定路径/摘要是受审常量（来源：已审锚点与环境校验细分定位），预期摘要不从当前
#   文件现算；不搜索 PATH、不自动下载、不接受调用方摘要、不回退其他程序。
#   该绑定只用于本机；换机/升级须重新取证、审查并更新源码。
# - SelfTestNodePath 仅作合成传输模式的一致性声明，不能选择程序；真实保存模式
#   显式携带即拒绝。
# - UI 创建前检查一次；用户确认保存后、启动前再次检查。启动前以只读且拒绝写/删除
#   共享的句柄完成复核，保持到 Process.Start 返回，finally 释放；异常即停止，不传 stdin。
# - 失败净化标签（互不混淆，不回显路径/摘要差异/输入内容）：
#   NODE_DECLARATION_INVALID / NODE_FILE_INVALID / NODE_FILE_READ_FAIL /
#   NODE_DIGEST_MISMATCH / NODE_START_FAIL。
# - SelfTestSynthetic 为固定合成自测入口：仅内部固定场景与固定合成值，不接受任意
#   命令/路径/摘要；底层文件/进程边界由固定合成替身替换，真实校验与启动逻辑原样
#   执行；不打开窗口、不触 DPAPI/存储器/私密目录、不启动真实进程。
# - 保留原有参数转义、双次输入、尾号核对、取消、stdin、输出净化及清理契约；
#   完整编号只走 stdin，不进 argv/env。启动失败不回退、不重试。

param(
  [string]$ParticipantCode = '',
  [string]$CheckRoundId = '',
  [string]$Tail = '',
  [string]$SourceDigest = '',
  [string]$RepoRoot = '',
  [string]$FileName = '',
  [string]$CheckWindowStartsAtIso = '',
  [string]$CheckWindowExpiresAtIso = '',
  [string]$ServerTimeIso = '',
  [switch]$SelfTestCheck,
  [switch]$SelfTestTransport,
  [string]$SelfTestNodePath = '',
  [string]$SelfTestValue1 = '',
  [string]$SelfTestValue2 = '',
  [switch]$SelfTestSynthetic,
  [string]$SelfTestScenario = ''
)

$ErrorActionPreference = 'Stop'
$AccountPattern = '^u_[0-9a-f]{40}$'

# ── 固定 Node 绑定（受审常量；唯一来源，不设任何覆盖入口） ──
$FixedNodePath = 'C:\Users\30591\.agent-reach\tools\node-v22.16.0-win-x64\node.exe'
$FixedNodeSha256 = 'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19'

# ── 失败净化标签（固定、互不混淆；不回显路径/摘要差异/输入内容） ──
$LabelNodeDeclInvalid = 'NODE_DECLARATION_INVALID'
$LabelNodeFileInvalid = 'NODE_FILE_INVALID'
$LabelNodeReadFail = 'NODE_FILE_READ_FAIL'
$LabelDigestMismatch = 'NODE_DIGEST_MISMATCH'
$LabelNodeStartFail = 'NODE_START_FAIL'

function Test-AccountFormat([string]$v) {
  return $v -match $AccountPattern
}

function Get-Tail([string]$v) {
  if ($v.Length -ge 6) { return $v.Substring($v.Length - 6) }
  return ''
}

# 同一参数构造函数供真实UI和离线合成传输自测使用。
function Quote-Arg([string]$a) {
  if ($a -eq '') { return '""' }
  if ($a -notmatch '[\s"]') { return $a }
  return '"' + ($a -replace '(\\*)"','$1$1\"' -replace '\\+$', '$&$&') + '"'
}
function Get-StoreArguments([string]$script) {
  $result = @($script, 'protect', '--repo-root', $RepoRoot, '--participant-code', $ParticipantCode,
    '--check-round-id', $CheckRoundId, '--source-digest', $SourceDigest, '--delivery-confirmed', 'true',
    '--check-window-starts-at-iso', $CheckWindowStartsAtIso, '--check-window-expires-at-iso', $CheckWindowExpiresAtIso,
    '--file-name', $FileName)
  if ($ServerTimeIso) { $result += @('--server-time-iso', $ServerTimeIso) }
  return $result
}

# ── SelfTestNodePath 一致性声明（仅合成传输模式；不能选择程序） ──
function Test-SelfTestNodePathModeUse([string]$declared, [bool]$explicit, [bool]$transportMode) {
  # 省略不约束；显式携带只允许在 SelfTestTransport 模式（真实保存/SelfTestCheck/合成场景拒绝）
  if (-not $explicit) { return $true }
  return $transportMode
}
function Resolve-SelfTestNodePath([string]$declared, [bool]$explicit) {
  # 返回 @{ Ok; NodePath; Label }。省略→固定值；显式空值/相对路径/其他程序/
  # 控制字符/参数拼接/规范化后不一致均拒绝；返回的 NodePath 恒为内部固定常量。
  if (-not $explicit) {
    return @{ Ok = $true; NodePath = $FixedNodePath; Label = '' }
  }
  if ($declared -eq '') {
    return @{ Ok = $false; NodePath = ''; Label = $LabelNodeDeclInvalid }
  }
  if ($declared -match '[\x00-\x1f\x7f]') {
    return @{ Ok = $false; NodePath = ''; Label = $LabelNodeDeclInvalid }
  }
  if ($declared -match '[\s"'';|&<>^()]') {
    return @{ Ok = $false; NodePath = ''; Label = $LabelNodeDeclInvalid }
  }
  if (-not [System.IO.Path]::IsPathRooted($declared)) {
    return @{ Ok = $false; NodePath = ''; Label = $LabelNodeDeclInvalid }
  }
  $normalized = $null
  try { $normalized = [System.IO.Path]::GetFullPath($declared) } catch {
    return @{ Ok = $false; NodePath = ''; Label = $LabelNodeDeclInvalid }
  }
  if (-not [string]::Equals($normalized, $FixedNodePath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return @{ Ok = $false; NodePath = ''; Label = $LabelNodeDeclInvalid }
  }
  return @{ Ok = $true; NodePath = $FixedNodePath; Label = '' }
}

# ── 底层文件/摘要/句柄/进程边界（真实实现；仅合成自测入口以固定替身替换） ──
function Probe-FixedNodeFile([string]$path) {
  # 只做文件元信息与必要路径链 reparse 检查；不查改 ACL、不枚举安装目录。
  # 访问异常抛出（调用方分类为读取失败）；缺失/目录/reparse 以事实返回。
  $file = New-Object System.IO.FileInfo($path)
  $exists = $file.Exists
  if (-not $exists) {
    return @{ Exists = $false; IsNormalFile = $false; ChainClean = $true }
  }
  $attrs = $file.Attributes
  if (($attrs -band [System.IO.FileAttributes]::Directory) -ne 0) {
    return @{ Exists = $true; IsNormalFile = $false; ChainClean = $true }
  }
  if (($attrs -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    return @{ Exists = $true; IsNormalFile = $false; ChainClean = $true }
  }
  # 必要路径链：从父目录逐级向上到根，任一级 reparse 即歧义
  $dir = [System.IO.Path]::GetDirectoryName($file.FullName)
  $root = [System.IO.Path]::GetPathRoot($file.FullName)
  while ($dir -and $dir -ne $root) {
    $di = New-Object System.IO.DirectoryInfo($dir)
    if (($di.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      return @{ Exists = $true; IsNormalFile = $true; ChainClean = $false }
    }
    $dir = [System.IO.Path]::GetDirectoryName($dir)
  }
  return @{ Exists = $true; IsNormalFile = $true; ChainClean = $true }
}
function Probe-FixedNodeDigest([string]$path) {
  # 已有 .NET SHA-256 能力；不按名称自动加载 Get-FileHash 模块。
  # 以只读、拒绝写/删除共享方式打开读取；访问异常抛出（调用方分类为读取失败）。
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
      $hash = $sha.ComputeHash($fs)
    } finally {
      $fs.Dispose()
    }
  } finally {
    $sha.Dispose()
  }
  return (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
}
function Open-FixedNodeHold([string]$path) {
  # 只读打开并拒绝写/删除共享的句柄；由调用方在 Process.Start 返回后 finally 释放。
  return [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
}
function Start-FixedNodeProcess([System.Diagnostics.ProcessStartInfo]$psi) {
  return [System.Diagnostics.Process]::Start($psi)
}

# ── 共用校验与受控启动链（实际保存与合成传输唯一入口；仅两个固定用途） ──
$script:BoundaryProbeNodeFile = ${function:Probe-FixedNodeFile}
$script:BoundaryProbeNodeDigest = ${function:Probe-FixedNodeDigest}
$script:BoundaryOpenHold = ${function:Open-FixedNodeHold}
$script:BoundaryStart = ${function:Start-FixedNodeProcess}

function Test-FixedNodeBinding {
  # 返回 @{ Ok; NodePath; Label }。校验失败时 NodePath 为空，绝不回退其他程序。
  try {
    $facts = & $script:BoundaryProbeNodeFile $FixedNodePath
  } catch {
    return @{ Ok = $false; NodePath = ''; Label = $LabelNodeReadFail }
  }
  if (-not $facts.Exists) { return @{ Ok = $false; NodePath = ''; Label = $LabelNodeFileInvalid } }
  if (-not $facts.IsNormalFile) { return @{ Ok = $false; NodePath = ''; Label = $LabelNodeFileInvalid } }
  if (-not $facts.ChainClean) { return @{ Ok = $false; NodePath = ''; Label = $LabelNodeFileInvalid } }
  try {
    $digest = & $script:BoundaryProbeNodeDigest $FixedNodePath
  } catch {
    return @{ Ok = $false; NodePath = ''; Label = $LabelNodeReadFail }
  }
  if (-not $digest) { return @{ Ok = $false; NodePath = ''; Label = $LabelNodeReadFail } }
  if (-not [string]::Equals($digest, $FixedNodeSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
    return @{ Ok = $false; NodePath = ''; Label = $LabelDigestMismatch }
  }
  return @{ Ok = $true; NodePath = $FixedNodePath; Label = '' }
}
function Start-FixedNode([string]$Purpose, [string[]]$NodeArgv) {
  # 受控启动：仅 'save-protect' 与 'selftest-echo' 两个固定用途；FileName 只能来自
  # 校验后的固定路径；UseShellExecute=false、CreateNoWindow=true；仅从子进程环境
  # 移除 NODE_OPTIONS，不修改系统环境。启动前再次校验并持只读句柄至 Start 返回。
  if ($Purpose -ne 'save-protect' -and $Purpose -ne 'selftest-echo') {
    return @{ Started = $false; Proc = $null; Psi = $null; Label = $LabelNodeStartFail }
  }
  $binding = Test-FixedNodeBinding
  if (-not $binding.Ok) {
    return @{ Started = $false; Proc = $null; Psi = $null; Label = $binding.Label }
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $binding.NodePath
  $psi.Arguments = (($NodeArgv | ForEach-Object { Quote-Arg $_ }) -join ' ')
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  if ($Purpose -eq 'save-protect') {
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
  } else {
    $psi.RedirectStandardOutput = $true
  }
  $null = $psi.EnvironmentVariables.Remove('NODE_OPTIONS')
  $handle = $null
  $proc = $null
  try {
    try {
      $handle = & $script:BoundaryOpenHold $binding.NodePath
    } catch {
      return @{ Started = $false; Proc = $null; Psi = $null; Label = $LabelNodeReadFail }
    }
    try {
      $proc = & $script:BoundaryStart $psi
    } catch {
      $proc = $null
    }
    if ($null -eq $proc) {
      return @{ Started = $false; Proc = $null; Psi = $null; Label = $LabelNodeStartFail }
    }
    return @{ Started = $true; Proc = $proc; Psi = $psi; Label = '' }
  } finally {
    if ($null -ne $handle) {
      try { $handle.Dispose() } catch { }
    }
  }
}
function Invoke-SaveProtect([string]$PlainValue) {
  # 实际保存管线：完整编号只走 stdin；不进 argv/env。启动/写入失败不回退、不重试。
  # 返回 @{ Ok; Stdout; ExitCode; Label }；真实分支据此输出固定文案。
  $storeScript = Join-Path $PSScriptRoot 'lib\participant-private-store.cjs'
  $cliArgs = @(Get-StoreArguments $storeScript)
  $launch = Start-FixedNode 'save-protect' $cliArgs
  if (-not $launch.Started) {
    return @{ Ok = $false; Stdout = ''; ExitCode = -1; Label = $launch.Label }
  }
  $proc = $launch.Proc
  try {
    $proc.StandardInput.Write($PlainValue)
    $proc.StandardInput.Write("`n")
    $proc.StandardInput.Close()
    $stdout = $proc.StandardOutput.ReadToEnd()
    $proc.WaitForExit()
  } catch {
    return @{ Ok = $false; Stdout = ''; ExitCode = -1; Label = $LabelNodeStartFail }
  }
  return @{ Ok = $true; Stdout = $stdout; ExitCode = $proc.ExitCode; Label = '' }
}
function Invoke-SelfTestEcho {
  # 合成参数回显：不开窗口、不触DPAPI、不运行存储器、不写盘。
  # 返回 @{ Ok; Text; ExitCode; Label; TimedOut }。
  $fixture = @(Get-StoreArguments 'C:\synthetic package with spaces\participant-private-store.cjs')
  $echoArgs = @('-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))') + $fixture
  $launch = Start-FixedNode 'selftest-echo' $echoArgs
  if (-not $launch.Started) {
    return @{ Ok = $false; Text = ''; ExitCode = -1; Label = $launch.Label; TimedOut = $false }
  }
  $child = $launch.Proc
  $text = $child.StandardOutput.ReadToEnd()
  if (-not $child.WaitForExit(5000)) {
    $child.Kill()
    return @{ Ok = $false; Text = ''; ExitCode = 12; Label = 'TIMEOUT'; TimedOut = $true }
  }
  return @{ Ok = $true; Text = $text; ExitCode = $child.ExitCode; Label = ''; TimedOut = $false }
}
function Get-NodeLabelExitCode([string]$label) {
  switch ($label) {
    $LabelNodeDeclInvalid { return 20 }
    $LabelNodeFileInvalid { return 21 }
    $LabelNodeReadFail { return 22 }
    $LabelDigestMismatch { return 23 }
    default { return 24 }
  }
}

# ── 模式互斥与声明参数适用模式 ──
if (($SelfTestCheck -and $SelfTestTransport) -or ($SelfTestCheck -and $SelfTestSynthetic) -or ($SelfTestTransport -and $SelfTestSynthetic)) {
  Write-Output 'MODE_CONFLICT'
  exit 19
}
$SelfTestNodePathExplicit = $PSBoundParameters.ContainsKey('SelfTestNodePath')
if (-not (Test-SelfTestNodePathModeUse $SelfTestNodePath $SelfTestNodePathExplicit ($SelfTestTransport -and -not $SelfTestSynthetic))) {
  Write-Output $LabelNodeDeclInvalid
  exit 20
}

if ($SelfTestTransport) {
  # 仅合成参数回显；不开窗口、不触DPAPI、不运行存储器、不写盘。
  # SelfTestNodePath 仅作一致性声明：省略用固定值，显式必须与固定值一致。
  $decl = Resolve-SelfTestNodePath $SelfTestNodePath $SelfTestNodePathExplicit
  if (-not $decl.Ok) {
    Write-Output $decl.Label
    exit (Get-NodeLabelExitCode $decl.Label)
  }
  $preBinding = Test-FixedNodeBinding
  if (-not $preBinding.Ok) {
    Write-Output $preBinding.Label
    exit (Get-NodeLabelExitCode $preBinding.Label)
  }
  $r = Invoke-SelfTestEcho
  if ($r.TimedOut) { exit 12 }
  if (-not $r.Ok) {
    Write-Output $r.Label
    exit (Get-NodeLabelExitCode $r.Label)
  }
  Write-Output $r.Text
  exit $r.ExitCode
}

# SelfTestCheck：仅校验逻辑（合成值；不打开窗口、不触 DPAPI、不写盘）
if ($SelfTestCheck) {
  if (-not (Test-AccountFormat $SelfTestValue1)) { Write-Output 'SELFTEST:FORMAT_FAIL'; exit 2 }
  if ($SelfTestValue1 -cne $SelfTestValue2) { Write-Output 'SELFTEST:MISMATCH_FAIL'; exit 3 }
  if ($Tail -and (Get-Tail $SelfTestValue1) -ne $Tail) { Write-Output 'SELFTEST:TAIL_FAIL'; exit 4 }
  Write-Output 'SELFTEST:PASS'; exit 0
}

# SelfTestSynthetic：固定合成自测入口（仅内部固定场景与固定合成值；不接受任意
# 命令/路径/摘要；底层文件/进程边界由固定合成替身替换，真实校验与启动逻辑原样执行；
# 不打开窗口、不触DPAPI/存储器/私密目录、不启动真实进程；该入口不得关闭真实模式校验）
if ($SelfTestSynthetic) {
  if ($SelfTestValue1 -or $SelfTestValue2) { Write-Output 'MODE_CONFLICT'; exit 19 }
  $fixedScenarios = @('N1_SAVE', 'N1_ECHO', 'N2_DECL', 'N3_FILE', 'N4_DRIFT', 'N5_STARTFAIL', 'N6_TRANSPORT')
  if (-not $SelfTestScenario -or $fixedScenarios -notcontains $SelfTestScenario) {
    Write-Output 'SELFTEST_SCENARIO_UNKNOWN'
    exit 25
  }

  # ── 固定合成替身状态与安装器（行为规格固定在本文件内；外部只能选场景名） ──
  $script:Syn = @{
    FileProbe = @(); DigestProbe = @(); Seq = @()
    HoldOpens = 0; HoldCloses = 0; StartCalls = 0; Starts = 0
    Stdin = @(); StdinClosed = $false; LastPsi = $null
    FileSpec = 'valid'; FileSpecAfter = $null; DigestSpec = 'ok'; DigestSpecAfter = $null
  }
  function Reset-SyntheticCounters {
    $script:Syn.FileProbe = @(); $script:Syn.DigestProbe = @(); $script:Syn.Seq = @()
    $script:Syn.HoldOpens = 0; $script:Syn.HoldCloses = 0; $script:Syn.StartCalls = 0; $script:Syn.Starts = 0
    $script:Syn.Stdin = @(); $script:Syn.StdinClosed = $false; $script:Syn.LastPsi = $null
  }
  function Get-SyntheticFileFacts([string]$spec) {
    switch ($spec) {
      'valid' { return @{ Exists = $true; IsNormalFile = $true; ChainClean = $true } }
      'missing' { return @{ Exists = $false; IsNormalFile = $false; ChainClean = $true } }
      'directory' { return @{ Exists = $true; IsNormalFile = $false; ChainClean = $true } }
      'reparseFile' { return @{ Exists = $true; IsNormalFile = $false; ChainClean = $true } }
      'reparseChain' { return @{ Exists = $true; IsNormalFile = $true; ChainClean = $false } }
      default { throw 'SYNTHETIC_FILE_SPEC' }
    }
  }
  function Install-SyntheticBoundaries([hashtable]$spec) {
    $script:Syn.FileSpec = $spec.fileFacts
    $script:Syn.FileSpecAfter = if ($spec.ContainsKey('fileFactsAfter')) { $spec.fileFactsAfter } else { $null }
    $script:Syn.DigestSpec = $spec.digest
    $script:Syn.DigestSpecAfter = if ($spec.ContainsKey('digestAfter')) { $spec.digestAfter } else { $null }
    $script:BoundaryProbeNodeFile = {
      param($p)
      $script:Syn.FileProbe += $p
      $script:Syn.Seq += 'probeFile'
      $cur = $script:Syn.FileSpec
      if ($script:Syn.FileSpecAfter -and $script:Syn.FileProbe.Count -gt 1) { $cur = $script:Syn.FileSpecAfter }
      return Get-SyntheticFileFacts $cur
    }
    $script:BoundaryProbeNodeDigest = {
      param($p)
      $script:Syn.DigestProbe += $p
      $script:Syn.Seq += 'probeDigest'
      $cur = $script:Syn.DigestSpec
      if ($script:Syn.DigestSpecAfter -and $script:Syn.DigestProbe.Count -gt 1) { $cur = $script:Syn.DigestSpecAfter }
      switch ($cur) {
        'ok' { return $FixedNodeSha256 }
        'wrong' { return ('0' * 64) }
        'throw' { throw 'SYNTHETIC_READ_FAIL' }
        default { throw 'SYNTHETIC_DIGEST_SPEC' }
      }
    }
    $script:BoundaryOpenHold = {
      param($p)
      $script:Syn.HoldOpens++
      $script:Syn.Seq += 'holdOpen'
      $hold = New-Object PSObject
      $hold | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
        $script:Syn.HoldCloses++
        $script:Syn.Seq += 'holdClose'
      }
      return $hold
    }
    $script:BoundaryStart = {
      param($psi)
      $script:Syn.StartCalls++
      $script:Syn.Seq += 'start'
      $script:Syn.LastPsi = $psi
      if ($script:Syn.StartBehavior -eq 'throw') { throw 'SYNTHETIC_START_FAIL' }
      if ($script:Syn.StartBehavior -eq 'null') { return $null }
      $script:Syn.Starts++
      $stdinObj = New-Object PSObject
      $stdinObj | Add-Member -MemberType ScriptMethod -Name Write -Value { param($s) $script:Syn.Stdin += $s }
      $stdinObj | Add-Member -MemberType ScriptMethod -Name Close -Value { $script:Syn.StdinClosed = $true }
      $stdoutObj = New-Object PSObject
      $stdoutObj | Add-Member -MemberType ScriptMethod -Name ReadToEnd -Value { return '{"synthetic":true}' }
      $proc = New-Object PSObject
      $proc | Add-Member -MemberType NoteProperty -Name StandardInput -Value $stdinObj
      $proc | Add-Member -MemberType NoteProperty -Name StandardOutput -Value $stdoutObj
      $proc | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($ms) return $true }
      $proc | Add-Member -MemberType NoteProperty -Name ExitCode -Value 0
      $proc | Add-Member -MemberType ScriptMethod -Name Kill -Value { return }
      return $proc
    }
    # start 行为并入同一规格表（避免脚本块闭包捕获问题，全部经 $script:Syn 读取）
    $script:Syn.StartBehavior = if ($spec.ContainsKey('start')) { $spec.start } else { 'ok' }
  }

  $script:SynChecks = New-Object System.Collections.Generic.List[object]
  function Add-Check([string]$name, [bool]$passed) {
    $script:SynChecks.Add(@{ name = $name; passed = $passed }) | Out-Null
  }

  $syntheticCode = 'u_0123456789abcdef0123456789abcdef01234567'

  if ($SelfTestScenario -eq 'N1_SAVE') {
    # 实际保存分支：合法对照到达底层启动边界；FileName/开关/env/stdin 契约
    Install-SyntheticBoundaries @{ fileFacts = 'valid'; digest = 'ok'; start = 'ok' }
    $r = Invoke-SaveProtect $syntheticCode
    Add-Check 'save-started' $r.Ok
    Add-Check 'start-count-1' ($script:Syn.StartCalls -eq 1)
    $psi = $script:Syn.LastPsi
    Add-Check 'filename-is-fixed-path' ($null -ne $psi -and [string]::Equals($psi.FileName, $FixedNodePath, [System.StringComparison]::OrdinalIgnoreCase))
    Add-Check 'use-shellexecute-false' ($psi.UseShellExecute -eq $false)
    Add-Check 'create-no-window-true' ($psi.CreateNoWindow -eq $true)
    Add-Check 'stdin-redirected' ($psi.RedirectStandardInput -eq $true)
    Add-Check 'stderr-redirected' ($psi.RedirectStandardError -eq $true)
    Add-Check 'node-options-removed-from-child' ($null -eq $psi.EnvironmentVariables['NODE_OPTIONS'])
    Add-Check 'argv-has-protect-op' ($psi.Arguments.Contains('protect'))
    Add-Check 'argv-has-store-script' ($psi.Arguments.Contains('participant-private-store.cjs'))
    Add-Check 'argv-no-plain-value' (-not $psi.Arguments.Contains($syntheticCode))
    Add-Check 'stdin-exactly-value-newline' ([string]::Join('', $script:Syn.Stdin) -ceq ($syntheticCode + "`n"))
    Add-Check 'stdin-closed' $script:Syn.StdinClosed
    Add-Check 'recheck-probed-once' ($script:Syn.FileProbe.Count -eq 1 -and $script:Syn.DigestProbe.Count -eq 1)
    Add-Check 'hold-open-1-close-1' ($script:Syn.HoldOpens -eq 1 -and $script:Syn.HoldCloses -eq 1)
    $seq = [string]::Join(',', $script:Syn.Seq)
    Add-Check 'order-open-start-close' ($seq.IndexOf('holdOpen') -lt $seq.IndexOf('start') -and $seq.IndexOf('start') -lt $seq.IndexOf('holdClose'))
    Add-Check 'no-fallback-second-start' ($script:Syn.StartCalls -eq 1)
  }

  if ($SelfTestScenario -eq 'N1_ECHO') {
    # 合成传输分支：与实际保存分支共用同一固定程序选择与启动链
    Install-SyntheticBoundaries @{ fileFacts = 'valid'; digest = 'ok'; start = 'ok' }
    $r = Invoke-SelfTestEcho
    Add-Check 'echo-ok' $r.Ok
    Add-Check 'start-count-1' ($script:Syn.StartCalls -eq 1)
    $psi = $script:Syn.LastPsi
    Add-Check 'filename-is-fixed-path' ($null -ne $psi -and [string]::Equals($psi.FileName, $FixedNodePath, [System.StringComparison]::OrdinalIgnoreCase))
    Add-Check 'same-node-as-save-branch' ([string]::Equals($psi.FileName, $FixedNodePath, [System.StringComparison]::OrdinalIgnoreCase))
    Add-Check 'use-shellexecute-false' ($psi.UseShellExecute -eq $false)
    Add-Check 'create-no-window-true' ($psi.CreateNoWindow -eq $true)
    Add-Check 'no-stdin-redirect' ($psi.RedirectStandardInput -eq $false)
    Add-Check 'node-options-removed-from-child' ($null -eq $psi.EnvironmentVariables['NODE_OPTIONS'])
    Add-Check 'argv-echo-fixed-entry' ($psi.Arguments.Contains('-e'))
    Add-Check 'argv-fixture-shared-constructor' ($psi.Arguments.Contains('participant-private-store.cjs'))
    Add-Check 'stdin-zero' ($script:Syn.Stdin.Count -eq 0)
    Add-Check 'hold-open-1-close-1' ($script:Syn.HoldOpens -eq 1 -and $script:Syn.HoldCloses -eq 1)
    Add-Check 'no-fallback-second-start' ($script:Syn.StartCalls -eq 1)
  }

  if ($SelfTestScenario -eq 'N2_DECL') {
    # 声明参数：省略合法用固定值；显式空值/相对路径/其他程序/拼接/控制字符拒绝；
    # 真实保存/SelfTestCheck 模式显式携带拒绝。启动与 stdin 计数 0。
    Install-SyntheticBoundaries @{ fileFacts = 'valid'; digest = 'ok'; start = 'ok' }
    $r1 = Resolve-SelfTestNodePath '' $false
    Add-Check 'omitted-resolves-fixed' ($r1.Ok -and [string]::Equals($r1.NodePath, $FixedNodePath, [System.StringComparison]::OrdinalIgnoreCase))
    $r2 = Resolve-SelfTestNodePath 'C:\USERS\30591\.AGENT-REACH\tools\node-v22.16.0-win-x64\node.exe' $true
    Add-Check 'same-absolute-ok' ($r2.Ok -and [string]::Equals($r2.NodePath, $FixedNodePath, [System.StringComparison]::OrdinalIgnoreCase))
    $badCases = @(
      @{ n = 'explicit-empty'; v = '' },
      @{ n = 'relative'; v = 'tools\node.exe' },
      @{ n = 'other-exe'; v = 'C:\Windows\System32\cmd.exe' },
      @{ n = 'other-node'; v = 'C:\Program Files\nodejs\node.exe' },
      @{ n = 'splice-suffix'; v = ($FixedNodePath + ' -e synthetic') },
      @{ n = 'splice-space'; v = ($FixedNodePath + ' extra') },
      @{ n = 'nul'; v = ("C:\x" + [char]0 + "y") },
      @{ n = 'newline'; v = ("C:\x" + [char]10 + "y") }
    )
    foreach ($b in $badCases) {
      $rr = Resolve-SelfTestNodePath $b.v $true
      Add-Check ('decl-reject-' + $b.n) ((-not $rr.Ok) -and $rr.Label -eq $LabelNodeDeclInvalid)
    }
    Add-Check 'decl-reject-zero-start' ($script:Syn.StartCalls -eq 0 -and $script:Syn.Stdin.Count -eq 0)
    Add-Check 'mode-misuse-save-rejected' (-not (Test-SelfTestNodePathModeUse 'C:\x\node.exe' $true $false))
    Add-Check 'mode-misuse-check-rejected' (-not (Test-SelfTestNodePathModeUse 'C:\x\node.exe' $true $false))
    Add-Check 'mode-omitted-save-allowed' (Test-SelfTestNodePathModeUse '' $false $false)
    Add-Check 'mode-transport-explicit-allowed' (Test-SelfTestNodePathModeUse 'C:\x\node.exe' $true $true)
  }

  if ($SelfTestScenario -eq 'N3_FILE') {
    # 文件边界分类：每例只改一个方面，其余合法；分别触发对应原因，零启动
    $cases = @(
      @{ n = 'missing'; file = 'missing'; digest = 'ok'; expect = $LabelNodeFileInvalid },
      @{ n = 'directory'; file = 'directory'; digest = 'ok'; expect = $LabelNodeFileInvalid },
      @{ n = 'reparse-file'; file = 'reparseFile'; digest = 'ok'; expect = $LabelNodeFileInvalid },
      @{ n = 'reparse-chain'; file = 'reparseChain'; digest = 'ok'; expect = $LabelNodeFileInvalid },
      @{ n = 'read-fail'; file = 'access'; digest = 'ok'; expect = $LabelNodeReadFail },
      @{ n = 'digest-mismatch'; file = 'valid'; digest = 'wrong'; expect = $LabelDigestMismatch },
      @{ n = 'digest-read-fail'; file = 'valid'; digest = 'throw'; expect = $LabelNodeReadFail }
    )
    foreach ($c in $cases) {
      Reset-SyntheticCounters
      Install-SyntheticBoundaries @{ fileFacts = $c.file; digest = $c.digest; start = 'ok' }
      $b = Test-FixedNodeBinding
      Add-Check ('n3-' + $c.n + '-rejected') (-not $b.Ok)
      Add-Check ('n3-' + $c.n + '-label-exact') ($b.Label -eq $c.expect)
      Add-Check ('n3-' + $c.n + '-zero-start-stdin-hold') ($script:Syn.StartCalls -eq 0 -and $script:Syn.Stdin.Count -eq 0 -and $script:Syn.HoldOpens -eq 0)
    }
  }

  if ($SelfTestScenario -eq 'N4_DRIFT') {
    # UI 前检查合法，启动前复核漂移时拒绝：零启动、零 stdin、句柄未开
    Install-SyntheticBoundaries @{ fileFacts = 'valid'; digest = 'ok'; digestAfter = 'wrong'; start = 'ok' }
    $first = Test-FixedNodeBinding
    Add-Check 'pre-check-ok' $first.Ok
    $r = Invoke-SaveProtect $syntheticCode
    Add-Check 'drift-digest-rejected' ((-not $r.Ok) -and $r.Label -eq $LabelDigestMismatch)
    Add-Check 'drift-zero-start' ($script:Syn.StartCalls -eq 0)
    Add-Check 'drift-zero-stdin' ($script:Syn.Stdin.Count -eq 0)
    Add-Check 'drift-no-hold' ($script:Syn.HoldOpens -eq 0)
    Add-Check 'digest-probed-twice' ($script:Syn.DigestProbe.Count -eq 2)
    Reset-SyntheticCounters
    Install-SyntheticBoundaries @{ fileFacts = 'valid'; digest = 'ok'; digestAfter = 'throw'; start = 'ok' }
    $first2 = Test-FixedNodeBinding
    Add-Check 'pre-check-ok-variant' $first2.Ok
    $r2 = Invoke-SaveProtect $syntheticCode
    Add-Check 'drift-readfail-rejected' ((-not $r2.Ok) -and $r2.Label -eq $LabelNodeReadFail)
    Add-Check 'drift-readfail-zero-start' ($script:Syn.StartCalls -eq 0 -and $script:Syn.Stdin.Count -eq 0)
  }

  if ($SelfTestScenario -eq 'N5_STARTFAIL') {
    # 启动异常：句柄关闭、无 stdin、无回退、固定失败路径（不输出输入内容）
    Install-SyntheticBoundaries @{ fileFacts = 'valid'; digest = 'ok'; start = 'throw' }
    $r = Invoke-SaveProtect $syntheticCode
    Add-Check 'startfail-rejected' ((-not $r.Ok) -and $r.Label -eq $LabelNodeStartFail)
    Add-Check 'startfail-no-stdin' ($script:Syn.Stdin.Count -eq 0 -and (-not $script:Syn.StdinClosed))
    Add-Check 'startfail-no-fallback' ($script:Syn.StartCalls -eq 1)
    Add-Check 'startfail-hold-closed' ($script:Syn.HoldOpens -eq 1 -and $script:Syn.HoldCloses -eq 1)
    $seq = [string]::Join(',', $script:Syn.Seq)
    Add-Check 'startfail-close-after-start-attempt' ($seq.IndexOf('holdOpen') -lt $seq.IndexOf('start') -and $seq.IndexOf('start') -lt $seq.IndexOf('holdClose'))
    Add-Check 'startfail-output-no-secret' (-not $r.Stdout.Contains($syntheticCode))
    Reset-SyntheticCounters
    Install-SyntheticBoundaries @{ fileFacts = 'valid'; digest = 'ok'; start = 'null' }
    $r2 = Invoke-SaveProtect $syntheticCode
    Add-Check 'startnull-rejected' ((-not $r2.Ok) -and $r2.Label -eq $LabelNodeStartFail)
    Add-Check 'startnull-no-stdin' ($script:Syn.Stdin.Count -eq 0)
    Add-Check 'startnull-hold-closed' ($script:Syn.HoldOpens -eq 1 -and $script:Syn.HoldCloses -eq 1)
  }

  if ($SelfTestScenario -eq 'N6_TRANSPORT') {
    # 完整编号只走 stdin，不进 argv/env；固定逻辑覆盖实际保存分支；转义契约保持
    Install-SyntheticBoundaries @{ fileFacts = 'valid'; digest = 'ok'; start = 'ok' }
    $r = Invoke-SaveProtect $syntheticCode
    Add-Check 'save-branch-uses-fixed-node' $r.Ok
    $psi = $script:Syn.LastPsi
    Add-Check 'argv-no-full-code' (-not $psi.Arguments.Contains($syntheticCode))
    Add-Check 'stdin-has-full-code-once' ([string]::Join('', $script:Syn.Stdin) -ceq ($syntheticCode + "`n"))
    $envHit = $false
    foreach ($k in $psi.EnvironmentVariables.Keys) {
      if (($psi.EnvironmentVariables[$k]) -and $psi.EnvironmentVariables[$k].Contains($syntheticCode)) { $envHit = $true }
    }
    Add-Check 'env-no-full-code' (-not $envHit)
    Add-Check 'node-options-removed-from-child' ($null -eq $psi.EnvironmentVariables['NODE_OPTIONS'])
    Add-Check 'fixture-space-path-quoted' ($psi.Arguments.Contains('"C:\synthetic package with spaces\participant-private-store.cjs"'))
    Add-Check 'empty-arg-quoted' ($psi.Arguments.Contains('""'))
  }

  $failedChecks = @($script:SynChecks | Where-Object { -not $_.passed })
  $summary = @{
    scenario = $SelfTestScenario
    passed = ($failedChecks.Count -eq 0)
    checkTotal = $script:SynChecks.Count
    checkFailed = $failedChecks.Count
    counters = @{
      fileProbe = $script:Syn.FileProbe.Count
      digestProbe = $script:Syn.DigestProbe.Count
      holdOpens = $script:Syn.HoldOpens
      holdCloses = $script:Syn.HoldCloses
      startCalls = $script:Syn.StartCalls
      starts = $script:Syn.Starts
      stdinWrites = $script:Syn.Stdin.Count
    }
    checks = $script:SynChecks
  }
  Write-Output ($summary | ConvertTo-Json -Depth 5 -Compress)
  if ($failedChecks.Count -gt 0) { exit 1 }
  exit 0
}

if (-not $ParticipantCode -or -not $CheckRoundId -or -not $SourceDigest -or -not $RepoRoot -or -not $ServerTimeIso) {
  Write-Error '缺少参与者/轮次/仓库根参数。'
  exit 10
}

# UI 创建前检查一次：固定文件不合法/读取失败/摘要不符即停止，不弹出输入窗口
$preBinding = Test-FixedNodeBinding
if (-not $preBinding.Ok) {
  Write-Output $preBinding.Label
  exit (Get-NodeLabelExitCode $preBinding.Label)
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = '参与者私密编号输入（参与者 ' + $ParticipantCode + '）'
$form.Size = New-Object System.Drawing.Size(560, 320)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'

$labelInfo = New-Object System.Windows.Forms.Label
$labelInfo.Text = '请输入参与者 ' + $ParticipantCode + ' 的完整编号（两次一致）。来源轮次：' + $CheckRoundId + '；尾号辅助核对：' + $Tail
$labelInfo.Location = New-Object System.Drawing.Point(12, 12)
$labelInfo.Size = New-Object System.Drawing.Size(520, 40)
$form.Controls.Add($labelInfo)

$label1 = New-Object System.Windows.Forms.Label
$label1.Text = '完整编号（第一次）'
$label1.Location = New-Object System.Drawing.Point(12, 60)
$label1.Size = New-Object System.Drawing.Size(200, 20)
$form.Controls.Add($label1)

$box1 = New-Object System.Windows.Forms.TextBox
$box1.Location = New-Object System.Drawing.Point(12, 82)
$box1.Size = New-Object System.Drawing.Size(520, 24)
$box1.UseSystemPasswordChar = $true
$form.Controls.Add($box1)

$label2 = New-Object System.Windows.Forms.Label
$label2.Text = '完整编号（第二次，须完全一致）'
$label2.Location = New-Object System.Drawing.Point(12, 112)
$label2.Size = New-Object System.Drawing.Size(260, 20)
$form.Controls.Add($label2)

$box2 = New-Object System.Windows.Forms.TextBox
$box2.Location = New-Object System.Drawing.Point(12, 134)
$box2.Size = New-Object System.Drawing.Size(520, 24)
$box2.UseSystemPasswordChar = $true
$form.Controls.Add($box2)

$buttonShow = New-Object System.Windows.Forms.Button
$buttonShow.Text = '按住临时显示（仅本人复核）'
$buttonShow.Location = New-Object System.Drawing.Point(12, 166)
$buttonShow.Size = New-Object System.Drawing.Size(240, 28)
$form.Controls.Add($buttonShow)

$checkDelivery = New-Object System.Windows.Forms.CheckBox
$checkDelivery.Text = '本人完整编号已当面交付（显式交付确认事实）'
$checkDelivery.Location = New-Object System.Drawing.Point(12, 200)
$checkDelivery.Size = New-Object System.Drawing.Size(520, 22)
$form.Controls.Add($checkDelivery)

$buttonOk = New-Object System.Windows.Forms.Button
$buttonOk.Text = '确认并加密保存'
$buttonOk.Location = New-Object System.Drawing.Point(12, 226)
$buttonOk.Size = New-Object System.Drawing.Size(180, 32)
$form.Controls.Add($buttonOk)

$buttonCancel = New-Object System.Windows.Forms.Button
$buttonCancel.Text = '取消（不保存）'
$buttonCancel.Location = New-Object System.Drawing.Point(200, 226)
$buttonCancel.Size = New-Object System.Drawing.Size(140, 32)
$form.Controls.Add($buttonCancel)

$labelStatus = New-Object System.Windows.Forms.Label
$labelStatus.Location = New-Object System.Drawing.Point(12, 264)
$labelStatus.Size = New-Object System.Drawing.Size(520, 24)
$form.Controls.Add($labelStatus)

$buttonShow.Add_MouseDown({ $box1.UseSystemPasswordChar = $false; $box2.UseSystemPasswordChar = $false })
$buttonShow.Add_MouseUp({ $box1.UseSystemPasswordChar = $true; $box2.UseSystemPasswordChar = $true })
$buttonShow.Add_MouseLeave({ $box1.UseSystemPasswordChar = $true; $box2.UseSystemPasswordChar = $true })

$buttonCancel.Add_Click({ $form.Tag = 'CANCEL'; $form.Close() })

$buttonOk.Add_Click({
  $v1 = $box1.Text
  $v2 = $box2.Text
  if (-not (Test-AccountFormat $v1)) {
    $labelStatus.Text = '格式不正确（u_+40 位小写十六进制）。请重新输入；不回显原值。'
    return
  }
  if ($v1 -cne $v2) {
    $labelStatus.Text = '两次输入不一致。请重新输入；不回显原值。'
    return
  }
  if ($Tail -and (Get-Tail $v1) -ne $Tail) {
    $labelStatus.Text = '尾号与已核验记录不符。请核对后重新输入；不回显原值。'
    return
  }
  if (-not $checkDelivery.Checked) {
    $labelStatus.Text = '缺少交付确认：请先勾选交付确认事实。'
    return
  }
  $form.Tag = 'OK'
  $form.Close()
})

$form.Add_Shown({ $box1.Focus() })
$form.ShowDialog() | Out-Null

if ($form.Tag -ne 'OK') {
  Write-Output 'CANCELLED'
  exit 5
}

# 明文只经 stdin 交给登记存储管线（node lib/participant-private-store.cjs protect）
# 共用受控启动链：保存启动前再次校验固定 Node，句柄保持到 Start 返回后 finally 释放
$value = $box1.Text
$box1.Clear(); $box2.Clear()
$r = Invoke-SaveProtect $value
if ((-not $r.Ok) -or $r.ExitCode -ne 0) {
  # 失败输出固定文案；不回显输入、不透出内部错误细节；不回退、不重试
  Write-Output 'SAVE_FAILED'
  exit 6
}
Write-Output $r.Stdout
