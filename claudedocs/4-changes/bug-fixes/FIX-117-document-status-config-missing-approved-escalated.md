# FIX-117: 重試按鈕判斷不一致 + `DOCUMENT_STATUS_CONFIG` 缺 APPROVED / ESCALATED

> **日期**: 2026-07-20
> **狀態**: ✅ 已修復（type-check / lint / i18n:check 通過；UI 端到端待驗證）
> **嚴重度**: Sev3（UI 顯示錯誤 + 操作入口不一致）
> **類型**: Bug Fix（狀態設定表漂移）
> **影響範圍**: 文件列表頁、文件詳情頁的狀態徽章與重試按鈕

---

## 問題描述

### 症狀 1 — 重試按鈕在兩頁行為不一致

| 位置 | 判斷依據 | 涵蓋狀態 |
|------|----------|----------|
| 列表頁 `DocumentListTable.tsx:317` | `getStatusConfig(doc.status).canRetry` | `OCR_FAILED` / `REF_MATCH_FAILED` / `FAILED` |
| 詳情頁 `DocumentDetailHeader.tsx:84` | 硬編碼 `['OCR_FAILED', 'FAILED']` | `OCR_FAILED` / `FAILED` |

`REF_MATCH_FAILED` 的文件在列表頁看得到重試按鈕，點進詳情頁卻消失。

### 症狀 2 — 已核准 / 已升級的文件顯示為「處理失敗」

Prisma `DocumentStatus` enum 有 14 個值，但 `DOCUMENT_STATUS_CONFIG` 只定義了 12 個，缺 **`APPROVED`** 與 **`ESCALATED`**。

`getStatusConfig` 對未知狀態**回退到 `FAILED` 配置**（`document-status.ts:254-259`），而 FAILED 的 `isError: true`、`canRetry: true`。因此這兩種狀態的文件在列表頁會：

- 顯示紅色 **「處理失敗」** 徽章（實際上是已核准 / 已升級）
- 帶出**不該出現的重試按鈕**

### 為何漂移未被察覺

`DOCUMENT_STATUS_CONFIG` 的型別是 `Record<DocumentStatusKey, StatusConfig>`，而 `DocumentStatusKey` 是**手工維護的字串聯集**（`document-status.ts:44-56`），並非從 Prisma enum 推導。少定義兩個狀態不會產生型別錯誤，靜默漂移。

> 本地 DB 目前只有 `MAPPING_COMPLETED`(81) 與 `OCR_FAILED`(1)，沒有這兩種狀態，因此本地測試不會顯現。它們屬 Epic 3 審核工作流狀態，在實際運作環境會出現。

## 修正內容

| # | 檔案 | 內容 |
|---|------|------|
| 1 | `src/lib/document-status.ts` | `DocumentStatusKey` 加入 `'APPROVED' \| 'ESCALATED'` |
| 2 | `src/lib/document-status.ts` | 新增兩筆設定：APPROVED（綠色 / `Check` / `canRetry: false`）、ESCALATED（橘色 / `AlertCircle` / `canRetry: false`）；`order` 接續為 13 / 14 |
| 3 | `src/components/features/document/detail/DocumentDetailHeader.tsx` | 硬編碼陣列改為共用的 `canRetryStatus(document.status)` |
| 4 | `messages/{en,zh-TW,zh-CN}/documents.json` | `status.APPROVED` / `status.ESCALATED` 三語言同步 |

### 為何 `order` 採接續 13 / 14 而非插號重排

`order` 若插入 PENDING_REVIEW / COMPLETED 之間會需重編既有值。查證 `DOCUMENT_STATUS_CONFIG[].order` 在 `src/` 中無實質消費者（`document-progress.service.ts` 用的是另一份 `STAGE_CONFIG`，兩者無關），故採最小改動、不動既有編號。

### 修正 #3 的連帶行為變化

改用 `canRetryStatus()` 後，詳情頁對**未知狀態**的行為與列表頁一致 —— 兩者都會因 `getStatusConfig` 回退到 FAILED 而顯示重試按鈕。這是共用 helper 的既有語意，本 FIX 未變更；補齊 APPROVED / ESCALATED 後，已知狀態不再落入此回退路徑。

## 驗收

| # | 項目 | 標準 | 狀態 |
|---|------|------|------|
| 1 | 設定表與 Prisma enum 一致 | 14 個狀態一一對應 | ✅ |
| 2 | 詳情頁改用共用 helper | 不再有硬編碼狀態陣列 | ✅ |
| 3 | i18n 三語言同步 | `npm run i18n:check` | ✅ |
| 4 | 型別檢查 | `npm run type-check` | ✅ |
| 5 | Lint | `npx eslint`（修改檔） | ✅ |
| 6 | `REF_MATCH_FAILED` 兩頁一致顯示重試按鈕 | UI 實測 | ⏳ 本地無此狀態資料，待實測 |
| 7 | `APPROVED` / `ESCALATED` 顯示正確徽章且無重試按鈕 | UI 實測 | ⏳ 同上 |

## 建議後續（不在本 FIX 範圍）

`DocumentStatusKey` 手工維護是本次漂移的根因。可考慮改為由 Prisma enum 推導（例如 `Record<DocumentStatus, StatusConfig>`），使日後新增狀態時型別檢查會直接擋下遺漏。此改動會牽動所有引用 `DocumentStatusKey` 的位置，建議另立 CHANGE 評估。

## 關聯

- 同批 UAT 發現：[FIX-114](FIX-114-document-format-id-uuid-validation-blocks-format-scope.md)、[FIX-115](FIX-115-stage2-prompt-missing-knownformats-variable.md)、[FIX-116](FIX-116-resolve-endpoint-jsdoc-claims-merge-but-does-not.md)
- 未處理的相關缺口：成功處理的文件（`MAPPING_COMPLETED` 等）在 UI 上**完全沒有重跑入口**，但服務層 `retryProcessing`（`document.service.ts:567-608`）其實允許。屬產品決策，見操作指南記載。
