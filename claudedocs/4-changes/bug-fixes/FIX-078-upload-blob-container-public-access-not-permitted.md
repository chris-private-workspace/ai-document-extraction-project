# FIX-078: Azure DEV 文件上傳全部失敗（400）— Blob container 要求公開存取被拒

> **建立日期**: 2026-06-17
> **發現方式**: 用戶於 Azure DEV 環境實測回報（瀏覽器 console 顯示 `POST /api/documents/upload 400`）
> **影響頁面/功能**: `/[locale]/documents/upload`（文件上傳）→ `POST /api/documents/upload`；Azure DEV 環境下**所有**上傳一律失敗
> **優先級**: 高（核心功能在 Azure 完全不可用）
> **狀態**: ✅ 已修復（2026-06-17，程式碼）｜⏳ 待 Azure 重建映像部署後做執行期驗證

---

## 問題描述

在 Azure DEV 環境上傳文件時，前端固定收到 `400 (Bad Request)`，console 拋出 generic `Error: Upload failed`：

```
POST https://webapp-raposcm-aidocprocessing-dev-...azurewebsites.net/api/documents/upload 400 (Bad Request)
Uncaught (in promise) Error: Upload failed
    at Object.mutationFn (page-....js)
```

此 400 具**誤導性**：它不是輸入驗證錯誤，而是「該批次內**每一個**檔案都在伺服器端失敗」。

`upload/route.ts:424` 的邏輯：

```typescript
const statusCode = uploaded.length > 0 ? 201 : 400
```

當所有檔案都進 `failed[]`、`uploaded.length === 0` 時回 400，且回應 body 為 `{ success:true, data:{ uploaded:[], failed:[…] } }`（**不含 `error` 欄位**）。前端 `FileUploader.tsx:234-237` 在 `!response.ok` 時讀 `error.error?.detail`，讀不到便 fallback 成 `t('upload.uploadFailed')` → 即 console 看到的 generic「Upload failed」。

每個檔案的實際例外被 `route.ts:347-353` 的 `try/catch` 吞掉（只 `console.error('Failed to upload <file>:', error)` 印到容器 log），前端完全看不到真因。

---

## 重現步驟

1. 登入 Azure DEV 環境的 Web App。
2. 進入「文件上傳」頁，選擇城市。
3. 拖入任一合法 PDF/JPG/PNG（格式、大小皆通過前端驗證）。
4. 點「上傳」。
5. 觀察現象：請求回 `400`，toast/console 顯示 generic「Upload failed」，所有檔案標記為失敗。

> 本地（Azurite）環境**無法重現** — Azurite 預設允許 container 公開存取，故 `access:'blob'` 不會被拒。此為純 Azure 環境問題（本地/Azure 配置差異）。

---

## 根本原因

透過 ARM `containerlogs` API 取得容器 stdout，找到伺服器端真正的例外：

```
"code": "PublicAccessNotPermitted"
"url":  "https://stscmdocprocessingdev.blob.core.windows.net/documents?restype=container"
"method": "PUT"
"headers": { "x-ms-blob-public-access": "blob", ... }
```

呼叫鏈：`upload/route.ts:310 uploadFile()` → `storage.ts:166 ensureContainer()` → `storage.ts:132 createIfNotExists({ access: 'blob' })`。

`createIfNotExists({ access: 'blob' })` 會送出「建立**匿名公開讀取（blob 級）** container」的 PUT 請求（header `x-ms-blob-public-access: blob`）。但 Azure DEV 的 Storage 帳號 `stscmdocprocessingdev` 刻意關閉公開 blob 存取（public network off + 私有端點、安全鎖定環境），故被回 `PublicAccessNotPermitted`。

關鍵：`createIfNotExists` **只會吞掉「container 已存在（`ContainerAlreadyExists`）」的錯誤**，不會吞 `PublicAccessNotPermitted`。因此無論 `documents` container 是否已存在，每次上傳的**第一步**（`ensureContainer`）就拋例外 → 整批檔案全進 `failed[]` → 回 400。

### 附帶確認（排除其他嫌疑）

該 PUT **有成功送達 Storage 並拿到 Azure 的正常政策錯誤回應**（非逾時、非 403 認證失敗）。代表容器到 Blob 私有端點的 **DNS、網路、shared-key 認證全部正常** — 先前懷疑的私有端點 DNS 解析問題（PostgreSQL 上線時曾踩）在此**不成立**，唯一卡點就是公開存取旗標。

---

## 解決方案

移除兩處 `createIfNotExists` 的 `access: 'blob'` 參數，改為建立 **private container**（不要求任何匿名公開存取）：

```typescript
// 修改前
await client.createIfNotExists({ access: 'blob' })

// 修改後
await client.createIfNotExists()   // private container，無匿名公開存取
```

### 為什麼安全（不會影響下載 / 預覽 / 處理）

文件的服務路徑**完全不依賴公開 blob URL**，一律走伺服器端串流：

| 路徑 | 取得方式 |
|------|----------|
| 下載 / 預覽 | `GET /api/documents/[id]/blob`（`[id]/blob/route.ts:112`）以 `downloadBlob()` 在伺服器端讀 Blob 後 `NextResponse` 串流回前端 |
| 詳情頁 `blobUrl` | `[id]/route.ts:203-205` 以 `blobName` 組成的 **proxy URL**，非 Azure 公開網址 |
| 統一處理管線 | `upload/route.ts:373`、`[id]/process/route.ts:148` 皆用 `downloadBlob()` 伺服器端讀取 |

`uploadResult.blobUrl` 雖被存入 `document.filePath`，但服務時並未直接對外暴露/取用。改成 private container 後：

- **本地 Azurite**：private container 一樣正常（串流服務不受影響）。
- **Azure DEV**：不再送出被禁止的公開存取請求 → 上傳成功。
- **安全性提升**：順帶移除一個從未被使用、且違反此環境安全姿態的匿名公開 blob 存取（呼應 H4 與「本地 vs Azure 配置分離」原則）。

此為**單一來源、本地/Azure 共用**的正解。

### 不採用的替代方案

在 Storage 帳號開啟 `allow-blob-public-access`，可讓現有程式碼跑通 — 但違反整個環境刻意鎖死（public-network-off + 私有端點）的安全姿態，且很可能被 Azure Policy 擋回或自動關閉。**不採用**。

---

## 修改的檔案

| 檔案 | 修改內容 | 狀態 |
|------|----------|------|
| `src/lib/azure/storage.ts` | `ensureContainer()` 內 `createIfNotExists({ access: 'blob' })` → `createIfNotExists()`（移除公開存取，建立 private container；加註說明）| ✅ 已改 |
| `src/lib/azure-blob.ts` | `getContainerClient()` 內 `createIfNotExists({ access: 'blob' })` → `createIfNotExists()`（同上）| ✅ 已改 |

> 兩處皆只移除 `access: 'blob'` 參數並補上說明註解，不改其他行為。

---

## 測試驗證

修復完成後需驗證：

- [x] `npm run type-check` 通過（2026-06-17）
- [x] ESLint（`src/lib/azure/storage.ts`、`src/lib/azure-blob.ts`）exit 0、無 warning（2026-06-17）
- [ ] 本地（Azurite）：上傳 PDF 成功、詳情頁可預覽、`/api/documents/[id]/blob` 可下載（確認 private container 不影響本地）
- [ ] 重建映像並部署 Azure DEV 後：上傳 PDF 回 `201`、`uploaded` 含該檔
- [ ] Azure DEV：上傳後文件詳情頁可正常預覽（伺服器端串流）
- [ ] Azure DEV 容器 log 不再出現 `PublicAccessNotPermitted`

---

## 備註

- 本問題屬「本地能跑、Azure 不能跑」的配置差異類，根因經容器 log 直接證實（非推測）。
- 修復後若仍有上傳失敗，需再查 `blockBlobClient.upload()` 或 `prisma.document.create()` 階段（本次 log 顯示流程未走到該兩步，故暫不在本 FIX 範圍）。

---

*文件建立日期: 2026-06-17*
*最後更新: 2026-06-17*
