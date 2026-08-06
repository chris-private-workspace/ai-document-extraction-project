# AI 助手開發指引 - 詳細版

> 本文件為 Claude Code AI 助手的詳細操作指引，包含服務啟動、常見問題排解等。
>
> ⚠️ 本檔所有指令範例**只示範要打什麼指令**，不示範輸出。任何「執行結果」一律以系統當下真實回傳為準，不得依本檔編造。

---

## 🚀 開發服務啟動流程（必讀）

### 快速啟動檢查清單

```bash
# Step 1: 啟動所有 Docker 服務（含 Azurite）
docker-compose up -d

# Step 2: 確認服務運行中
docker-compose ps
# 確認 postgres / pgadmin / azurite 三個服務狀態為運行中（以實際輸出為準）。

# Step 3: 檢查端口佔用情況
netstat -ano | findstr :3000 | findstr LISTENING

# Step 4: 啟動開發服務器（預設 port 3000）
npm run dev

# Step 4b: 如果 port 3000 被佔用，使用其他端口
npm run dev -- -p 3200
```

### Docker 服務端口

| 服務 | 端口 | 說明 |
|------|------|------|
| PostgreSQL | 5433 | 資料庫 |
| pgAdmin | 5050 | 資料庫管理 UI |
| Azurite (Blob) | 10010 | Azure Blob Storage 模擬器 |
| Azurite (Queue) | 10011 | Azure Queue Storage 模擬器 |
| Azurite (Table) | 10012 | Azure Table Storage 模擬器 |

### 端口佔用處理（Windows）

**問題**: `EADDRINUSE: address already in use :::3000`

**解決方案**:

```powershell
# 方法 1: 查找並終止佔用端口的進程
netstat -ano | findstr :3000 | findstr LISTENING
# 記錄 PID（最後一欄數字）
taskkill /F /PID <PID>

# 方法 2: 直接使用其他端口
npm run dev -- -p 3200

# 方法 3: 批量檢查常用端口
netstat -ano | findstr LISTENING | findstr ":30"
```

**常用備用端口**: 3100, 3200, 3300, 3500

### 服務啟動後驗證

```bash
# 啟動後等待服務就緒（出現 Ready 字樣後再驗證）。
# 實際輸出一律以系統當下回傳為準——不要依本檔編造任何「應該看到」的畫面。
# 驗證：用 Playwright 導航到 http://localhost:3200，依真實回傳判斷。
```

---

## 🔧 常見問題排解

### 問題 1: 服務器啟動後無法訪問

**症狀**: 瀏覽器導航超時 (TimeoutError)

**排查步驟**:
1. 確認服務器進程存在: `tasklist | findstr node`
2. 確認端口監聽: `netstat -ano | findstr :3200 | findstr LISTENING`
3. 檢查服務器輸出日誌是否有錯誤

### 問題 2: Prisma 連接失敗

**症狀**: `PrismaClientInitializationError`

**解決方案**:
```bash
# 確認 Docker 資料庫運行中
docker-compose ps

# 重新生成 Prisma Client
npx prisma generate

# 檢查資料庫連接
npx prisma db pull
```

### 問題 3: 背景任務命令不執行

**症狀**: `run_in_background` 命令無輸出

**解決方案**:
- 背景任務無輸出時：用 TaskOutput 工具讀取（非阻塞模式）。
- 或改用前景執行並設較長 timeout，等系統真實回傳後再判斷。

### 問題 4: Azure Storage 未配置

**症狀**: `Azure Storage 未配置` 錯誤

**解決方案**:
```bash
# 1. 確認 Azurite 服務運行中
docker-compose ps | grep azurite

# 2. 如未運行，啟動它
docker-compose up -d azurite

# 3. 確認 .env 中已設置連接字符串
# AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10010/devstoreaccount1;"
```

**注意**: 開發環境使用 Azurite 模擬 Azure Blob Storage。確保 Azurite 在上傳文件前已啟動。

---

## 📋 AI 助手工作模式

### 啟動服務的標準流程

1. **啟動 Docker 服務** → `docker-compose up -d`（含 Azurite）
2. **確認服務運行** → `docker-compose ps`
3. **檢查端口** → `netstat -ano | findstr :3000 | findstr LISTENING`
4. **如被佔用** → 選擇備用端口 (3200 推薦)
5. **啟動服務** → `npm run dev -- -p 3200`
6. **等待就緒** → 等待 30-45 秒
7. **驗證服務** → `netstat` 確認端口監聽
8. **瀏覽器導航** → Playwright 導航到 localhost

### E2E 測試標準流程

1. 啟動服務 (見上方)
2. 導航到目標頁面
3. 執行測試操作
4. 驗證結果
5. 記錄測試報告

---

## 🗂️ 項目結構快速參考

```
關鍵目錄:
├── src/services/          # 業務邏輯服務（有自己的 CLAUDE.md）
├── src/app/api/           # API 路由（有自己的 CLAUDE.md）
├── src/app/[locale]/      # 頁面路由（有自己的 CLAUDE.md）
├── src/components/        # React 組件（有自己的 CLAUDE.md）
├── src/lib/ types/ hooks/ i18n/   # 各有自己的 CLAUDE.md
├── prisma/                # 資料庫 Schema（有自己的 CLAUDE.md）
├── messages/              # i18n 翻譯（有自己的 CLAUDE.md）
├── claudedocs/            # AI 助手文檔（有自己的 CLAUDE.md）
│   ├── 4-changes/         # Bug/Feature 變更記錄
│   └── 5-status/testing/  # 測試報告
├── docs/                  # 項目正式文檔（PRD / architecture / tech-specs / codebase-analyze）
├── tests/                 # unit / integration / e2e
├── python-services/       # Python 後端（extraction / mapping）
├── scripts/               # 工具腳本（有自己的 CLAUDE.md）
└── .snapshots/            # 不可逆資料操作的前置快照（FIX-15x 起）
```

> 📋 完整 sub-CLAUDE.md 地圖：`claudedocs/reference/sub-claude-md-map.md`

---

## ⚠️ 注意事項

### 端口選擇建議

| 端口 | 狀態 | 備註 |
|------|------|------|
| 3000 | 常被佔用 | Next.js 預設端口 |
| 3010 | 常被佔用 | 之前測試使用 |
| 3100 | 偶爾被佔用 | 備用端口 |
| 3200 | **推薦** | 較少衝突 |
| 3300 | 可用 | 備用 |

### 服務啟動等待時間

- **首次啟動**: 45-60 秒 (需編譯)
- **熱重載後**: 5-10 秒
- **驗證時機**: 看到 `✓ Ready` 訊息後

---

*文件建立日期: 2026-01-06*
*最後更新: 2026-08-06（補上 sub-CLAUDE.md 覆蓋標示與 docs/ tests/ python-services/ .snapshots/ 目錄）*
