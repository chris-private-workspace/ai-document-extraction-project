# FIX-058: Stage 2 格式 JIT 建立撞唯一約束（同公司第 2+ 份文件處理失敗）

> **建立日期**: 2026-05-31
> **發現方式**: FIX-057 修復後重新處理文件時觸發（dev server log）
> **影響頁面/功能**: Stage 2 格式識別（`jitCreateFormat`）、V3.1 提取管線
> **優先級**: 高
> **狀態**: ✅ 已修復（2026-05-31 驗證通過）

---

## 問題描述

修復 FIX-057（Stage 1 公司配對）後，文件能正確配對到既有公司；但接著 Stage 2 在 JIT 建立 `DocumentFormat` 時拋出唯一約束錯誤，導致整個管線失敗、文件狀態變 `OCR_FAILED`：

```
Invalid `prisma.documentFormat.create()` invocation:
Unique constraint failed on the fields: (`company_id`, `document_type`, `document_subtype`)
```

此 bug 與 FIX-057 為**同一類型**（JIT「先以 name 搜尋、找不到就盲目 create」，但唯一鍵不是 name）。

**影響範圍**：不只 re-process。`jitCreateFormat` 永遠以 `documentType='INVOICE'`、`documentSubtype='GENERAL'` 建立格式，而唯一約束是 `(company_id, document_type, document_subtype)`。因此**每間公司最多只能有一個 JIT 格式**；當 Stage 2 以**格式 name** 找不到既有格式、又嘗試建立第 2 個 `(INVOICE, GENERAL)` 時就撞約束 → **同公司同 (type/subtype) 的第 2+ 份文件都會失敗**。

---

## 重現步驟

1. 一間 Company（如 `Fairate Express`，已被 Stage 1 正確配對）。
2. 處理該公司第 1 份發票 → Stage 2 JIT 建立格式 `(INVOICE, GENERAL)` 成功。
3. 處理該公司**第 2 份**發票（或重新處理第 1 份）→ Stage 2 以格式 name 找不到既有格式 → 嘗試再建 `(INVOICE, GENERAL)`。
4. 觀察現象：`prisma.documentFormat.create()` 撞 `(company_id, document_type, document_subtype)` 唯一約束 → 管線失敗 → 文件 `OCR_FAILED`。

**實測**：document `ee9421b1`（公司 `369c787f` 已有 15:10 建立的 `(INVOICE, GENERAL)` 格式 `Air Freight Charge Invoice / Freight Charge Summary`）。

---

## 根本原因

`src/services/extraction-v3/stages/stage-2-format.service.ts` 的 `resolveFormatId` → `jitCreateFormat`（約 533-563 行）：

```ts
private async jitCreateFormat(formatName, companyId, characteristics) {
  const newFormat = await this.prisma.documentFormat.create({
    data: {
      name: formatName,
      companyId,
      documentType: 'INVOICE',
      documentSubtype: 'GENERAL', // 永遠 GENERAL
      ...
    },
  });
  ...
}
```

- `resolveFormatId` 先以 `name` 精確 / 模糊搜尋既有格式（472、491 行），找不到才 `jitCreateFormat`。
- 但 `jitCreateFormat` **無條件** `create`，且 `(documentType, documentSubtype)` 固定為 `(INVOICE, GENERAL)`。
- 唯一約束為 `(company_id, document_type, document_subtype)`，故同公司第 2 個 `(INVOICE, GENERAL)` 即撞約束。

---

## 解決方案

`jitCreateFormat` 改為 **find-or-create**：先以唯一鍵 `(companyId, documentType, documentSubtype)` 查找既有格式，存在則直接回傳，不存在才建立。

```ts
private async jitCreateFormat(formatName, companyId, characteristics) {
  const documentType = 'INVOICE' as const;
  const documentSubtype = 'GENERAL' as const;

  // FIX-058: 先以唯一鍵查找，避免重複 create 撞唯一約束
  const existing = await this.prisma.documentFormat.findFirst({
    where: { companyId, documentType, documentSubtype },
    select: { id: true, name: true },
  });
  if (existing) {
    return { id: existing.id, name: existing.name || formatName };
  }

  const newFormat = await this.prisma.documentFormat.create({ data: { ... } });
  return { id: newFormat.id, name: newFormat.name || formatName };
}
```

> ⚠️ 注意（H1）：僅修「JIT find-or-create」，不改三層映射 / 信心度 / Prisma model 結構。屬 bug fix。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/services/extraction-v3/stages/stage-2-format.service.ts` | `jitCreateFormat` 改為 find-or-create（先查 `(companyId, documentType, documentSubtype)` 唯一鍵） |

---

## 測試驗證

修復完成後需驗證：

- [x] 重新處理 `ee9421b1` → Stage 2 不再撞唯一約束，管線完整跑完（`MAPPING_COMPLETED`）
- [x] 文件配對到既有公司 `369c787f` + Stage 3 套用 Fairate `PromptConfig` + 6 費用欄位（FIX-057 + FIX-058 端到端綠燈，confidence 75.25% → QUICK_REVIEW）
- [x] 同公司處理第 2 份文件 → 重用既有 `(INVOICE, GENERAL)` 格式，不再失敗（`e9ba60af` 重新處理驗證）
- [x] 不再 JIT 增生重複 `DocumentFormat`
- [x] `npm run type-check`（修改檔案無錯誤）+ `npx eslint`（0 errors）通過

---

*文件建立日期: 2026-05-31*
*最後更新: 2026-05-31*
