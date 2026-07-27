# CHANGE-008: Azurite 開發環境存儲整合

> **狀態**: ✅ 已完成

## 變更摘要

| 項目 | 內容 |
|------|------|
| 變更編號 | CHANGE-008 |
| 變更日期 | 2026-01-14 |
| 完成日期 | 2026-01-14 |
| 變更類型 | 開發環境改進 |
| 影響範圍 | 開發環境存儲 |
| 狀態 | ✅ 已完成 |

---

## 變更原因

- 本地文件系統 fallback 與生產環境（Azure Blob Storage）行為不一致
- 無法在開發環境測試 SAS URL 等 Azure 特定功能
- 開發和生產使用不同的代碼路徑，增加隱藏 bug 風險

---

## 變更內容

### 1. 新增 Azurite 到 Docker Compose

在 `docker-compose.yml` 新增 Azurite 服務：

```yaml
azurite:
  image: mcr.microsoft.com/azure-storage/azurite:latest
  container_name: ai-doc-extraction-azurite
  ports:
    - "10010:10000"  # Blob Service (避免與其他項目衝突)
    - "10011:10001"  # Queue Service
    - "10012:10002"  # Table Service
  volumes:
    - azurite_data:/data
  command: "azurite --blobHost 0.0.0.0 --queueHost 0.0.0.0 --tableHost 0.0.0.0"
  restart: unless-stopped
```

### 2. 配置開發環境使用 Azurite 連接字符串

`.env` 配置：
```bash
AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10010/devstoreaccount1;"
AZURE_STORAGE_CONTAINER="documents"
```

### 3. 移除本地存儲 Fallback

刪除檔案：
- `src/lib/azure/local-storage.ts`
- `src/app/api/uploads/[...path]/route.ts`

簡化 `src/lib/azure/storage.ts`：
- 移除本地存儲 fallback 邏輯
- 統一使用 Azure SDK（開發環境連接 Azurite）
- 更新錯誤訊息引導開發者啟動 Azurite

### 4. 更新開發文檔

更新 `.claude/CLAUDE.md`：
- 新增 Docker 服務端口列表
- 更新啟動流程（含 Azurite）
- 新增 Azure Storage 未配置問題排解

---

## 影響分析

| 影響項目 | 說明 |
|----------|------|
| 開發環境 | 需要先啟動 Azurite (`docker-compose up -d azurite`) |
| 生產環境 | 無影響（使用真實 Azure Blob Storage） |
| 代碼路徑 | 開發/生產統一使用 Azure SDK |
| 測試覆蓋 | 可在開發環境測試 SAS URL 等 Azure 特定功能 |

---

## 驗證方式

### 1. 啟動 Azurite
```bash
docker-compose up -d azurite
docker-compose logs azurite  # 確認啟動成功
```

### 2. 測試上傳
1. 訪問 `http://localhost:3000/invoices/upload`
2. 上傳測試文件
3. 確認無錯誤，文件成功上傳

### 3. 驗證 Azurite 存儲
```bash
# 使用 Azure Storage Explorer 連接 Azurite
# 或使用 curl 測試 Blob API
curl http://127.0.0.1:10010/devstoreaccount1/documents?restype=container
```

---

## 回滾方案

如需恢復本地存儲 fallback：
1. 從 git 恢復 `local-storage.ts` 和 `api/uploads` route
2. 恢復 `storage.ts` 中的 fallback 邏輯
3. 從 `.env` 移除 `AZURE_STORAGE_CONNECTION_STRING`

---

## Azurite 連接資訊

| 項目 | 值 |
|------|---|
| Account Name | `devstoreaccount1` |
| Account Key | `Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==` |
| Blob Endpoint | `http://127.0.0.1:10010/devstoreaccount1` |
| Queue Endpoint | `http://127.0.0.1:10011/devstoreaccount1` |
| Table Endpoint | `http://127.0.0.1:10012/devstoreaccount1` |

> 這些是 Azurite 的標準測試帳戶資訊，可安全使用於開發環境。

---

## 相關文件

| 檔案 | 操作 |
|------|------|
| `docker-compose.yml` | 新增 Azurite 服務 |
| `.env.example` | 新增 Azurite 配置說明 |
| `.env` | 設置 Azurite 連接字符串 |
| `src/lib/azure/storage.ts` | 簡化邏輯，移除本地 fallback |
| `src/lib/azure/local-storage.ts` | **刪除** |
| `src/app/api/uploads/[...path]/route.ts` | **刪除** |
| `.claude/CLAUDE.md` | 更新開發文檔 |

---

---

## 驗證結果

**驗證日期**: 2026-01-14

### 測試結果

| 測試項目 | 結果 | 說明 |
|----------|------|------|
| Azurite 服務啟動 | ✅ 通過 | Docker 容器正常運行於 10010/10011/10012 端口 |
| 文件上傳到 Azurite | ✅ 通過 | 文件成功上傳到 `http://127.0.0.1:10010/devstoreaccount1/documents/` |
| 容器自動創建 | ✅ 通過 | 首次上傳時自動創建 `documents` 容器 |
| 資料庫記錄創建 | ✅ 通過 | 文件記錄成功插入 `documents` 表 |
| 城市代碼傳遞 | ✅ 通過 | 城市選擇器正確傳遞 `cityCode` (TPE) |

### 測試記錄

```sql
-- 驗證資料庫記錄
SELECT id, file_name, status, city_code, created_at
FROM documents ORDER BY created_at DESC LIMIT 1;

-- 結果:
-- id: 6cb23cee-94c7-4d8d-88f0-9b11a43fad8d
-- file_name: test-page-1.png
-- status: OCR_FAILED (預期，因無真實 OCR 服務)
-- city_code: TPE
-- created_at: 2026-01-14 08:29:35
```

### 額外修復

在整合過程中發現並修復了以下問題：

1. **上傳頁面缺少城市選擇器**
   - 文件: `src/app/(dashboard)/invoices/upload/page.tsx`
   - 修復: 添加城市選擇器組件，使用 `useCitiesGrouped` hook

2. **容器不自動創建**
   - 文件: `src/lib/azure/storage.ts`
   - 修復: 添加 `containerEnsured` 標記，首次上傳時調用 `ensureContainer()`

---

*變更記錄建立日期: 2026-01-14*
*驗證完成日期: 2026-01-14*
