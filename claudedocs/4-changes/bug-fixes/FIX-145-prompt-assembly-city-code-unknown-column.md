# FIX-145: Stage 1 動態 Prompt 的已知公司清單永遠是空的（查詢用了不存在的 cityCode 欄位）

> **建立日期**: 2026-07-29
> **發現方式**: CHANGE-113 階段一本地實測時，提取雖成功但 log 出現 `PrismaClientValidationError`
> **影響範圍**: `src/services/extraction-v3/prompt-assembly.service.ts`、Stage 1 公司識別品質
> **優先級**: 中（不會讓提取失敗，但持續削弱公司識別的輔助資訊）
> **狀態**: ⏳ 待實作

---

## 問題描述

`PromptAssemblyService.loadIssuerIdentificationRules()` 以 `cityCode` 過濾公司，但 `Company` model **沒有這個欄位**：

```
Invalid `prisma.company.findMany()` invocation
  where: { status: "ACTIVE", cityCode: "HKG" }
                             ~~~~~~~~
Unknown argument `cityCode`.
```

查證 `companies` 表：

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name='companies' AND column_name LIKE '%city%';
-- (0 rows)
```

---

## 為何一直沒被發現

錯誤被 `catch` 吞掉，只寫一行 `console.warn`，然後回傳空清單：

```typescript
// prompt-assembly.service.ts:280-286
} catch (error) {
  console.warn('[PromptAssembly] Failed to load companies:', error);
  return {
    knownCompanies: [],   // ← 靜默降級
    identificationMethods: ['LOGO', 'HEADER', 'ADDRESS', 'TAX_ID'],
  };
}
```

提取流程照常完成、不報錯、狀態正常，只是 Stage 1 的 prompt 少了「已知公司清單」這段輔助資訊。

---

## 觸發範圍：每一次提取

條件式展開讓人以為只在特定情境觸發：

```typescript
// prompt-assembly.service.ts:258
...(options.cityCode ? { cityCode: options.cityCode } : {}),
```

但生產路徑**永遠**帶入 `cityCode`：

```typescript
// extraction-v3.service.ts:854
cityCode: context.input.cityCode,
```

而 `ExtractionV3Input.cityCode` 是必填欄位（`extraction-v3.types.ts:677`）。因此**每一次 V3.1 提取都會觸發**，`knownCompanies` 恆為空陣列。

---

## 影響

Stage 1 的公司識別完全依賴 GPT 從 logo / 抬頭自行辨認，拿不到系統已知的公司清單作為對照。

實測（DHL Express）仍取得信心度 99 —— 品牌辨識度高的公司不受影響。但對名稱相近、需要靠既有清單消歧的情境（即 CHANGE-103 在處理的灰帶公司問題），少了這層輔助可能提高誤判與重複建檔的機率。

> ⚠️ 上述影響為**推論**，尚未量測。修復前應先確認：補上公司清單後，灰帶案例的識別結果是否確實改善。

---

## 修復方向（待評估）

需要先釐清 `Company` 與 `City` 的關聯方式 —— 目前 schema 中兩者沒有直接欄位關聯。可能選項：

| 選項 | 說明 | 待確認 |
|---|---|---|
| A | 移除 cityCode 過濾，載入全部 ACTIVE 公司（受 `maxCompanies` 限制） | 公司數量成長後 prompt 是否過長 |
| B | 經由 `documents` 表推導該城市出現過的公司 | 查詢成本；新公司無歷史文件時不會出現 |
| C | 為 `Company` 新增城市關聯 | 屬 schema 變更，觸發 H1，需另行評估 |

選項 A 最小，但可能不是原始設計意圖 —— 該方法的 JSDoc 寫著「目前使用簡化實現…完整功能需要 Schema 新增 aliases 和 identifiers 欄位」，顯示此處本就是未完成的簡化版本。

---

## 建議一併檢視

`catch` 區塊只 `console.warn` 就靜默降級，是這個缺陷存活至今的原因。修復時應考慮：查詢失敗屬於配置錯誤而非預期情況，至少該用 logger 記為 error 等級，讓它在監控中可見。

---

## 相關

- CHANGE-113 — 發現本問題的實測情境
- CHANGE-103 — 公司識別灰帶案例治理（本缺陷可能影響其成效）
