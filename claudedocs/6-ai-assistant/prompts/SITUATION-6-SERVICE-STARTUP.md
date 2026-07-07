# 🚀 情況6: 服務啟動 - 重新啟動所有開發環境服務

> 🔴 **啟動優先用統一腳本**：手動前景啟動用 `scripts/start-dev.ps1`（Windows）／`scripts/start-dev.sh`（Bash）——含 Docker 啟動、PostgreSQL healthy 等待、Prisma generate 偵測、端口檢查；需 dev server 跨 AI session 存活時，用排程任務 `AiDocDevServer`（`schtasks /run /tn AiDocDevServer`，內部呼叫 `scripts/dev-server-detached.ps1`，log 在 `%LOCALAPPDATA%\ai-doc-devserver\dev-server.log`）。本文件保留作為故障排解與情境背景參考。
>
> ⚠️ **端口注意**：dev server 預設端口已為 **3200**（`package.json` 自 CHANGE-096 起 `--port 3200`）。本文件下方部分歷史內容仍寫 3005，以 3200 為準。

> **使用時機**: 開發環境需要啟動或重啟所有服務
> **目標**: 確保所有 Docker 服務與 Next.js 開發伺服器正常運行
> **適用場景**: 電腦重開機後、服務異常、開始新的開發工作、容器衝突排除

---

## 📋 Prompt 模板 (給開發人員)

```markdown
請幫我重新啟動本項目的所有服務。

當前狀態: [首次啟動 / 服務異常 / 電腦重開機 / 容器衝突]

請幫我:

1. 檢查並啟動 Docker 服務
   - 確認所有容器狀態
   - 處理任何容器衝突或殘留
   - 啟動全部服務（PostgreSQL, pgAdmin, Azurite, OCR, Mapping）

2. 啟動 Next.js 開發伺服器
   - 檢查端口佔用情況
   - 使用可用端口啟動開發伺服器
   - 等待服務就緒

3. 驗證所有服務
   - 確認每個服務健康狀態
   - 瀏覽器驗證前端可訪問
   - 報告最終服務狀態

請用中文完成所有步驟。
```

---

## 🤖 AI 助手執行步驟

### Step 1: 檢查 Docker 服務狀態 (1 分鐘)

```bash
# 1. 檢查當前 Docker 容器狀態
Bash: cd "C:\Users\rci.ChrisLai\Documents\GitHub\ai-document-extraction-project" && docker-compose ps

# 2. 檢查端口佔用
Bash: netstat -ano | findstr LISTENING | findstr ":3000 :3005 :3200 :5433 :5050 :8000 :8001 :10010"
```

### Step 2: 處理容器衝突（如有）(1 分鐘)

> **常見問題**: 容器名稱衝突 (如 `ai-doc-extraction-ocr` 殘留)

```bash
# 情境 A: 容器名稱衝突
# 錯誤訊息: "The container name is already in use by container..."
# 解決方案:
Bash: docker rm -f <conflicting-container-name>

# 情境 B: 容器狀態不健康
# 解決方案: 先停止再重啟
Bash: docker-compose down && docker-compose up -d

# 情境 C: 正常啟動（無衝突）
Bash: docker-compose up -d
```

### Step 3: 啟動或重啟 Docker 服務 (2 分鐘)

```bash
# 1. 停止所有服務（乾淨重啟）
Bash: docker-compose down

# 2. 如果有殘留容器衝突，強制移除
Bash: docker rm -f <container-name>

# 3. 啟動所有服務
Bash: docker-compose up -d

# 4. 確認所有服務運行中
Bash: docker-compose ps
```

**預期結果**（5 個服務全部運行）:

| 容器名稱 | 服務 | 端口 | 健康狀態 |
|----------|------|------|----------|
| ai-doc-extraction-db | PostgreSQL 15 | 5433→5432 | healthy |
| ai-doc-extraction-pgadmin | pgAdmin 4 | 5050→80 | running |
| ai-doc-extraction-azurite | Azure Storage 模擬器 | 10010-10012 | running |
| ai-doc-extraction-ocr | OCR 提取服務 (Python) | 8000 | healthy |
| ai-doc-extraction-mapping | Forwarder 映射服務 (Python) | 8001 | healthy |

### Step 4: 啟動 Next.js 開發伺服器 (1 分鐘)

```bash
# 1. 檢查端口佔用
Bash: netstat -ano | findstr ":3000 :3005 :3200" | findstr LISTENING

# 2. 啟動開發伺服器（專案預設 port 3200）
Bash: npm run dev
# 注意: package.json 中 dev script 自 CHANGE-096 起為 --port 3200

# 3. 如果 port 3200 被佔用，使用備用端口
Bash: npm run dev -- -p 3200
```

**備用端口優先順序**: 3200 (預設) → 3300 → 3500

### Step 5: 等待並驗證服務就緒 (1 分鐘)

```bash
# 1. 等待 Next.js 編譯完成（約 30-45 秒）
# 預期輸出:
#   ▲ Next.js 15.x
#   - Local: http://localhost:3005
#   ✓ Ready in X.Xs

# 2. 確認端口監聽
Bash: netstat -ano | findstr ":3005" | findstr LISTENING

# 3. 使用 Playwright 驗證瀏覽器訪問
mcp__plugin_playwright_playwright__browser_navigate → http://localhost:3005
# 預期: 重定向至 /en/auth/login 頁面
```

### Step 6: 生成服務狀態報告

```markdown
# 📊 服務啟動狀態報告

## 時間
- **日期**: YYYY-MM-DD
- **時間**: HH:MM

## Docker 服務

| 服務 | 容器名稱 | 端口 | 狀態 |
|------|----------|------|------|
| PostgreSQL | ai-doc-extraction-db | 5433 | ✅ healthy |
| pgAdmin | ai-doc-extraction-pgadmin | 5050 | ✅ running |
| Azurite | ai-doc-extraction-azurite | 10010-10012 | ✅ running |
| OCR 提取 | ai-doc-extraction-ocr | 8000 | ✅ healthy |
| Forwarder 映射 | ai-doc-extraction-mapping | 8001 | ✅ healthy |

## Next.js 開發伺服器

| 項目 | 值 |
|------|------|
| 版本 | Next.js 15.x |
| 端口 | 3005 |
| URL | http://localhost:3005 |
| 狀態 | ✅ Ready |

## 瀏覽器驗證
- ✅ 成功載入登入頁面 (/en/auth/login)

## 問題排除記錄（如有）
- [問題描述] → [解決方案]
```

---

## ⚠️ 常見問題排查

### 問題 1: Docker 容器名稱衝突

**症狀**: `Conflict. The container name "/ai-doc-extraction-xxx" is already in use`

**原因**: Docker 容器未正確清理，殘留的舊容器佔用了名稱

**解決方案**:
```bash
# 強制移除衝突容器
docker rm -f ai-doc-extraction-ocr
# 或移除所有相關容器
docker rm -f ai-doc-extraction-ocr ai-doc-extraction-mapping ai-doc-extraction-pgadmin
# 然後重新啟動
docker-compose up -d
```

### 問題 2: 端口已被佔用 (EADDRINUSE)

**症狀**: `EADDRINUSE: address already in use :::3005`

**解決方案**:
```powershell
# 查找佔用端口的進程
netstat -ano | findstr :3005 | findstr LISTENING
# 記錄 PID（最後一欄數字）
taskkill /F /PID <PID>
# 或直接使用備用端口
npm run dev -- -p 3200
```

### 問題 3: Docker 服務啟動後不健康

**症狀**: `docker-compose ps` 顯示 unhealthy 或 restarting

**解決方案**:
```bash
# 查看容器日誌
docker-compose logs <service-name>
# 完全重建
docker-compose down -v && docker-compose up -d --build
```

### 問題 4: PostgreSQL 連線失敗

**症狀**: `PrismaClientInitializationError`

**解決方案**:
```bash
# 確認 PostgreSQL 容器健康
docker-compose ps | findstr postgres
# 重新生成 Prisma Client
npx prisma generate
# 測試資料庫連線
npx prisma db pull
```

### 問題 5: Azurite 未運行導致檔案上傳失敗

**症狀**: `Azure Storage 未配置` 錯誤

**解決方案**:
```bash
# 確認 Azurite 運行中
docker-compose ps | findstr azurite
# 如未運行，單獨啟動
docker-compose up -d azurite
# 確認 .env 中的連接字串指向 Azurite
# AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;..."
```

---

## 📋 服務端口總覽

| 服務 | 端口 | 協議 | 說明 |
|------|------|------|------|
| Next.js Dev Server | 3005 | HTTP | 前端開發伺服器 |
| OCR Extraction | 8000 | HTTP | Python FastAPI OCR 服務 |
| Forwarder Mapping | 8001 | HTTP | Python FastAPI 映射服務 |
| PostgreSQL | 5433 | TCP | 資料庫（映射到容器內 5432）|
| pgAdmin | 5050 | HTTP | 資料庫管理 UI |
| Azurite Blob | 10010 | HTTP | Azure Blob Storage 模擬 |
| Azurite Queue | 10011 | HTTP | Azure Queue Storage 模擬 |
| Azurite Table | 10012 | HTTP | Azure Table Storage 模擬 |

---

## ✅ 驗收標準

服務啟動完成後，應確認以下項目全部通過：

### Docker 服務
- [ ] PostgreSQL 容器狀態為 healthy
- [ ] pgAdmin 容器正常運行
- [ ] Azurite 容器正常運行
- [ ] OCR 提取服務容器狀態為 healthy
- [ ] Forwarder 映射服務容器狀態為 healthy

### Next.js 開發伺服器
- [ ] 開發伺服器顯示 `✓ Ready`
- [ ] 端口監聽正常（`netstat` 確認）
- [ ] 瀏覽器可訪問登入頁面

### 整體驗證
- [ ] 所有 8 個端口正常監聽
- [ ] 無容器衝突或錯誤日誌
- [ ] 前端頁面正確渲染

---

## 🔗 相關文檔

### 開發流程指引
- [情況1: 專案入門](./SITUATION-1-PROJECT-ONBOARDING.md)
- [情況2: 開發前準備](./SITUATION-2-FEATURE-DEV-PREP.md)
- [情況3: 舊功能進階/修正](./SITUATION-3-FEATURE-ENHANCEMENT.md)
- [情況4: 新功能開發](./SITUATION-4-NEW-FEATURE-DEV.md)
- [情況5: 保存進度](./SITUATION-5-SAVE-PROGRESS.md)

### 相關配置
- [docker-compose.yml](../../../docker-compose.yml) - Docker 服務配置
- [package.json](../../../package.json) - npm scripts 配置
- [.env.local](../../../.env.local) - 環境變數（含 Azurite 連線字串）
- [.claude/CLAUDE.md](../../../.claude/CLAUDE.md) - AI 助手詳細操作指引

---

**維護者**: AI 助手 + 開發團隊
**最後更新**: 2026-02-06
**版本**: 1.0
