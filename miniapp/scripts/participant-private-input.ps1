# 指定本人私密编号输入器（本机原生窗口；每包一人）。
# 任务：docs/CodeBuddy任务-指定本人登记与私密编号输入本地实现-20261021.md §3。
# - 完整编号双次输入须严格一致且格式正确（u_+40 位小写十六进制）；默认遮挡；取消不保存。
# - 不读取剪贴板/聊天/原图；不向日志、终端、异常输出完整编号；明文只经 stdin 交给登记存储管线。
# - 错误提示固定文案，不回显输入值。
# - SelfTestCheck 模式仅用合成值验证校验逻辑（不打开窗口、不写盘）。

param(
  [string]$ParticipantCode = '',
  [string]$RoundId = '',
  [string]$Tail = '',
  [string]$SourceDigest = '',
  [string]$RepoRoot = '',
  [string]$FileName = '',
  [switch]$SelfTestCheck,
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

# SelfTestCheck：仅校验逻辑（合成值；不打开窗口、不触 DPAPI、不写盘）
if ($SelfTestCheck) {
  if (-not (Test-AccountFormat $SelfTestValue1)) { Write-Output 'SELFTEST:FORMAT_FAIL'; exit 2 }
  if ($SelfTestValue1 -cne $SelfTestValue2) { Write-Output 'SELFTEST:MISMATCH_FAIL'; exit 3 }
  if ($Tail -and (Get-Tail $SelfTestValue1) -ne $Tail) { Write-Output 'SELFTEST:TAIL_FAIL'; exit 4 }
  Write-Output 'SELFTEST:PASS'; exit 0
}

if (-not $ParticipantCode -or -not $RoundId -or -not $RepoRoot) {
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
$labelInfo.Text = '请输入参与者 ' + $ParticipantCode + ' 的完整编号（两次一致）。来源轮次：' + $RoundId + '；尾号辅助核对：' + $Tail
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

$buttonOk = New-Object System.Windows.Forms.Button
$buttonOk.Text = '确认并加密保存'
$buttonOk.Location = New-Object System.Drawing.Point(12, 210)
$buttonOk.Size = New-Object System.Drawing.Size(180, 32)
$form.Controls.Add($buttonOk)

$buttonCancel = New-Object System.Windows.Forms.Button
$buttonCancel.Text = '取消（不保存）'
$buttonCancel.Location = New-Object System.Drawing.Point(200, 210)
$buttonCancel.Size = New-Object System.Drawing.Size(140, 32)
$form.Controls.Add($buttonCancel)

$labelStatus = New-Object System.Windows.Forms.Label
$labelStatus.Location = New-Object System.Drawing.Point(12, 250)
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
$cliArgs = @($storeScript, 'protect',
  '--repo-root', $RepoRoot,
  '--participant-code', $ParticipantCode,
  '--round-id', $RoundId,
  '--source-digest', $SourceDigest,
  '--file-name', $FileName)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'node'
$psi.Arguments = ($cliArgs -join ' ')
$psi.UseShellExecute = $false
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
