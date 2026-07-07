# =================================================================
# AI Document Extraction — 統一開發啟動腳本（Windows PowerShell）
# =================================================================
# 用法：
#   .\scripts\start-dev.ps1                 # 預設 port 3200
#   .\scripts\start-dev.ps1 -Port 3300      # 指定端口
#   .\scripts\start-dev.ps1 -Generate       # 強制重新生成 Prisma Client
#   .\scripts\start-dev.ps1 -Clean          # 啟動前清除 .next 快取
#   .\scripts\start-dev.ps1 -SkipDocker     # Docker 已在運行時跳過啟動
#
# 本腳本會執行：
#   1. 檢查 Docker 引擎並啟動 docker-compose 服務（除非 -SkipDocker）
#   2. 等待 PostgreSQL healthy
#   3. 視需要生成 Prisma Client（偵測未生成 或 -Generate 時）
#   4. 可選清除 .next 快取（-Clean）
#   5. 檢查目標端口是否被佔用（僅提示，不自動終止進程）
#   6. 前景啟動 Next.js dev server（Ctrl+C 可停止）
#
# 說明：
#   - 供開發者在終端手動執行；dev server 以前景方式啟動。
#   - 首次/新環境完整初始化（含 npm install / db push / seed）請改用
#     scripts\init-new-environment.ps1。
#
# @since CHANGE-096 (2026-07-07)
# =================================================================

param(
    [int]$Port = 3200,
    [switch]$Generate,
    [switch]$Clean,
    [switch]$SkipDocker
)

$ErrorActionPreference = 'Stop'

# ---- 輸出函數 ----
function Write-Step($Num, $Desc) { Write-Host "`n==▶ Step $Num`: $Desc" -ForegroundColor Blue }
function Write-OK($Msg)   { Write-Host "  ✅ $Msg" -ForegroundColor Green }
function Write-Warn($Msg) { Write-Host "  ⚠️  $Msg" -ForegroundColor Yellow }
function Write-Fail($Msg) { Write-Host "  ❌ $Msg" -ForegroundColor Red; exit 1 }

# ---- 確認專案根目錄 ----
if (-not (Test-Path 'package.json') -or -not (Test-Path 'prisma\schema.prisma')) {
    Write-Fail "請在專案根目錄執行（找不到 package.json 或 prisma/schema.prisma）"
}

Write-Host "================================================================"
Write-Host "🚀 AI Document Extraction — 統一開發啟動（port $Port）"
Write-Host "================================================================"

# =================================================================
# Step 1: 檢查 Docker 並啟動服務
# =================================================================
if ($SkipDocker) {
    Write-Step 1 "跳過 Docker 啟動（-SkipDocker）"
    Write-OK "假設 docker-compose 服務已在運行"
} else {
    Write-Step 1 "啟動 Docker 服務"

    try {
        docker info | Out-Null
    } catch {
        Write-Fail "Docker 引擎無法連線；請啟動 Docker Desktop（若 DOCKER_HOST 指向錯誤可移除該變數）"
    }

    docker-compose up -d
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "docker-compose up -d 失敗"
    }
    Write-OK "docker-compose up -d 執行完成"
}

# =================================================================
# Step 2: 等待 PostgreSQL healthy
# =================================================================
Write-Step 2 "等待 PostgreSQL healthy（最多 60 秒）"

$maxWait = 30
$waitCount = 0
while ($waitCount -lt $maxWait) {
    docker exec ai-doc-extraction-db pg_isready -U postgres 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 2
    $waitCount++
    Write-Host "." -NoNewline
}
Write-Host ""

if ($waitCount -ge $maxWait) {
    Write-Fail "PostgreSQL 在 $maxWait 次輪詢後仍未 ready（請確認容器 ai-doc-extraction-db 狀態）"
}
Write-OK "PostgreSQL ready"

# =================================================================
# Step 3: 視需要生成 Prisma Client
# =================================================================
Write-Step 3 "檢查 Prisma Client"

$clientPath = 'node_modules\.prisma\client'
if ($Generate -or -not (Test-Path $clientPath)) {
    if ($Generate) {
        Write-Warn "指定 -Generate，強制重新生成"
    } else {
        Write-Warn "未偵測到已生成的 Prisma Client（$clientPath），自動生成中"
    }
    npx prisma generate
    if ($LASTEXITCODE -ne 0) { Write-Fail "prisma generate 失敗" }
    Write-OK "Prisma Client 已生成"
} else {
    Write-OK "Prisma Client 已存在（如 schema 有變更請加 -Generate）"
}

# =================================================================
# Step 4: 清除 .next 快取（可選）
# =================================================================
if ($Clean) {
    Write-Step 4 "清除 .next 快取（-Clean）"
    if (Test-Path '.next') {
        Remove-Item -Recurse -Force '.next'
        Write-OK ".next 已清除"
    } else {
        Write-OK ".next 不存在，跳過"
    }
}

# =================================================================
# Step 5: 檢查端口佔用
# =================================================================
Write-Step 5 "檢查端口 $Port"

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $pidOnPort = $listener.OwningProcess
    $procName = (Get-Process -Id $pidOnPort -ErrorAction SilentlyContinue).ProcessName
    Write-Warn "端口 $Port 已被進程佔用（PID $pidOnPort / $procName）"
    Write-Fail "請先停止該進程（taskkill /F /T /PID $pidOnPort），或改用其他端口（-Port <其他>）"
}
Write-OK "端口 $Port 可用"

# =================================================================
# Step 6: 啟動 Next.js dev server（前景）
# =================================================================
Write-Step 6 "啟動 Next.js dev server（port $Port，Ctrl+C 可停止）"
Write-Host ""

npm run dev -- -p $Port
