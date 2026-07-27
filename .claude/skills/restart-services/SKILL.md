---
name: restart-services
description: 清掉本項目所有舊服務（Docker 容器 + dev server）並乾淨重啟 — 保留資料 volume、不影響其他項目
trigger: /restart-services
---

# Restart Services — 清舊重啟本項目服務

一鍵清掉**本項目**的舊服務（Docker 容器 + Next.js dev server）並乾淨重啟。

**本項目服務範圍（只碰這些）**：

| 服務 | 容器名 / 埠 |
|------|-------------|
| PostgreSQL | `ai-doc-extraction-db` / 5433 |
| pgAdmin | `ai-doc-extraction-pgadmin` / 5050 |
| Azurite | `ai-doc-extraction-azurite` / 10010-10012 |
| OCR (Python) | `ai-doc-extraction-ocr` / 8000 |
| Mapping (Python) | `ai-doc-extraction-mapping` / 8001 |
| Next.js dev server | node / **3200**（`npm run dev` 預設） |

---

## 🔴 安全紀律（每次必守）

1. **只碰 `ai-doc-extraction-*`**。同機常有其他項目容器（如 `itpm-*`、`ipa-*`）——**絕不停用/移除**。用 `docker-compose`（在本項目根目錄執行，天然只作用於本 compose 檔的 5 個服務）而非手動 `docker stop` 別人的容器。
2. **`docker-compose down` 絕不加 `-v`**。`-v` 會刪除 `postgres_data` / `pgadmin_data` / `azurite_data` volume＝**清空本地資料庫**。清舊只停容器、**保留資料**。
3. **不要盲殺 node.exe**。同機的 node 程序可能是其他項目 dev server、VS Code server、Claude 等。**只殺佔用本項目 dev 埠（3200）的那個 PID**，且先確認它就是 Next.js dev server。
4. **dev server 必須「背景存活」啟動**。實測 Bash `run_in_background` 與 `Start-Process` 會隨工具 job 被殺；用 **Windows 排程任務**執行 `scripts\dev-server-detached.ps1` 讓它脫離工具 job 跨回合存活。
5. **重用既有腳本**（`scripts\start-dev.ps1`、`scripts\dev-server-detached.ps1`），不要重造啟動邏輯。

---

## 執行流程

### Step 0 — 摸清現況（唯讀）

```powershell
# 本項目容器
docker ps -a --filter "name=ai-doc-extraction" --format "table {{.Names}}\t{{.Status}}"
# 佔用常用 dev 埠的監聽程序
foreach ($p in 3000,3100,3200,3300,3500) {
  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { "port $p -> PID $($_.OwningProcess) $((Get-Process -Id $_.OwningProcess -EA SilentlyContinue).ProcessName)" }
}
```

### Step 1 — 清掉舊 dev server（只殺佔本項目埠者）

```powershell
# 停用背景 dev server 排程任務（若存在）
Get-ScheduledTask -TaskName 'ai-doc-devserver' -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
# 殺掉仍佔用 3200 的 node（先確認是 node 再殺；連同子進程 /T）
$c = Get-NetTCPConnection -LocalPort 3200 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) {
  $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  if ($proc.ProcessName -eq 'node') { taskkill /F /T /PID $c.OwningProcess }
  else { Write-Warning "3200 被非 node 進程佔用（$($proc.ProcessName)），請人工確認，勿盲殺" }
}
```

> 若目標埠不是 3200（例如曾用 3300），對該埠重複本步驟。

### Step 2 — 清掉舊 Docker 容器（保留資料）

```powershell
# 在本項目根目錄執行；只作用於本 compose 的 5 個服務；不加 -v
docker-compose down
docker ps -a --filter "name=ai-doc-extraction" --format "table {{.Names}}\t{{.Status}}"  # 應為空
```

### Step 3 — 重啟基礎服務（Docker + PostgreSQL + Prisma）

```powershell
# -Prepare：只準備環境不啟 dev server；-Generate：強制重生 Prisma Client（跨機/清快取後必須）
& .\scripts\start-dev.ps1 -Prepare -Generate
```

此腳本會：docker-compose up -d → 等 `ai-doc-extraction-db` healthy → `npx prisma generate` → 檢查埠 3200 → 不啟 dev server 直接 exit 0。

> 需清 `.next` 快取時（跨機複製後常見）：改用 `& .\scripts\start-dev.ps1 -Prepare -Generate -Clean`。

### Step 4 — 啟動 dev server（背景存活）

```powershell
$scriptPath = (Resolve-Path '.\scripts\dev-server-detached.ps1').Path
$log = Join-Path $env:LOCALAPPDATA 'ai-doc-devserver\dev-server.log'
if (Test-Path $log) { Remove-Item $log -Force }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Port 3200"
Register-ScheduledTask -TaskName 'ai-doc-devserver' -Action $action -Force -RunLevel Limited | Out-Null
Start-ScheduledTask -TaskName 'ai-doc-devserver'
```

`dev-server-detached.ps1` 前景跑 `npm run dev -- -p 3200`，輸出導向固定 log `%LOCALAPPDATA%\ai-doc-devserver\dev-server.log`（非 repo、跨 session 穩定）。

### Step 5 — 驗證（等首編完成再判斷）

```powershell
# 輪詢埠 3200 監聽（首次編譯約 45-60 秒；熱啟約 5-10 秒）
$deadline = (Get-Date).AddSeconds(120)
do { $c = Get-NetTCPConnection -LocalPort 3200 -State Listen -EA SilentlyContinue | Select -First 1
     if (-not $c) { Start-Sleep 5 } } until ($c -or (Get-Date) -gt $deadline)
if ($c) { "✅ 3200 監聽中 PID $($c.OwningProcess)" } else { "⚠️ 逾時未監聽" }
# HTTP 探測（307/200 皆代表有在服務；Next.js 會導向 locale/login）
try { (Invoke-WebRequest 'http://localhost:3200' -MaximumRedirection 0 -TimeoutSec 40).StatusCode }
catch { [int]$_.Exception.Response.StatusCode }
# 容器狀態 + dev log 末尾
docker ps --filter "name=ai-doc-extraction" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
Get-Content (Join-Path $env:LOCALAPPDATA 'ai-doc-devserver\dev-server.log') -Tail 20
```

**判定就緒**：埠 3200 監聽 + HTTP 回 200/307 + `ai-doc-extraction-db` healthy + log 出現 `✓ Ready`。

> log 內中文可能顯示為亂碼（console 編碼），不影響服務；以 `✓ Ready` 與 HTTP 回應為準。

---

## 常見狀況

| 狀況 | 處置 |
|------|------|
| 埠 3200 被非 node 佔用 | 勿盲殺；查該 PID 是什麼進程，改用其他埠（`-Port 3300` + 排程 Argument 同步改） |
| Docker 引擎連不上 | 啟動 Docker Desktop；若 `DOCKER_HOST` 指向錯誤位址可移除該環境變數（見 memory docker 啟動雙重故障） |
| PostgreSQL 遲遲不 healthy | 查 `docker logs ai-doc-extraction-db`；勿用 `down -v` 當作解法（會清資料） |
| 跨機/清快取後 middleware 500 | 確認 Step 3 有 `-Generate`；必要時 `-Clean` 清 `.next` |
| 只想清不重啟 | 只跑 Step 1-2 |
| 只想重啟不清 | 跳過 Step 2，直接 Step 3-5（`start-dev.ps1` 的 `docker-compose up -d` 對已存在容器是 no-op） |

---

## 相關

- `scripts\start-dev.ps1` — 統一啟動（`-Prepare` / `-Generate` / `-Clean` / `-SkipDocker` / `-Port`）
- `scripts\dev-server-detached.ps1` — 排程任務背景存活 wrapper（CHANGE-097）
- `scripts\init-new-environment.ps1` — 全新環境首次初始化（含 npm install / db push / seed）
- `.claude/CLAUDE.md` — 服務啟動流程與問題排解
- 相關 memory：dev server 排程啟動、殭屍 dev server、docker 啟動雙重故障
