# =================================================================
# AI Document Extraction — 一鍵新環境初始化腳本（Windows PowerShell）
# =================================================================
# 用法：
#   .\scripts\init-new-environment.ps1
#
# 本腳本會執行 10 步：
#   1. 檢查必要軟體（node / npm / docker / git）
#   2. 複製 .env.example → .env（若不存在）
#   3. 啟動 docker-compose 服務
#   4. 等待 PostgreSQL healthy
#   5. 安裝 npm 依賴
#   6. 生成 Prisma Client
#   7. 清除 .next 快取
#   8. 同步 Schema（prisma db push）
#   9. 執行 Seed
#  10. 執行環境自檢
#
# 安全性：
#   - 不覆寫既有 .env
#   - 偵測到非空資料庫時會詢問是否繼續執行 db push
#
# @since CHANGE-054 (2026-04-22)
# =================================================================

$ErrorActionPreference = 'Stop'

# ---- 輸出函數 ----
function Write-Step($Num, $Desc) { Write-Host "`n==▶ Step $Num`: $Desc" -ForegroundColor Blue }
function Write-OK($Msg)   { Write-Host "  ✅ $Msg" -ForegroundColor Green }
function Write-Warn($Msg) { Write-Host "  ⚠️  $Msg" -ForegroundColor Yellow }
function Write-Fail($Msg) { Write-Host "  ❌ $Msg" -ForegroundColor Red; exit 1 }
function Ask($Prompt) {
    $response = Read-Host "$Prompt [y/N]"
    return $response -match '^[Yy]$'
}

# ---- 確認專案根目錄 ----
if (-not (Test-Path 'package.json') -or -not (Test-Path 'prisma\schema.prisma')) {
    Write-Fail "請在專案根目錄執行（找不到 package.json 或 prisma/schema.prisma）"
}

Write-Host "================================================================"
Write-Host "🚀 AI Document Extraction — 新環境一鍵初始化"
Write-Host "================================================================"

# =================================================================
# Step 1: 檢查必要軟體
# =================================================================
Write-Step 1 "檢查必要軟體"

function Check-Cmd($Name) {
    try {
        $version = (& $Name --version 2>&1 | Select-Object -First 1)
        Write-OK "$Name`: $version"
    } catch {
        Write-Fail "缺少必要軟體：$Name（請先安裝）"
    }
}
Check-Cmd node
Check-Cmd npm
Check-Cmd docker
Check-Cmd git

$nodeVersion = (node -v).TrimStart('v').Split('.')[0]
if ([int]$nodeVersion -lt 20) {
    Write-Warn "Node.js 版本 < 20，建議升級"
}

# =================================================================
# Step 2: 複製 .env.example → .env
# =================================================================
Write-Step 2 "準備 .env 檔案"

if (Test-Path '.env') {
    Write-OK ".env 已存在，跳過（若新增變數請手動比對 .env.example）"
} else {
    Copy-Item '.env.example' '.env'
    Write-OK "已從 .env.example 複製為 .env"
    Write-Warn "請編輯 .env 填入實際 Azure/OpenAI 憑證"
}

# =================================================================
# Step 3: 啟動 docker-compose
# =================================================================
Write-Step 3 "啟動 Docker 服務"

try {
    docker info | Out-Null
} catch {
    Write-Fail "Docker 引擎無法連線；請啟動 Docker Desktop"
}

docker-compose up -d
if ($LASTEXITCODE -ne 0) {
    Write-Fail "docker-compose up -d 失敗"
}
Write-OK "docker-compose up -d 執行完成"

# =================================================================
# Step 4: 等待 PostgreSQL healthy
# =================================================================
Write-Step 4 "等待 PostgreSQL healthy（最多 60 秒）"

$maxWait = 30
$waitCount = 0
while ($waitCount -lt $maxWait) {
    try {
        docker exec ai-doc-extraction-db pg_isready -U postgres 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
    } catch {}
    Start-Sleep -Seconds 2
    $waitCount++
    Write-Host "." -NoNewline
}
Write-Host ""

if ($waitCount -ge $maxWait) {
    Write-Fail "PostgreSQL 在 $maxWait 次輪詢後仍未 ready"
}
Write-OK "PostgreSQL ready"

# =================================================================
# Step 5: 安裝 npm 依賴
# =================================================================
Write-Step 5 "安裝 npm 依賴"

npm install
if ($LASTEXITCODE -ne 0) { Write-Fail "npm install 失敗" }
Write-OK "依賴安裝完成"

# =================================================================
# Step 6: 生成 Prisma Client
# =================================================================
Write-Step 6 "生成 Prisma Client"

npx prisma generate
if ($LASTEXITCODE -ne 0) { Write-Fail "prisma generate 失敗" }
Write-OK "Prisma Client 已生成"

# =================================================================
# Step 7: 清除 .next 快取
# =================================================================
Write-Step 7 "清除 .next 快取"

if (Test-Path '.next') {
    Remove-Item -Recurse -Force '.next'
    Write-OK ".next 已清除"
} else {
    Write-OK ".next 不存在，跳過"
}

# =================================================================
# Step 8: 同步 Schema
# =================================================================
Write-Step 8 "同步 Prisma Schema 到資料庫"

$skipDbPush = $false
try {
    $checkOutput = docker exec ai-doc-extraction-db psql -U postgres -d ai_document_extraction -tAc "SELECT 1 FROM information_schema.tables WHERE table_name = 'users';" 2>&1
    if ($checkOutput -match '1') {
        $userCount = docker exec ai-doc-extraction-db psql -U postgres -d ai_document_extraction -tAc "SELECT COUNT(*) FROM users;" 2>&1
        $userCount = [int]($userCount.Trim())
        if ($userCount -gt 0) {
            Write-Warn "資料庫已有 $userCount 筆 user 資料"
            if (-not (Ask "是否繼續執行 prisma db push --accept-data-loss？（可能刪除欄位資料）")) {
                Write-Warn "跳過 db push（Schema 未同步；若有 schema 變更請手動執行：npx prisma db push）"
                $skipDbPush = $true
            }
        }
    }
} catch {
    # 表不存在，繼續 push
}

if (-not $skipDbPush) {
    npx prisma db push --accept-data-loss
    if ($LASTEXITCODE -ne 0) { Write-Fail "prisma db push 失敗" }
    Write-OK "Schema 同步完成"
}

# =================================================================
# Step 9: 執行 Seed
# =================================================================
Write-Step 9 "執行 Seed"

npx prisma db seed
if ($LASTEXITCODE -ne 0) { Write-Fail "prisma db seed 失敗" }
Write-OK "Seed 完成"

# =================================================================
# Step 10: 環境自檢
# =================================================================
Write-Step 10 "環境自檢（verify-environment）"

npm run verify-environment
if ($LASTEXITCODE -eq 0) {
    Write-OK "自檢通過"
} else {
    Write-Warn "自檢發現問題，請查看上方訊息"
}

# =================================================================
# 完成訊息
# =================================================================
Write-Host ""
Write-Host "================================================================"
Write-Host "🎉 新環境初始化完成！" -ForegroundColor Green
Write-Host "================================================================"
Write-Host ""
Write-Host "📋 預設帳號："
Write-Host "   管理員：  admin@ai-document-extraction.com / ChangeMe@2026!"
Write-Host "   開發者：  dev@example.com（dev mode 登入，無需密碼）"
Write-Host ""
Write-Host "🚀 下一步："
Write-Host "   .\scripts\start-dev.ps1        # 統一啟動（Docker + PG 就緒檢查 + dev server，port 3200）"
Write-Host "   npm run dev                    # 或僅啟動 dev server（預設 port 3200）"
Write-Host ""
Write-Host "📚 文件："
Write-Host "   docs/06-deployment/01-local-deployment/project-initialization-guide.md"
Write-Host "   docs/06-deployment/01-local-deployment/README.md  ← 本地部署索引"
Write-Host ""
