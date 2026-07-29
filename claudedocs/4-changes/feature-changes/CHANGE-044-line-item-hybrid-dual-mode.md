# CHANGE-044: Line Item Hybrid 雙模式 — DataTemplate 配置 Pivot/Expand 輸出模式

> **日期**: 2026-02-25
> **狀態**: ❌ 已取消（2026-07-29 併入 [CHANGE-113](CHANGE-113-line-item-group-key-multi-shipment-invoice.md)）
> **優先級**: Medium
> **類型**: Feature Enhancement
> **影響範圍**: DataTemplate Model、Template Matching Engine、DataTemplate UI
> **前置分析**: `docs/05-analysis/2026-02-25-ARCH-line-item-pivot-design.md` §2.2 + §3.3
> **前置條件**: CHANGE-043（方案 Y: Pivot 展平策略）已完成且驗證通過

---

## ⚠️ 本 CHANGE 已併入 CHANGE-113（2026-07-29）

DHL 發票（一份發票對應多個 shipment）需要**第三種**輸出模式：1 個 shipment = 1 列、組內費用再 pivot 成欄。三種模式共用同一個 `lineItemMode` 欄位與同一段分列邏輯，若本 CHANGE 先行實作，CHANGE-113 會被迫重構它的成果。

故 `lineItemMode` 的三個值（`PIVOT` / `EXPAND` / `GROUP`）改由 [CHANGE-113](CHANGE-113-line-item-group-key-multi-shipment-invoice.md) 一次定義完成，**本文件以下內容僅保留作為 EXPAND 模式的需求背景**，不再單獨實作。

---

## 變更背景

### CHANGE-043 完成後的狀態

CHANGE-043 實現了方案 Y（Pivot 模式）：
- lineItems 按 `classifiedAs` 聚合為 `li_*` pseudo-fields
- 1 文件 = 1 行，費用作為列
- 覆蓋 80-90% 用戶場景

### 剩餘 10-20% 場景

部分用戶場景需要**展開模式**（1 lineItem = 1 行）：
- 審計追溯：逐筆核對每個費用項
- 費用明細核對：檢查每個 lineItem 的原始描述
- 異常調查：查看具體哪筆費用異常

### 本 CHANGE 的目標

在 DataTemplate 上新增 `lineItemMode` 設定，讓用戶**按模板選擇**輸出格式：

```
┌──────────────────────────────────────────────┐
│  DataTemplate 設定                            │
│                                                │
│  📊 Line Item 輸出模式:                        │
│  ○ Pivot（1文件=1行，費用作為列）  ← 預設     │
│  ○ Expand（1 lineItem=1行）                   │
└──────────────────────────────────────────────┘
```

---

## 變更內容

### 3.1 DataTemplate 新增 `lineItemMode` 欄位

**DB Schema 變更**：

```prisma
model DataTemplate {
  // ... 現有欄位 ...
  lineItemMode  String  @default("PIVOT") @map("line_item_mode")
  // 可選值: "PIVOT" | "EXPAND"
}
```

### 3.2 Template Matching Engine `processBatch()` 模式分叉

根據 `DataTemplate.lineItemMode` 走不同處理邏輯：

```
processBatch()
  │
  ├── lineItemMode = 'PIVOT'（預設，CHANGE-043 已實現）
  │   ├── extractMappedFields() + lineItem 展平
  │   ├── transformFields()
  │   └── upsertRow() → 1 Doc = 1 Row (rowKey = doc_number)
  │
  └── lineItemMode = 'EXPAND'
      ├── extractHeaderFields() → header 欄位
      ├── 遍歷每個 lineItem:
      │   ├── 合併 header fields + lineItem fields
      │   ├── transformFields()
      │   └── upsertRow() → 1 lineItem = 1 Row (rowKey = doc#_line#)
      └── 結果: 1 Doc = N Rows
```

### 3.3 Expand 模式的 Row 生成邏輯

每個 lineItem 生成一行，header 欄位複製到每行：

```
文件 INV-001:
  header: { shipment_no: "SHP-001", date: "2026-01-15" }
  lineItems: [
    { description: "THC", classifiedAs: "THC", amount: 100 },
    { description: "Ocean Freight", classifiedAs: "OCEAN_FREIGHT", amount: 500 },
  ]

Expand 模式輸出:
  Row 1: { rowKey: "INV-001_0", shipment_no: "SHP-001", date: "2026-01-15",
           li_description: "THC", li_classifiedAs: "THC", li_amount: 100 }
  Row 2: { rowKey: "INV-001_1", shipment_no: "SHP-001", date: "2026-01-15",
           li_description: "Ocean Freight", li_classifiedAs: "OCEAN_FREIGHT", li_amount: 500 }
```

### 3.4 Expand 模式的 SourceField 命名

Expand 模式下，每行可用的 lineItem sourceFields：

| sourceField | 說明 |
|-------------|------|
| `li_description` | lineItem 原始描述 |
| `li_classifiedAs` | lineItem 分類結果 |
| `li_amount` | lineItem 金額 |
| `li_quantity` | lineItem 數量 |
| `li_unitPrice` | lineItem 單價 |
| `li_currency` | lineItem 幣別 |

### 3.5 DataTemplate UI 新增模式選擇

在 DataTemplate 建立/編輯表單中新增 `lineItemMode` radio button。

### 3.6 SourceFieldSelector 模式感知

根據 `lineItemMode` 顯示不同的 lineItem 欄位選項：
- **Pivot 模式**：顯示 `li_{classifiedAs}_total`、`li_{classifiedAs}_count`（聚合欄位）
- **Expand 模式**：顯示 `li_description`、`li_amount` 等（單行欄位）

---

## 技術設計

### 修改範圍

| # | 文件 | 變更內容 | 類型 | LOC |
|---|------|----------|------|-----|
| 1 | `prisma/schema.prisma` | DataTemplate 新增 `lineItemMode` 欄位 | 🔧 修改 | 3 |
| 2 | DB Migration | `npx prisma migrate dev --name add_line_item_mode` | 🆕 新增 | — |
| 3 | `src/types/data-template.ts`（或相關類型文件） | 新增 `LineItemMode` 類型定義 | 🔧 修改 | 5 |
| 4 | `src/services/template-matching-engine.service.ts` | `processBatch()` 根據 lineItemMode 分叉；新增 `expandLineItems()` 方法 | 🔧 修改 | 80 |
| 5 | `src/services/template-matching-engine.service.ts` | `loadDocuments()` 同時讀取 DataTemplate.lineItemMode | 🔧 修改 | 5 |
| 6 | `src/components/features/data-template/DataTemplateForm.tsx` | 新增 lineItemMode radio button | 🔧 修改 | 30 |
| 7 | `src/lib/validations/data-template.ts`（或相關 Zod schema） | 新增 lineItemMode 驗證 | 🔧 修改 | 5 |
| 8 | `src/services/data-template.service.ts` | CRUD 支持 lineItemMode 欄位 | 🔧 修改 | 5 |
| 9 | `src/app/api/v1/data-templates/route.ts`（或 [id]/route.ts） | API 支持 lineItemMode 欄位 | 🔧 修改 | 5 |
| 10 | `src/components/features/template-field-mapping/SourceFieldSelector.tsx` | 根據 lineItemMode 顯示不同 lineItem 欄位 | 🔧 修改 | 30 |
| 11-16 | `messages/{en,zh-TW,zh-CN}/dataTemplates.json` | lineItemMode 翻譯 | 🔧 修改 | 15 |
| 17-22 | `messages/{en,zh-TW,zh-CN}/templateFieldMapping.json` | Expand 模式欄位翻譯 | 🔧 修改 | 15 |
| | **合計** | | | **~200** |

### i18n 影響

| 語言 | 文件 | 需要更新的 Key |
|------|------|---------------|
| en | `messages/en/dataTemplates.json` | `form.lineItemMode.label`、`form.lineItemMode.pivot`、`form.lineItemMode.expand`、`form.lineItemMode.pivotDescription`、`form.lineItemMode.expandDescription` |
| zh-TW | `messages/zh-TW/dataTemplates.json` | 同上 |
| zh-CN | `messages/zh-CN/dataTemplates.json` | 同上 |
| en | `messages/en/templateFieldMapping.json` | `sourceField.expandFields.*`（li_description、li_amount 等） |
| zh-TW | `messages/zh-TW/templateFieldMapping.json` | 同上 |
| zh-CN | `messages/zh-CN/templateFieldMapping.json` | 同上 |

### 資料庫影響

**需要 DB Migration**：

```sql
ALTER TABLE "data_templates" ADD COLUMN "line_item_mode" VARCHAR(20) NOT NULL DEFAULT 'PIVOT';
```

- 新增欄位帶預設值 `'PIVOT'`，現有 DataTemplate 自動為 Pivot 模式
- 不影響現有數據

---

## 設計決策

1. **`lineItemMode` 放在 DataTemplate（非全域設定）** — 不同 DataTemplate 可能需要不同模式（如費用報表用 Pivot，審計清單用 Expand）
2. **預設值為 `'PIVOT'`** — 確保 CHANGE-043 的行為是預設行為，完全向後兼容
3. **Expand 模式的 rowKey 用 `doc#_lineIndex`** — 避免同一文件的多行 Row 衝突
4. **Expand 模式複製 header 欄位到每行** — 每行 Row 都是完整的，不需要額外 join
5. **Expand 模式的 sourceField 使用 `li_` 前綴** — 與 Pivot 模式一致，但欄位內容不同（Pivot 是聚合值，Expand 是單行值）
6. **不需要同時支持兩種模式** — 一個 DataTemplate 只能選一種模式，切換後需要重新 match

---

## 兩種模式的預期輸出對比

**同一份文件 INV-001** (`lineItems: THC $100, THC $50, Ocean Freight $500, Insurance $70`):

### Pivot 模式（CHANGE-043 已實現）

```
| Shipment # | Date       | THC | Ocean Freight | Insurance |
|------------|------------|-----|---------------|-----------|
| SHP-001    | 2026-01-15 | 150 | 500           | 70        |
← 1 行，THC 匯總為 150
```

### Expand 模式（本 CHANGE 新增）

```
| Shipment # | Date       | Description   | Classified As | Amount |
|------------|------------|---------------|---------------|--------|
| SHP-001    | 2026-01-15 | THC           | THC           | 100    |
| SHP-001    | 2026-01-15 | THC           | THC           | 50     |
| SHP-001    | 2026-01-15 | OCEAN FREIGHT | OCEAN_FREIGHT | 500    |
| SHP-001    | 2026-01-15 | Insurance     | INSURANCE     | 70     |
← 4 行，每個 lineItem 獨立一行
```

---

## 系統數據流（完整雙模式）

```
                    ┌──────────────────┐
                    │   文件上傳提取    │
                    │  (GPT Stage 3)   │
                    └────────┬─────────┘
                             │
                    fieldMappings + stage3Result.lineItems
                             │
                    ┌────────▼─────────┐
                    │ Template Matching │
                    │    Engine         │
                    └────────┬─────────┘
                             │
                  讀取 DataTemplate.lineItemMode
                             │
               ┌─────────────┼─────────────┐
               │                           │
      lineItemMode='PIVOT'        lineItemMode='EXPAND'
               │                           │
    ┌──────────▼──────────┐    ┌───────────▼───────────┐
    │ extractMappedFields │    │  expandLineItems()     │
    │  + 展平 lineItems    │    │  每個 lineItem 一行    │
    │  按 classifiedAs SUM │    │  header 欄位複製到每行 │
    └──────────┬──────────┘    └───────────┬───────────┘
               │                           │
    ┌──────────▼──────────┐    ┌───────────▼───────────┐
    │ upsertRow()         │    │ upsertRow() × N       │
    │ 1 Doc = 1 Row       │    │ 1 Doc = N Rows        │
    │ rowKey = doc_number  │    │ rowKey = doc#_line#    │
    └──────────┬──────────┘    └───────────┬───────────┘
               │                           │
               └─────────────┬─────────────┘
                             │
                    ┌────────▼─────────┐
                    │  Excel 匯出       │
                    │ (邏輯不變，遍歷   │
                    │  fieldValues)     │
                    └──────────────────┘
```

---

## 影響範圍評估

### 文件影響清單

| 文件路徑 | 類型 | 說明 |
|----------|------|------|
| `prisma/schema.prisma` | 🔧 修改 | DataTemplate 新增 lineItemMode |
| `src/types/data-template.ts` | 🔧 修改 | LineItemMode 類型 |
| `src/services/template-matching-engine.service.ts` | 🔧 修改 | processBatch 分叉 + expandLineItems |
| `src/services/data-template.service.ts` | 🔧 修改 | CRUD 支持新欄位 |
| `src/app/api/v1/data-templates/*` | 🔧 修改 | API 支持新欄位 |
| `src/lib/validations/data-template.ts` | 🔧 修改 | Zod schema 擴展 |
| `src/components/features/data-template/DataTemplateForm.tsx` | 🔧 修改 | UI 新增 radio button |
| `src/components/features/template-field-mapping/SourceFieldSelector.tsx` | 🔧 修改 | 模式感知欄位列表 |
| `messages/{en,zh-TW,zh-CN}/dataTemplates.json` | 🔧 修改 | lineItemMode 翻譯 |
| `messages/{en,zh-TW,zh-CN}/templateFieldMapping.json` | 🔧 修改 | Expand 模式欄位翻譯 |

### 向後兼容性

- **完全向後兼容** — `lineItemMode` 預設值為 `'PIVOT'`，現有 DataTemplate 行為不變
- **Prisma Migration 安全** — 新增欄位帶預設值，不影響現有數據
- **SourceFieldSelector 平滑切換** — 根據 lineItemMode prop 動態調整顯示內容

---

## 實施計劃

```
前置條件: CHANGE-043 完成 + 測試通過
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Step 1: DB Schema + Migration
  ├── DataTemplate 加 lineItemMode 欄位
  └── npx prisma migrate dev

Step 2: 類型 + 驗證
  ├── LineItemMode 類型定義
  └── Zod schema 更新

Step 3: Service + API
  ├── data-template.service.ts 支持新欄位
  └── API route 支持新欄位

Step 4: Template Matching Engine — Expand 模式
  ├── processBatch() 讀取 lineItemMode
  ├── 新增 expandLineItems() 方法
  ├── Expand 的 rowKey 生成邏輯 (doc#_lineIndex)
  └── Expand 的 header 欄位複製

Step 5: UI
  ├── DataTemplateForm 新增 lineItemMode radio
  └── SourceFieldSelector 模式感知

Step 6: i18n
  └── 6 個 JSON 文件新增翻譯

Step 7: 驗證
  ├── npm run type-check
  ├── npm run lint
  ├── npm run i18n:check
  ├── Pivot 模式不受影響（回歸測試）
  └── Expand 模式 E2E: 1 文件 → N 行
```

---

## 風險評估

| 風險 | 嚴重度 | 機率 | 緩解措施 |
|------|--------|------|----------|
| Expand 模式 rowKey 衝突 | 中 | 低 | `doc#_lineIndex` 確保唯一 |
| Expand 模式 Row 數量過多 | 中 | 低 | 監控 lineItem 數量，設上限警告 |
| 模式切換後舊 Rows 未清理 | 高 | 中 | 切換模式時提示用戶重新 match |
| processBatch 邏輯複雜度增加 | 中 | 中 | 清晰的 if/else 分叉，各模式獨立方法 |
| SourceFieldSelector 狀態管理 | 低 | 低 | lineItemMode 作為 prop 傳入 |

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | DB Migration | DataTemplate 新增 lineItemMode 欄位，預設 PIVOT | High |
| 2 | DataTemplate UI | 建立/編輯表單顯示 Pivot/Expand radio button | High |
| 3 | Pivot 模式不受影響 | 現有 Pivot 行為完全不變（回歸） | High |
| 4 | Expand 模式基礎 | 選 Expand → match → 1 文件生成 N 行 Row | High |
| 5 | Expand rowKey | 每行 rowKey 為 `doc#_lineIndex`，不衝突 | High |
| 6 | Expand header 複製 | 每行 Row 都包含完整 header 欄位 | Medium |
| 7 | SourceFieldSelector 模式感知 | Pivot 顯示聚合欄位，Expand 顯示單行欄位 | Medium |
| 8 | 模式切換提示 | 切換模式時提示用戶需重新 match | Medium |
| 9 | i18n 同步 | 3 語言翻譯完整 | Medium |
| 10 | TypeScript 編譯 | `npm run type-check` 通過 | High |

---

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | Pivot 回歸 | 使用預設 PIVOT 模式的 DataTemplate → match | 行為與 CHANGE-043 完全一致 |
| 2 | Expand 基礎 | 建立 EXPAND DataTemplate → match 含 5 lineItems 的文件 | 生成 5 行 Row |
| 3 | Expand header 複製 | 同上 | 每行 Row 都有 shipment_no、date 等 header 欄位 |
| 4 | Expand rowKey 唯一 | 同上 | 5 行 Row 的 rowKey 各不相同 |
| 5 | Expand mapping | 建立 li_description → Description 的 DIRECT mapping → match | 每行有正確的 description |
| 6 | 模式切換 | 從 PIVOT 切換為 EXPAND | 提示需重新 match；切換後行為正確 |
| 7 | 新建 DataTemplate 預設值 | 不選 lineItemMode 直接建立 | 預設為 PIVOT |
| 8 | Excel 匯出 | Expand 模式 match 後匯出 | Excel 每行對應一個 lineItem |

---

## 相關文檔

| 文檔 | 路徑 |
|------|------|
| 架構設計分析（§2.2 方案 Z 完整說明） | `docs/05-analysis/2026-02-25-ARCH-line-item-pivot-design.md` |
| 前置 CHANGE: 方案 Y Pivot 展平 | `claudedocs/4-changes/feature-changes/CHANGE-043-line-item-pivot-flatten.md` |
| 方案 A 影響評估（已否決） | `docs/05-analysis/2026-02-25-ARCH-template-instance-line-item-expansion.md` |

---

*文件建立日期: 2026-02-25*
