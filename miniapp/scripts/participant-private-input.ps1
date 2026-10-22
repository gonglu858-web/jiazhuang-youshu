# 指定本人私密编号输入器（本机原生窗口；每包一人）。
# 任务：docs/CodeBuddy任务-指定本人登记与私密编号输入本地实现-20261021.md §3。
# - 完整编号双次输入须严格一致且格式正确（u_+40 位小写十六进制）；默认遮挡；取消不保存。
# - 不读取剪贴板/聊天/原图；不向日志、终端、异常输出完整编号；明文只经 stdin 交给登记存储管线。
# - 错误提示固定文案，不回显输入值。
# - SelfTestCheck 模式仅用合成值验证校验逻辑（不打开窗口、不写盘）。

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
  [string]$SelfTestValue2 = ''
)

$ErrorActionPreference = 'Stop'
$AccountPattern = '^u_[0-9a-f]{40}$'

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
if ($SelfTestTransport) {
  # 仅合成参数回显；不开窗口、不触DPAPI、不运行存储器、不写盘。
  $fixture = @(Get-StoreArguments 'C:\synthetic package with spaces\participant-private-store.cjs')
  $echoArgs = @('-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))') + $fixture
  $probe = New-Object System.Diagnostics.ProcessStartInfo
  $probe.FileName = $SelfTestNodePath
  $probe.Arguments = (($echoArgs | ForEach-Object { Quote-Arg $_ }) -join ' ')
  $probe.UseShellExecute = $false
  $probe.CreateNoWindow = $true
  $probe.RedirectStandardOutput = $true
  $child = [System.Diagnostics.Process]::Start($probe)
  $text = $child.StandardOutput.ReadToEnd()
  if (-not $child.WaitForExit(5000)) { $child.Kill(); exit 12 }
  Write-Output $text
  exit $child.ExitCode
}

# SelfTestCheck：仅校验逻辑（合成值；不打开窗口、不触 DPAPI、不写盘）
if ($SelfTestCheck) {
  if (-not (Test-AccountFormat $SelfTestValue1)) { Write-Output 'SELFTEST:FORMAT_FAIL'; exit 2 }
  if ($SelfTestValue1 -cne $SelfTestValue2) { Write-Output 'SELFTEST:MISMATCH_FAIL'; exit 3 }
  if ($Tail -and (Get-Tail $SelfTestValue1) -ne $Tail) { Write-Output 'SELFTEST:TAIL_FAIL'; exit 4 }
  Write-Output 'SELFTEST:PASS'; exit 0
}

if (-not $ParticipantCode -or -not $CheckRoundId -or -not $SourceDigest -or -not $RepoRoot -or -not $ServerTimeIso) {
  Write-Error '缺少参与者/轮次/仓库根参数。'
  exit 10
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
$value = $box1.Text
$box1.Clear(); $box2.Clear()
$storeScript = Join-Path $PSScriptRoot 'lib\participant-private-store.cjs'
# R4：Windows 引号规则逐参数转义——含空格路径（RepoRoot/文件名）不再破坏参数边界
$cliArgs = @(Get-StoreArguments $storeScript)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'node'
$psi.Arguments = (($cliArgs | ForEach-Object { Quote-Arg $_ }) -join ' ')
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$proc = [System.Diagnostics.Process]::Start($psi)
$proc.StandardInput.Write($value)
$proc.StandardInput.Write("`n")
$proc.StandardInput.Close()
$stdout = $proc.StandardOutput.ReadToEnd()
$proc.WaitForExit()
if ($proc.ExitCode -ne 0) {
  # 失败输出固定文案；不回显输入、不透出内部错误细节
  Write-Output 'SAVE_FAILED'
  exit 6
}
Write-Output $stdout
