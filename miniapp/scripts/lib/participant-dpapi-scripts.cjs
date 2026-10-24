'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// 受审固定 PowerShell 脚本（DPAPI PROTECT/UNPROTECT 唯一来源）。
// B1 返修（依据 docs/Codex复查-编码兼容B1B3返修b102644-20261024.md §2）：固定用途
// 能力层 participant-native-exec 按**逐字节相等**校验调用方传入的脚本；本模块同时是
// participant-local-tools 的执行脚本来源——单一来源，不复制两份独立脚本，不形成循环依赖
// （本模块不 require 任何包内模块）。脚本字节与返修前 local-tools 内定义完全一致。
//
// C2 语义（保持不改）：固定 Windows PowerShell 程序的 $PSHOME 内置系统模块显式初始化
// （失败即停止）。PROTECT/UNPROTECT 实际所需 cmdlet：ConvertTo/ConvertFrom-SecureString
// （Security 模块）、ConvertFrom-Json（Utility 模块）。按 -Name 固定 $PSHOME 路径加载，
// 不遍历模块、不按 PATH/可覆盖模块名选择、不改 PSModulePath、失败无回退（ErrorAction=Stop）。
// ═══════════════════════════════════════════════════════════════════════════════
const PSHOME_MODULE_INIT = '$ErrorActionPreference = "Stop"; ' +
  'Import-Module -Name (Join-Path $PSHOME "Modules\\Microsoft.PowerShell.Security") -ErrorAction Stop; ' +
  'Import-Module -Name (Join-Path $PSHOME "Modules\\Microsoft.PowerShell.Utility") -ErrorAction Stop; ';
const PROTECT = PSHOME_MODULE_INIT + '$line = [Console]::In.ReadLine(); $sec = ConvertTo-SecureString -String $line -AsPlainText -Force; ConvertFrom-SecureString -SecureString $sec';
const UNPROTECT = PSHOME_MODULE_INIT + '$ErrorActionPreference="Stop"; $cipher = [Console]::In.ReadLine(); $pipeName = [Console]::In.ReadLine(); $sec = ConvertTo-SecureString -String $cipher; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec); $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b); $null = $plain | ConvertFrom-Json; $pipe = New-Object System.IO.Pipes.NamedPipeServerStream($pipeName, [System.IO.Pipes.PipeDirection]::Out); $pipe.WaitForConnection(); $w = New-Object System.IO.StreamWriter($pipe); $w.Write($plain); $w.Flush(); $pipe.Dispose();';
module.exports = Object.freeze({ PSHOME_MODULE_INIT, PROTECT, UNPROTECT });
