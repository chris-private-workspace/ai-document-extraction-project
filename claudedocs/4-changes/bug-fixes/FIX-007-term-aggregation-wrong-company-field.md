# FIX-007: 術語聚合使用錯誤的公司欄位

> **狀態**: ✅ 已完成

## Bug 資訊

| 項目 | 內容 |
|------|------|
| Bug ID | FIX-007 |
| 發現日期 | 2026-01-02 |
| 修復日期 | 2026-01-02 |
| 嚴重程度 | High |
| 影響範圍 | Epic 0 - 術語聚合功能 |
| 相關 Story | Story 0.7, Story 0.8 |
| 發現來源 | TEST-PLAN-003 DHL 發票測試 |
| 狀態 | ✅ 已完成 |

---

## 問題描述

### 現象

在 TEST-PLAN-003 測試中，發現所有術語都被分組到 "UNKNOWN" 或 "未識別" 公司下，即使文件已正確識別發行公司。

### 根本原因

`batch-term-aggregation.service.ts` 使用了錯誤的公司欄位：

- **錯誤使用**: `identifiedCompanyId`（Story 0.6 - 交易方識別）
- **應該使用**: `documentIssuerId`（Story 0.8 - 文件發行者識別）

### Story 0.6 vs Story 0.8 的區別

| 欄位 | Story | 用途 | 識別方式 |
|------|-------|------|----------|
| `identifiedCompanyId` | 0.6 | 交易方（vendor/buyer）| 從發票欄位提取 |
| `documentIssuerId` | 0.8 | 文件發行公司 | 從 Logo/Header 識別 |

術語聚合應該按**文件發行者**（誰開的發票）分組，而非**交易方**（發票上的 vendor/buyer）。

---

## 問題分析

### 調試過程

1. 建立 `scripts/debug-company-matching.mjs` 調試腳本
2. 發現 `documentIssuerId` 欄位正確填充（有公司 ID）
3. 發現 `identifiedCompanyId` 欄位為 NULL
4. Grep 搜尋 `batch-term-aggregation.service.ts` 確認使用錯誤欄位

### 調試輸出

```
【7. 檢查所有 DHL 文件的匹配狀態】
DHL RVN INV 82277.pdf
  Issuer ID: ✅ 已匹配 (b9c2917e-1d38-45cd-9d22-acc2d058377e)
  Method: HEADER, Confidence: 0.98
```

DHL 文件的 `documentIssuerId` 是正確的，但術語聚合沒有使用它。

---

## 修復方案

### 修改文件

`src/services/batch-term-aggregation.service.ts`

### 修改內容

```diff
// Line 275-278
  select: {
    id: true,
    extractionResult: true,
-   identifiedCompanyId: true,
-   identifiedCompany: {
+   documentIssuerId: true,
+   documentIssuer: {
      select: { id: true, name: true },
    },
  },

// Line 290-291
- const companyId = file.identifiedCompanyId ?? 'UNKNOWN';
- const companyName = file.identifiedCompany?.name ?? '未識別';
+ const companyId = file.documentIssuerId ?? 'UNKNOWN';
+ const companyName = file.documentIssuer?.name ?? '未識別';
```

---

## 驗證方式

### 驗證步驟

1. 重新執行批次術語聚合
2. 檢查術語是否正確按公司分組
3. 確認不再有 "UNKNOWN" 公司（假設所有文件都有 documentIssuerId）

### 預期結果

- 術語應按 `documentIssuer` 分組，而非 "UNKNOWN"
- DHL 相關術語應出現在 "DHL Express (Hong Kong) Limited" 公司下

---

## 影響評估

### 受影響功能

- 批次術語聚合（`aggregateTermsForBatch`）
- 術語聚合結果儲存（`saveAggregationResult`）
- 術語聚合報表匯出

### 不受影響功能

- 階層術語聚合（`hierarchical-term-aggregation.service.ts`）- 已使用正確欄位
- 文件發行者識別（Story 0.8）- 工作正常

---

## 相關文件

- `src/services/batch-term-aggregation.service.ts` - 修復位置
- `src/services/hierarchical-term-aggregation.service.ts` - 參考實現
- `scripts/debug-company-matching.mjs` - 調試腳本
- `scripts/debug-issuer-structure.mjs` - 調試腳本

---

## 技術債務

此修復解決了 Story 0.6 和 Story 0.8 之間的混淆。未來開發時需注意：

- **術語聚合**: 使用 `documentIssuerId`（發行者）
- **交易方識別**: 使用 `identifiedCompanyId`（交易方）

---

## 驗證結果

### 重新聚合測試 (2026-01-02)

執行 `scripts/reaggregate-batch-terms.mjs` 對批次 `a5084d5f` 進行驗證：

| 指標 | 數值 |
|------|------|
| 總文件數 | 132 |
| 總術語數 | 625 |
| 過濾術語數 | 121 (19.4%) |
| 保留術語數 | 504 |
| 公司分組數 | 52 家公司 |
| "未識別" 公司 | 0 ✅ |

### 驗證確認

- ✅ **FIX-007 成功**: 所有術語都正確分組到公司
- ✅ **Page 2 地址過濾**: DHL 發票 Page 2 地址術語已正確過濾
  - `SGN HO CHI MINH RICOH VIETNAM COMPANY LIMITED`
  - `QUACH THI THIEN NHI 17F E.TOWN CENTRAL 11 DOAN VAN`
- ✅ **公司識別**: DHL Express 正確識別 8 種唯一術語

---

**修復者**: AI Assistant (Claude)
**審核者**: Development Team
