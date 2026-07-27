# CHANGE-053: 增強 Stage 2 格式識別硬編碼 Prompt 詳細程度

> **狀態**: ✅ 已完成

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-053 |
| **變更日期** | 2026-03-02 |
| **相關模組** | V3.1 三階段提取管線 — Stage 2 格式識別 |
| **影響範圍** | `stage-2-format.service.ts` 中的硬編碼 fallback Prompt |
| **優先級** | 中 |
| **狀態** | ✅ 已完成 |
| **依賴** | FIX-049（Seed/Static 修正需先完成，確保三者一致） |

---

## 問題描述

### 現有 Stage 2 硬編碼 Prompt

**文件**: `src/services/extraction-v3/stages/stage-2-format.service.ts` 第 333-347 行

```typescript
system: `You are an invoice format identification specialist.
Your task is to identify the format/template of this invoice.

${hasKnownFormats ? `Known formats (${config.source}):\n${formatList}` : 'No known formats - identify format characteristics from document.'}

Response format (JSON):
{
  "formatName": "string - identified format name",
  "confidence": number (0-100),
  "matchedKnownFormat": "string | null - if matched to known format",
  "formatCharacteristics": ["array of observed format characteristics"]
}`,
user: 'Identify the format/template of this invoice image.',
```

### 問題

1. **過於簡潔** — System Prompt 僅 6 行，未提供具體的格式識別指引
2. **缺少格式特徵指引** — 沒有說明應觀察哪些格式要素（版面佈局、表格結構、日期格式等）
3. **缺少物流/貨運領域知識** — 沒有提供貨運發票的常見格式模式
4. **User Prompt 單行** — 僅「Identify the format/template of this invoice image.」，缺少指引
5. **三個 Prompt 來源品質不平衡** — Stage 1 和 Stage 3 的硬編碼 Prompt 詳細程度遠高於 Stage 2

### 品質對比

| Stage | 硬編碼 Prompt 行數 | 內容豐富度 | 評分 |
|-------|-------------------|-----------|------|
| Stage 1（公司識別） | 15 行 | 4 種識別方法 + 優先級 + 動態公司列表 | 7/10 |
| **Stage 2（格式識別）** | **6 行** | **僅有已知格式列表 + JSON 格式** | **6/10** |
| Stage 3（欄位提取） | 30+ 行 | 欄位定義 + 術語映射 + JSON Schema | 9/10 |

---

## 變更方案

### 修改文件

| 文件 | 修改內容 |
|------|----------|
| `src/services/extraction-v3/stages/stage-2-format.service.ts` | 增強 `buildFormatIdentificationPrompt()` 方法 |

### 增強後的 Prompt

```typescript
private buildFormatIdentificationPrompt(config: FormatConfigLoadResult): {
  system: string;
  user: string;
} {
  const hasKnownFormats = config.formats.length > 0;

  const formatList = hasKnownFormats
    ? config.formats
        .map(
          (f) =>
            `- ${f.formatName}: ${f.patterns?.join(', ') || 'No patterns'}`
        )
        .join('\n')
    : '';

  return {
    system: `You are an invoice format identification specialist for freight and logistics documents.
Your task is to identify the format/template of this document by analyzing its visual layout and structure.

Key aspects to observe:
1. Overall layout: header position, table structure, footer information, page orientation
2. Line items arrangement: table format vs list format vs free-form text
3. Date and amount display formats (DD/MM/YYYY vs MM/DD/YYYY, decimal separators, thousand separators)
4. Distinctive elements: watermarks, logos placement, document numbering patterns, barcodes
5. Company branding: color schemes, fonts, specific section arrangements

${hasKnownFormats
  ? `Known formats (${config.source}):\n${formatList}\n\nFirst try to match against these known formats. If no match, describe the format characteristics for future identification.`
  : 'No known formats available. Describe the format characteristics in detail for future identification.'}

Response format (JSON):
{
  "formatName": "string - identified format name (e.g., 'DHL Standard Invoice', 'Maersk Freight Note')",
  "confidence": number (0-100),
  "matchedKnownFormat": "string | null - name of matched known format, null if new format",
  "formatCharacteristics": ["array of observed format characteristics, e.g., 'landscape table layout', 'logo at top-right', 'bank details in footer'"]
}`,
    user: `Analyze this document image and identify its format/template type.
Focus on the visual layout, table structure, and distinctive formatting elements rather than the content data.`,
  };
}
```

### 變更重點

| # | 增強項目 | 說明 |
|---|---------|------|
| 1 | 領域知識 | 加入「freight and logistics documents」上下文 |
| 2 | 觀察要點 | 5 個具體的格式觀察指引（佈局、表格、日期格式、特徵元素、品牌） |
| 3 | 已知格式指引 | 明確說明優先匹配已知格式，無匹配時描述特徵 |
| 4 | JSON 範例值 | 提供具體的 formatName 和 formatCharacteristics 範例 |
| 5 | User Prompt | 從 1 行擴展為 2 行，強調分析「佈局和結構」而非「內容」 |

---

## 預期效果

| 指標 | 變更前 | 變更後 |
|------|--------|--------|
| 格式名稱描述性 | 泛化（如 "Invoice Format 1"） | 具體（如 "DHL Standard Invoice"） |
| 格式特徵豐富度 | 1-2 個特徵 | 3-5 個特徵 |
| 已知格式匹配率 | 中等 | 提升（有明確指引優先匹配） |
| 新格式可辨識性 | 低（特徵描述模糊） | 高（有具體觀察指引） |

---

## 與 FIX-049 的協調

本 CHANGE 與 FIX-049 需要確保三個 Prompt 來源的 Stage 2 內容保持一致性：

| 來源 | 文件 | 責任方 |
|------|------|--------|
| 硬編碼 Fallback | `stage-2-format.service.ts` | **CHANGE-053**（本變更） |
| Static Prompt | `static-prompts.ts` | FIX-049 |
| Seed Data | `prisma/seed-data/prompt-configs.ts` | FIX-049 |

**執行順序建議**：先執行 FIX-049（修正錯誤內容），再執行 CHANGE-053（增強硬編碼版本）。FIX-049 的 Stage 2 Prompt 內容應與本 CHANGE 增強後的版本保持一致。

---

## 測試驗證

- [ ] `npm run type-check` 通過
- [ ] 修改僅涉及 `buildFormatIdentificationPrompt()` 方法內的字串常數
- [ ] 無邏輯變更，不影響解析代碼（`parseFormatResult` / `extractFormatFromParsed`）
- [ ] JSON 響應格式保持不變（`formatName`, `confidence`, `matchedKnownFormat`, `formatCharacteristics`）

---

## 相關文件

- `src/services/extraction-v3/stages/stage-2-format.service.ts` — 本次修改目標
- `src/services/static-prompts.ts` — FIX-049 修改
- `prisma/seed-data/prompt-configs.ts` — FIX-049 修改
- FIX-049 — 修正 Stage 2 Prompt 數據源錯誤

---

**建立者**: Claude AI
**建立日期**: 2026-03-02
