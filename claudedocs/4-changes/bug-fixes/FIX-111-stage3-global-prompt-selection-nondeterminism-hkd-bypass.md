# FIX-111: Stage 3 GLOBAL prompt 選型非確定性 → HKD 提取指示被旁路

> **日期**: 2026-07-16
> **狀態**: ✅ 程式碼 + 腳本完成 · ✅ Azure DEV 即時修正已套用（2026-07-16，讀回驗證 VERIFY_PASS）· ⏳ 程式碼根治待下次映像部署
> **嚴重度**: Sev2（提取正確性 — 費用金額取到錯誤幣別欄位，影響下游 template instance 數值）
> **類型**: Bug Fix（提取管線非確定性）
> **影響範圍**: `src/services/extraction-v3/stages/stage-3-extraction.service.ts`、Azure DEV `prompt_configs`
> **相關**: [[FIX-095]]（Stage 3 prompt 標準化）、[[FIX-110]]（CEVA 費用 alias）、[[project_lineitem_charge_extraction_nondeterminism]]

---

## 問題描述

使用者測試 `CEVA_RCIM250325_17865 1.PDF` 後回報：費用明細金額**沒有取文件上的 HKD 金額，而是取了原幣「amount」欄的金額**。使用者記得「之前有加過只取 in HKD 的金額」的指示。

對照另一份 `CEVA_RCIM250004_05808 1.pdf`：同一批 CEVA 文件卻**有**把 in-HKD amount 取進 `amount` 欄——同類文件、結果相反（非確定性）。

## 根因分析

### 事實 1：HKD 指示確實存在（使用者記憶正確）

Azure DEV `prompt_configs` 的 **GLOBAL `STAGE_3_FIELD_EXTRACTION`**（v3，updated 2026-07-10）user_prompt_template 明載：

```
3. All line items: description, quantity, unit price, amount (HKD only, per the currency rule)
```

其 system_prompt 亦含對應 currency rule。指示沒有消失、也沒被 FIX-095 洗掉。

### 事實 2：但 GLOBAL 有「兩型」active 提取 prompt

| prompt_type | 語言 | 版本 / 更新 | 含 HKD 規則 |
|---|---|---|---|
| `STAGE_3_FIELD_EXTRACTION`（V3.1 專用） | 英文 | v3 / 2026-07-10 | ✅ 有 |
| `FIELD_EXTRACTION`（Global Default，通用/legacy） | 中文 | v2 / 2026-06-29（FIX-095 模板） | ❌ 無 |

### 事實 3：選型是非確定性的（真正根因）

`loadPromptConfigHierarchical()`（`stage-3-extraction.service.ts`）GLOBAL 查詢原本是：

```ts
const globalConfig = await this.prisma.promptConfig.findFirst({
  where: { scope: 'GLOBAL', isActive: true,
           promptType: { in: ['STAGE_3_FIELD_EXTRACTION', 'FIELD_EXTRACTION'] } },
  // ← 無 orderBy！兩型都符合 → 由 Postgres 實體列順序任意選一
});
```

兩型都 active、又無 `orderBy` → `findFirst` 由 DB 列順序任意回傳。當選到 `FIELD_EXTRACTION`（無 HKD）時，HKD 提取指示整個被旁路 → GPT 取到非 HKD 欄。**這與 Stage 1 公司配對（[[CHANGE-103]]）是同一個「findFirst 無 orderBy → 非確定」anti-pattern**，並解釋了同批文件時對時錯。

> 註：FORMAT / COMPANY 兩個 scope 的查詢有相同缺陷（雖然目前 CEVA 無 COMPANY/FORMAT 提取 prompt），一併修正以防未來復發。

## 修正內容

### 修正 1（治本 — 程式碼）：決定性選型

`loadPromptConfigHierarchical()` 三個 scope（FORMAT / COMPANY / GLOBAL）的 `findFirst` 改為 `findMany({ orderBy: { updatedAt: 'desc' } })` + 新 helper `pickPreferredExtractionConfig()`：

```ts
private pickPreferredExtractionConfig<T extends { promptType: string }>(
  configs: T[]
): T | null {
  if (configs.length === 0) return null;
  return configs.find((c) => c.promptType === 'STAGE_3_FIELD_EXTRACTION') ?? configs[0];
}
```

→ 明確優先 `STAGE_3_FIELD_EXTRACTION`（V3.1 專用、帶 HKD 規則）；同型多筆時以 `updatedAt desc` 決定性 tie-break。隨映像部署後根治。

### 修正 2（即時 — 資料層，gated 腳本）：停用多餘 GLOBAL FIELD_EXTRACTION

`prisma/apply-fix111-deactivate-field-extraction.js`，由 `RUN_FIX111_DEACTIVATE_FIELD_EXTRACTION=true` 觸發（串入 `scripts/docker-entrypoint.sh`）：把 GLOBAL `FIELD_EXTRACTION` 設 `is_active=false`，讓 Stage 3 GLOBAL 選型只剩帶 HKD 規則的 `STAGE_3_FIELD_EXTRACTION`。**在映像重建前**即恢復 HKD 生效。

- **冪等**：只動仍 active 者；已停用則 0 筆。
- **安全閘**：僅當 GLOBAL 仍有 active `STAGE_3_FIELD_EXTRACTION` 時才停用，否則中止（避免 Stage 3 GLOBAL 無提取 prompt）。
- **legacy 路徑安全性**：`gpt-vision.getPromptForType(FIELD_EXTRACTION)`、`config-fetching.step` 在 DB 無此 config 時 fallback 到 `static-prompts.ts` 的 `FIELD_EXTRACTION`，內容與現行 DB 版（FIX-095 模板）**逐字相同** → 行為中性。

## 驗收

| # | 項目 | 標準 | 狀態 |
|---|------|------|------|
| 1 | 程式碼決定性選型 | GLOBAL 兩型並存時穩定選 STAGE_3_FIELD_EXTRACTION | ✅ 已改 |
| 2 | type-check | `npm run type-check` 通過 | ⏳ 見本次執行 |
| 3 | lint | `npm run lint` 無新增 warning | ⏳ 見本次執行 |
| 4 | 即時腳本冪等 + 安全閘 | `node --check` 通過；重跑 0 筆；無 STAGE_3 時中止 | ✅ 語法通過 |
| 5 | Azure 即時修正 | 套 `RUN_FIX111_DEACTIVATE_FIELD_EXTRACTION` 後 FIELD_EXTRACTION 停用 | ✅ 2026-07-16 經 Kudu 套用；讀回 activeStage3=1 / activeFieldExtraction=0（VERIFY_PASS） |
| 6 | UI 驗證 | 重新處理 `CEVA_RCIM250325_17865` → 費用取 HKD 欄 | ⏳ 待使用者 UI 驗證 |

## 待辦

1. ~~**Azure 即時修正**~~：✅ 已於 2026-07-16 經 Kudu 套用（GLOBAL FIELD_EXTRACTION → is_active=false，STAGE_3 保留 active）。
2. **部署程式碼修正**：下次映像重建帶入 `pickPreferredExtractionConfig`（根治，避免未來再有兩型 active 時復發）。
3. **UI 驗證**：重新處理 CEVA 文件，確認費用金額取 in-HKD 欄。
4. **關聯**：問題 2（CEVA 公司重複識別）另由 [[FIX-105]]（Azure 同步）+ [[CHANGE-103]]（配對根治）處理；本 FIX 只解「HKD 指示被旁路」。
