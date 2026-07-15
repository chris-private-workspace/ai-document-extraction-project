# FIX-022: CONFIG_FETCHING 使用錯誤的 PromptType

> **狀態**: ✅ 已修復

## 問題描述

CHANGE-006 驗證過程中發現，`CONFIG_FETCHING` 步驟無法正確載入已創建的 `PromptConfig`。

### 症狀
- `CONFIG_FETCHING.hasPromptConfig`: `false`
- `CONFIG_FETCHING.configSources`: `[]`
- `GPT_ENHANCED_EXTRACTION.gptResult`: 空

### 影響範圍
- 所有使用 `PromptConfig` 的動態配置功能
- CHANGE-006 GPT Vision 動態欄位提取功能

## 根本原因

`config-fetching.step.ts` 中使用了不存在的 `PromptType` 值：

```typescript
// 錯誤代碼 (Line 230)
promptType: 'DATA_EXTRACTION' as PromptType, // DATA_EXTRACTION 不存在於 enum
```

**PromptType enum 可用值**（來自 `prisma/schema.prisma:5236`）：
- `ISSUER_IDENTIFICATION`
- `TERM_CLASSIFICATION`
- `FIELD_EXTRACTION`
- `VALIDATION`

由於使用了 `as PromptType` 強制類型轉換，TypeScript 編譯器沒有報錯，但 Prisma 查詢時無法匹配到任何記錄。

## 修復方案

修改 `src/services/unified-processor/steps/config-fetching.step.ts` 第 230 行：

```typescript
// 修改前
promptType: 'DATA_EXTRACTION' as PromptType, // 默認使用資料提取 Prompt

// 修改後
promptType: 'FIELD_EXTRACTION' as PromptType, // 默認使用欄位提取 Prompt
```

## 修改文件

| 文件 | 變更 |
|------|------|
| `src/services/unified-processor/steps/config-fetching.step.ts` | 修正 promptType 值 |

## 驗證方式

1. 重啟開發服務器
2. 創建新批次並上傳 DHL 測試文件
3. 執行處理
4. 檢查 `CONFIG_FETCHING.hasPromptConfig` 應為 `true`

```bash
node scripts/check-change006-batch.mjs
```

## 相關資訊

| 項目 | 值 |
|------|-----|
| 發現日期 | 2026-01-06 |
| 發現於 | CHANGE-006 驗證測試 |
| 測試批次 | test change-006 by chris - 1 - 20260106 |
| 測試文件 | DHL_CIM250110_20978.pdf |

## 教訓

1. **避免 `as` 類型斷言**：使用 `as` 強制轉換會繞過 TypeScript 類型檢查
2. **使用 enum 值而非字串**：應直接使用 `PromptType.FIELD_EXTRACTION` 而非字串字面量
3. **單元測試覆蓋**：CONFIG_FETCHING 步驟需要增加單元測試，驗證 promptType 參數

---

**修復者**: Claude AI
**修復日期**: 2026-01-06
**狀態**: ✅ 已修復
