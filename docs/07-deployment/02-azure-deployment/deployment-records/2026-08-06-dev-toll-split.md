# 2026-08-06 Azure DEV 部署 — FIX-159 移植：拆分 Toll 泰國 / 香港實體

> **環境**: Azure DEV（App Service for Containers）
> **映像**: `acrscmdocprocessingdev.azurecr.io/ai-document-extraction:dev-tollsplit-20260806`
> **ACR run**: `ck1w` → `Succeeded`
> **前一個映像**: `dev-diag20260806-20260806`
> **旗標**: `RUN_TOLL_SPLIT_20260806`（三模式，依序跑 `inspect` → `dryrun` → `write`，完成後已清空）
> **寫入**: 🔴 **有** —— `companies` +1、`companies.name_variants` ×1、`documents.company_id` ×35、`extraction_results.company_id` ×35

---

## 背景

[2026-08-06 診斷](2026-08-06-dev-diagnose.md) 查證出 Azure DEV 確實有 FIX-159 型跨國實體誤歸：
`Toll Global Forwarder Limited` 底下 86 份文件中 **35 份是香港發票**，且該記錄 `nameVariants` 為 **0 項**。

本次移植 FIX-159 選定的**方案 B：資料層拆分** —— 不動 `normalizeCompanyName`
（改它會波及 CEVA / DHL 的正常歸併），改為兩個實體各自寫精確 `nameVariants`，
在 `resolveCompanyId` 的 **Step 2a（精確比對，早於 2b 的正規化相等）**完成分流。

---

## 🔴 兩處不能照抄本機

### 一、variants 清單以目標環境實測為準

Azure 有兩種**本機從未出現**的中英混排印法（共 6 份）：

```
Toll Global Forwarding (Hong Kong) Ltd 拓領環球貨運(香港)有限公司   （4 份）
Toll Global Forwarding (Hong Kong) Ltd 拓環球貨運(香港)有限公司     （2 份）
```

本機的四項香港 variants 涵蓋不到它們。若照抄本機清單，這 6 份仍會落到 Step 2b 繼續誤歸。
本次清單為 **6 項**（3 項實測 + 3 項依縮寫慣例推導）。

> 本機跑 `inspect` 時腳本正確辨識出本機缺這 2 項 —— 這也順帶驗證了清單差集邏輯。

### 二、必須同時補泰國側 variants

FIX-159 第一次 write 只建香港記錄，造成**泰國回歸**：既有記錄名是 `Forwar**der**`、
發票印的是 `Forwar**ding**`，正規化後不相等 —— 泰國文件本來就沒有 Step 2b 可走
（靠 Step 3 相似度勉強命中）；新香港記錄一出現，2b 恰好命中它，於是搶在 Step 3 之前截走泰國件。

Azure 的泰國記錄 `nameVariants` 是 **0 項**，風險完全相同。本次把兩側放在**同一個交易**內，
不會出現「只建了香港、還沒補泰國」的中間狀態。

---

## 三段式執行

腳本：`prisma/split-toll-hk-20260806.js`（放 `prisma/` —— runner 映像不含 `scripts/` 與 tsx）

### inspect

```
既有記錄  Toll Global Forwarder Limited
  id=8f933f53-fae5-4c52-944c-3eac699e4ac4  status=ACTIVE
  nameVariants (0)
香港記錄  （不存在，將建立）

可對帳提取結果  86
    51  TH記錄 ⟵ Toll Global Forwarding (Thailand) Limited
    29  TH記錄 ⟵ Toll Global Forwarding (Hong Kong) Ltd
     4  TH記錄 ⟵ ...(Hong Kong) Ltd 拓領環球貨運(香港)有限公司
     2  TH記錄 ⟵ ...(Hong Kong) Ltd 拓環球貨運(香港)有限公司
```

| 計畫項目 | 數量 |
|---|---:|
| 建立香港記錄 | 是 |
| 香港 variants 待補 | 6 |
| 泰國 variants 待補 | 2 |
| 重新歸屬 → 香港 | **35** |
| 重新歸屬 → 泰國 | 0 |
| 地區無法判定（跳過） | **0** |

> 35 這個數字是**獨立算出來的**：診斷腳本按 issuer 分組數出 29+4+2，拆分腳本用地區詞正則
> （`/hong\s*kong|\(HK\)|香港/` vs `/thailand|泰國/`）重新判定，兩者一致。
> 「地區無法判定 0」表示 86 份全部能明確歸類，無需人工介入。

### dryrun

印出完整前置快照。核對結果：

| 檢查 | 結果 |
|---|---|
| `willReassign` 筆數（以 `doc_id` 計） | 35 |
| 其中 `to = HK` | 35 |
| 其中 `to = TH` | 0 |
| 出現 `BEGIN` / `COMMIT` / 數量閘 | **無** —— 確認未進交易區 |

### write

```
[toll-split] 4  write（措施 2：單一交易）
   ✓ 新增香港公司：1 筆
   ✅ 已建立 Toll Global Forwarding (Hong Kong) Ltd → 6df1b84d-b527-4318-b8a7-152a0a64bf5e
   ✓ 補泰國 nameVariants（樂觀鎖）：1 筆
   ✓ documents 重新歸屬 → Toll Global Forwarding (Hong Kong) Ltd：35 筆
   ✓ extraction_results 重新歸屬 → Toll Global Forwarding (Hong Kong) Ltd：35 筆
✅ COMMIT —— 交易已提交
```

樂觀鎖比對 `updated_at = 2026-05-31T15:34:59.375Z` 通過 —— 讀取到寫入之間無第三方改動。

---

## 事後對帳（重新讀取資料，非複述計畫）

```
Toll Global Forwarder Limited
  nameVariants (2)
    - Toll Global Forwarding (Thailand) Limited
    - Toll Global Forwarding (Thailand) Ltd
  可對帳提取 51 筆／1 種原文
      51  Toll Global Forwarding (Thailand) Limited

Toll Global Forwarding (Hong Kong) Ltd
  nameVariants (6)
    - Toll Global Forwarding (Hong Kong) Ltd
    - Toll Global Forwarding (Hong Kong) Ltd 拓領環球貨運(香港)有限公司
    - Toll Global Forwarding (Hong Kong) Ltd 拓環球貨運(香港)有限公司
    - Toll Global Forwarding (Hong Kong) Limited
    - Toll Global Forwarding (HK) Ltd
    - Toll Global Forwarding (HK) Limited
  可對帳提取 35 筆／3 種原文
      29  Toll Global Forwarding (Hong Kong) Ltd
       4  Toll Global Forwarding (Hong Kong) Ltd 拓領環球貨運(香港)有限公司
       2  Toll Global Forwarding (Hong Kong) Ltd 拓環球貨運(香港)有限公司

殘餘待修正  0  ✅ 一對一
```

51 + 35 = 86，分母對得上；兩邊各自只有自己地區的原文，無交叉。

---

## 🔴 還原依據

**write 那一次容器 log 的 `--- SNAPSHOT BEGIN ---` 到 `--- SNAPSHOT END ---` 區段**，
含 35 筆的 `doc_id` / `ext_id` / `file_name` / `issuer` / `from_company_id`，
以及兩筆公司記錄的變更前完整值。

⚠️ **這是唯一依據**。`companies` / `documents` / `extraction_results` 這幾張表**沒有版本歷史、
沒有 audit log**，容器內也沒有可保留的檔案系統。Log Analytics 的 `AppServiceConsoleLogs`
保留期限到了就沒了 —— 需要長期保存的話必須另行匯出該段 log。

回滾方式（若需要）：
1. `documents` / `extraction_results` 的 `company_id` 依快照的 `from_company_id` 改回
2. 刪除公司 `6df1b84d-b527-4318-b8a7-152a0a64bf5e`
3. 泰國記錄的 `name_variants` 清回 `[]`

---

## 收尾

| 項目 | 狀態 |
|---|---|
| `RUN_TOLL_SPLIT_20260806` | 已 `delete`（§A.5：非布林設 `false` 不會關閉） |
| 非布林旗標 | 全部不存在 ✅ |
| 布林旗標 | 7 個全 `false` ✅ |
| 容器 | `✓ Ready in 1128ms`，正常服務 |

---

## ⚠️ 留下的缺口（拆分只是第一步）

新公司 `6df1b84d-b527-4318-b8a7-152a0a64bf5e` 目前**沒有欄位定義集、沒有 mapping**。

依 FIX-159 §拆分後的設定缺口，完整程序為：**拆 → 建欄位定義集 → 重新提取 → 建映射 → 重跑匹配**。
本次只完成第一步。後果：

- 既有 35 份的提取結果與模板列**不受影響**（值已寫入）
- 但**重新處理**香港件 → Stage 3 沒有費用科目可注入 prompt，費用會塌縮成單一項
- **重跑模板匹配** → `resolveMapping` 拿不到任何規則

補齊要寫 `template_field_mappings`，受 runbook §17 的通案限制擋著
（對帳工具 `check-orphan-charge-keys.js` / `snapshot-template-values.js` 尚未移植進 `prisma/`）。

本機那份 37 科目的欄位集與兩筆 mapping 可作範本，但同樣要**按 Azure 實測調整**，不可照抄。

---

## 相關

- [2026-08-06 診斷記錄](2026-08-06-dev-diagnose.md) —— 本次的起因與查證方法
- [FIX-159](../../../../claudedocs/4-changes/bug-fixes/FIX-159-toll-cross-border-entities-merged-by-normalization.md) —— §跨環境狀態已依本次結果更新
- [dev-deployment-runbook.md §19](../dev-deployment-runbook.md)
- `prisma/split-toll-hk-20260806.js` —— 本次執行的腳本（三模式 gated，冪等，可重跑驗證）
