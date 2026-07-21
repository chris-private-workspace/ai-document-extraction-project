# FIX-124: `jitCreateFormat` 撞唯一鍵時靜默沿用任意既有格式，文件被指派到錯誤格式

> **建立日期**: 2026-07-21
> **發現方式**: 批次重跑 86 份本地文件後的結果分析（FIX-115/121 rollout）
> **影響頁面/功能**: V3.1 Stage 2 格式識別 → 下游 FORMAT scope 配置（prompt / 欄位定義集 / 模板映射）
> **優先級**: 高
> **狀態**: 🚧 待修復

---

## 問題描述

當 GPT **明確判定「這不是任何已知格式」**（`matchedKnownFormat: null`）時，`resolveFormatId` 會走 JIT 建立分支。而 `jitCreateFormat` 為了避開唯一鍵，會先以 `(companyId, INVOICE, GENERAL)` 撈既有記錄 —— **一旦撈到就直接沿用它的 `id`**，完全不檢查該格式是否真的與文件相符。

結果：文件拿到一個**與自己版面無關**的 `formatId`，而 `isNewFormat` 被標為 `true`。下游任何依 `formatId` 解析的 FORMAT scope 配置都會**套錯設定**。

這與 [FIX-120](FIX-120-resolve-format-id-empty-name-silent-match.md) 是**同一類缺陷**（靜默匹配到任意格式），只是發生在 JIT 路徑而非模糊比對路徑。

---

## 重現步驟

1. 某公司底下已有至少一筆 `DocumentFormat`，其 `documentType/documentSubtype` 為 `INVOICE/GENERAL`。
2. 上傳一份該公司的**第三種版面**文件（與所有已登記格式皆不符）。
3. Stage 2 的 GPT 回傳 `matchedKnownFormat: null`，`formatName` 為自創的新名稱。
4. 觀察現象：`stage_2_result.formatId` 指向**既有的那筆格式**，`isNewFormat: true`。

---

## 根本原因

`jitCreateFormat`（`stage-2-format.service.ts:552-599`）：

```ts
// FIX-058: 先以唯一鍵 (companyId, documentType, documentSubtype) 查找既有格式，
//          避免重複 create 撞唯一約束（同公司同 type/subtype 的第 2+ 份文件）
const existing = await this.prisma.documentFormat.findFirst({
  where: { companyId, documentType, documentSubtype },
  select: { id: true, name: true },
});

if (existing) {
  return { id: existing.id, name: existing.name || formatName };   // ← 與文件無關的格式
}
```

`documentType` / `documentSubtype` 在此**寫死**為 `INVOICE` / `GENERAL`（`:557-558`），所以同一公司所有 JIT 建立都會撞同一個唯一鍵，第 2 筆之後**必然**落入 `existing` 分支。

[FIX-058](FIX-058-stage2-format-jit-unique-constraint.md) 當初加這段是為了解決唯一鍵衝突崩潰，屬正確處置；但它把「避免崩潰」實作成「沿用任意既有格式」，代價是**靜默的錯誤指派**。在 FIX-115 之前這個代價被掩蓋（那時所有文件都走 JIT、公司多半只有一個格式，看起來剛好正確）；FIX-115 讓多格式真正生效後，錯誤才浮現。

### 實測證據（本地，2026-07-21）

`CEVA LOGISTICS_CEX240464_39613.pdf`（CEVA 第三種版面，清關型）：

| 文件副本 | GPT `matchedKnownFormat` | GPT `formatName` | 實際寫入 `formatId` | `isNewFormat` |
|---|---|---|---|---|
| `7c3a75e8` | `null` | `CEVA_LOGISTICS_HONG_KONG_MIXED_LAYOUT_Invoice_(no_QR)_…` | `cmqur1q73000…`（版面 A） | `true` |
| `71d9ed62` | `null` | `CEVA Logistics (HONG KONG) LTD 貨運/清關型 Invoice（**非已知格式**）` | `cmqur1q73000…`（版面 A） | `true` |
| `29bce5aa` | `null` | `新格式：CEVA Logistics（HONG KONG）非 QR 的清關/運費彙總型 Invoice…` | `cmqur1q73000…`（版面 A） | `true` |

GPT 三次都明說「非已知格式」，系統三次都把它指派給版面 A。

**影響規模**：本地 86 份重跑後仍 `isNewFormat: true` 的 25 份中，22 份屬此類（CEVA 清關型版面）。

---

## 解決方案

需在「避免唯一鍵崩潰」與「不做錯誤指派」之間取捨。以下三案**需用戶決定**（各有 blast radius）：

| 選項 | 方案 | 優點 | 代價 |
|------|------|------|------|
| **A** | `existing` 命中時回傳 `formatId: undefined` + `isNewFormat: true` | 誠實：不指派錯誤格式，下游不會套錯 FORMAT scope 配置 | 這些文件將**沒有** `formatId`；若下游有非空假設需一併檢視 |
| **B** | `existing` 命中時仍沿用，但**明確標記**（如 `formatMatchQuality: 'FALLBACK'`）供下游與 UI 判讀 | 改動小、向後相容 | 錯誤指派仍存在，只是變得可見；下游需逐一改為尊重該旗標 |
| **C** | 依 GPT 特徵自動挑一個未使用的 `documentSubtype` 建真正的新格式 | 多版面自動成長 | `documentSubtype` 是**業務語義**（OCEAN_FREIGHT / AIR_FREIGHT…），由 AI 亂挑會污染資料，且 enum 有限（8 個）會耗盡 |

**建議 A**，理由：與 FIX-120 的處置原則一致（寧可回報「不確定」，也不要靜默給出看似成功的錯誤結果），且 `formatId` 本就是 optional（`resolveFormatId` 末段既有 `formatId: undefined` 的回傳路徑，見 `:541-545`）。

> 🔴 採 A 之前必須先盤點下游對 `formatId` 為空的容忍度（FORMAT scope 解析、模板匹配、UI 顯示），此盤點列為修復的第一步。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/services/extraction-v3/stages/stage-2-format.service.ts` | `jitCreateFormat` / `resolveFormatId`：`existing` 命中時的回傳語義（依選定方案） |
| `tests/unit/services/stage-2-format-resolve-format-id.test.ts` | 補迴歸測試 |
| （待盤點） | 下游對 `formatId` 為空的處理 |

---

## 測試驗證

修復完成後需驗證：

- [ ] 下游對 `formatId` 為空的容忍度盤點完成（修復前置）
- [ ] `matchedKnownFormat: null` 且公司已有 `INVOICE/GENERAL` 格式時，**不再**沿用該格式的 id
- [ ] 公司**尚無**任何格式時，JIT 仍正常建立新格式（不得回歸 FIX-058 的唯一鍵崩潰）
- [ ] 真正匹配到已知格式的路徑不受影響（`isNewFormat: false`）
- [ ] `npm run type-check`、`npm run lint`、既有 Stage 2 測試全過
- [ ] 重跑 CEVA 清關型文件，確認不再被指派為版面 A

---

## 關聯

- FIX-058 — 本問題的來源；其唯一鍵防護是必要的，但沿用既有格式的副作用未被考慮
- FIX-120 — 同類缺陷（靜默任意匹配）在模糊比對路徑的修復，處置原則可直接沿用
- FIX-123 — 名稱比對脆弱使更多文件**不必要地**落入 JIT，放大本問題；兩者需一併修復才完整
- FIX-115 — 讓多格式辨識真正生效，本問題因此才浮現

---

## 待辦（本 FIX 範圍外）

CEVA 的第三種版面（清關型）目前無對應 `DocumentFormat`。即使本 FIX 修好，那 22 份文件仍會是「未登記格式」。需另行建立第 3 個格式（可用 `CUSTOMS_CLEARANCE` subtype 避開唯一鍵），屬資料面設定，非程式缺陷。

---

*文件建立日期: 2026-07-21*
*最後更新: 2026-07-21*
