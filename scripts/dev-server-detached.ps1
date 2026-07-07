# =================================================================
# AI Document Extraction — dev server detached wrapper（背景存活用）
# =================================================================
# 用途：
#   供 Windows 排程任務執行，讓 Next.js dev server「脫離 AI 工具 job」跨回合存活。
#   一般開發者手動啟動請直接用 scripts\start-dev.ps1（前景、Ctrl+C 可停）。
#
# 前置：
#   環境準備（Docker / PostgreSQL / Prisma）應先由 `start-dev.ps1 -Prepare` 完成；
#   本 wrapper 只負責前景啟動 dev server 並把輸出導向固定 log。
#
# log 路徑（固定、非 repo、跨 session 穩定）：
#   %LOCALAPPDATA%\ai-doc-devserver\dev-server.log
#
# @since CHANGE-097 (2026-07-07)
# =================================================================

param([int]$Port = 3200)

$ErrorActionPreference = 'Stop'

# 由自身位置推導專案根（避免硬編碼路徑）
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $projectRoot

# 固定 log 目錄
$logDir = Join-Path $env:LOCALAPPDATA 'ai-doc-devserver'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$log = Join-Path $logDir 'dev-server.log'

# 解析 npm（排程任務環境 PATH 可能受限，fallback 到預設安裝路徑）
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = 'C:\Program Files\nodejs\npm.cmd' }

# 前景啟動 dev server（對排程任務是前景，對 AI 工具 job 則已脫離），輸出覆蓋寫入 log
& $npm run dev -- -p $Port *> $log
