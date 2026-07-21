# CHANGE-106: Template Instance 快照過期無提示，使用者誤判「修改沒生效」

> **建立日期**: 2026-07-22
> **提出背景**: Azure DEV 測試期間，使用者反覆調整 mapping 設定並重新處理文件，但畫面上看到的仍是舊快照
> **影響頁面/功能**: Template Instance 列表與明細
> **優先級**: 中（不影響資料正確性，但嚴重影響除錯效率與對系統的信任）
> **狀態**: 📋 規劃中

---

## 背景與問題

Template Instance 產生時會把當下的欄位值寫入 `template_instance_rows.field_values`，此後**不會**因為下列事件而更新：

- 來源文件被重新處理（提取結果改變）
- Template Field Mapping 的規則或公式被修改
- Field Definition Set 被調整

介面上沒有任何標示指出「這一列的來源已經變了」。使用者調完設定後回頭看舊 instance，看到數字沒變，合理地推論「我的修改沒生效」，於是繼續調整 —— 而問題可能早就修好了。

這在本次測試中造成實際誤判。

---

## 實測證據（Azure DEV，2026-07-22）

`CEVA_RCIM250325_17865.PDF`：

| 來源 | 內容 |
|---|---|
| 目前的 `stage_3_result.lineItems` | `BASIC FREIGHT CHARGE` 1330.32、`DESTINATION THC` 712.71、`DELIVERY ORDER FEE` 628.71、`OTHER DESTINATION CHARGE` 201.34（合計 2873.08 = 發票 subtotal ✓） |
| 最新的 template instance（2026-07-14 07:36） | `freight=170`、`thc=2885`、`docs_fee=2545`、`others_local_charge=815` |

instance 的數字在目前的提取結果中**完全不存在** —— 文件於 2026-07-21 被重新處理過，instance 停留在 7 天前的快照。

同一批資料中另有正面對照：`CEVA_RCIM250004_05808.pdf` 的 instance 歷史清楚顯示修正生效的時間點：

```
7/8 – 7/14 07:36   thc=13080   freight=2490      ← 取到發票的「原幣金額」欄
7/14 08:19         thc=3075.64 freight=19508.31  ← 取到「HKD 金額」欄 ✓
```

若當時介面能標示「此 instance 的來源已更新」，使用者就不需要靠比對數字來判斷哪一版才是最新的。

---

## 需求描述

讓使用者能一眼看出某個 template instance（或其中某幾列）是否已經過期，並能便捷地重跑。

### 建議行為

1. Instance 列表／明細顯示「來源已更新」標記 —— 判斷依據為：任一來源文件的 `updated_at`（或 `processing_ended_at`）晚於該 row 的 `updated_at`
2. 標記可下鑽，顯示是哪幾份文件、更新於何時
3. 提供「重新產生」入口
4. （選用）mapping 設定被修改時，一併視為過期依據

---

## 方案選項

| 選項 | 方案 | 優點 | 代價 |
|------|------|------|------|
| **A** | **唯讀標記**：僅比對時間戳並顯示標記，不提供任何自動化 | 實作最輕；零風險（不動任何資料） | 使用者仍需手動重跑 |
| **B** | **標記 + 一鍵重跑**：A 之外提供「重新產生此 instance」按鈕 | 解決完整的使用流程 | 需釐清重跑時人工修正過的值如何處理（覆蓋？保留？提示？） |
| **C** | **自動重跑**：偵測到來源更新即自動重新產生 | 使用者永遠看到最新值 | ❌ **不建議** —— 會靜默覆蓋人工修正；且大量文件重處理時會觸發大批重算 |
| **D** | **不做標記，改為即時計算**：instance 不存快照，每次開啟都即時算 | 永遠最新 | ❌ 架構變更（H1）；且失去「當時送出的數字」這個稽核價值 |

### 建議

**A 先做，B 視情況跟進**。理由：
- A 能解決 90% 的誤判（使用者只要知道「這是舊的」就會自己重跑）
- B 的價值在便利性，但**必須先回答「人工修正過的值怎麼辦」**。目前 `template_instance_rows` 有 `status` 與 `validation_errors`，是否有人工編輯的痕跡需要先確認
- C 明確排除：靜默覆蓋人工修正是不可接受的副作用
- D 明確排除：屬架構變更，且快照本身有稽核價值（記錄「當時送出什麼」）

---

## 驗收標準

- [ ] `CEVA_RCIM250325_17865.PDF` 的 instance 顯示「來源已更新」標記
- [ ] 標記可指出來源文件的更新時間（2026-07-21）晚於 row 的更新時間（2026-07-14）
- [ ] 來源未更新的 instance **不顯示**標記（避免噪音）
- [ ] 若採方案 B：重跑前明確告知將覆蓋哪些值
- [ ] UI 字串三語言同步（`messages/{en,zh-TW,zh-CN}`）+ `npm run i18n:check` 通過
- [ ] `npm run type-check` / `npm run lint` 通過

---

## 相關文件

- [FIX-130](../bug-fixes/FIX-130-existing-config-correction-checklist.md) —— 項目 6：需重跑的既有 instance
- [CHANGE-091] —— Template Instance 流程 UX 與非同步進度（Phase 2 待實作，可評估併入）
- [CHANGE-037] —— Data Template 流程完成
