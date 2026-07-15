# FIX-028: 公司自動創建失敗問題

> **狀態**: ✅ 已完成

## 問題描述

**發現日期**: 2026-01-15
**影響範圍**: 歷史數據初始化處理流程中的公司自動創建功能
**嚴重程度**: 高
**狀態**: ✅ 已完成

### 症狀
在歷史數據初始化處理中，當識別到新公司時，系統應該自動創建公司記錄，但實際上創建失敗，導致所有已處理文件的 `documentIssuerId` 都是 NULL。

## 根本原因分析

### 問題：無效的 createdById

`DEFAULT_IDENTIFICATION_OPTIONS.createdById` 設置為 `'system'`，但數據庫中不存在 `id='system'` 的用戶。

**原始代碼** (src/types/issuer-identification.ts:350):
```typescript
export const DEFAULT_IDENTIFICATION_OPTIONS: Required<IssuerIdentificationOptions> = {
  // ...
  createdById: 'system',  // ❌ 數據庫中不存在此用戶
  // ...
};
```

**數據庫用戶狀態**:
| 用戶 | ID | 存在狀態 |
|------|-----|---------|
| System | `cmkdo23m60006hoxg57anxnkq` | 存在 |
| Dev User 1 | `dev-user-1` | 存在 |
| `'system'` | - | ❌ 不存在 |

### 失敗流程

1. UnifiedProcessor 調用 `extractDocumentIssuer()`
2. `documentIssuerService.identifyIssuer()` 識別到新公司
3. 嘗試 `prisma.company.create({ createdById: 'system' })`
4. FK 約束違反（`'system'` 不是有效的用戶 ID）
5. catch 塊返回 `{ isNewCompany: false }` 無 companyId
6. 文件的 `documentIssuerId` 保持 NULL

## 修復內容

### 修改文件
`src/types/issuer-identification.ts`

### 修復代碼
```typescript
// 修改前 (Line 350)
createdById: 'system',

// 修改後
createdById: 'dev-user-1', // FIX-028: 使用有效的系統用戶 ID
```

## 驗證方法

1. 重新處理批次或創建新批次
2. 確認新公司被正確創建
3. 確認 `documentIssuerId` 被正確設置
4. 導出術語報告，確認顯示正確的公司名稱

## 相關問題

- **FIX-002**: 將 `SYSTEM_USER_ID` 從 `'system'` 改為 `'dev-user-1'`
- **FIX-027**: 術語聚合報告空數據問題（已修復導出邏輯）

## 後續建議

1. **統一常數使用**: 考慮在所有需要系統用戶 ID 的地方導入並使用 `SYSTEM_USER_ID` 常數
2. **錯誤處理改進**: 公司創建失敗時應該記錄更明確的錯誤日誌
3. **資料完整性檢查**: 新增啟動時檢查，確保必要的系統用戶存在

---

**修復者**: Claude AI
**修復日期**: 2026-01-15
**驗證狀態**: ⏳ 待驗證
