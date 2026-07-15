# FIX-110: 費用 field definition 確定性回填命中率盤查 — 針對性補 aliases（非全面盤點）

> **建立日期**: 2026-07-15
> **發現方式**: 用戶提問「設定 field definition 之後,Stage 3 是不是就會把費用 line item 識別並回填?為什麼取到的數據正確、處理時卻計錯數/匹配錯名?」→ 追 Stage 3 回填機制 → 對 Azure DEV 實際資料做命中率盤查
> **影響頁面\功能**: Stage 3 費用回填（`fieldType === 'lineItem'` 欄位）→ 下游 Template Instance / 匯出 / 報表
> **優先級**: 中（不影響已穩定的 68% 費用行;針對脆弱/未覆蓋部分的資料品質改善）
> **狀態**: ✅ 已完成（9 條 aliases 已於 2026-07-15 冪等寫入 Azure DEV 並回讀驗證;可重現腳本 `prisma/apply-fix110-aliases.js` 已提交）。⏳ **既有文件需重新處理才會生效**（alias 只影響新處理);根因 1（CEVA 公司合併）交 CHANGE-103、根因 2（description 正規化）待另立
> **最後更新**: 2026-07-15
> **關聯**: FIX-108（確定性回填 3 修正,本 FIX 是其資料側後續）、CHANGE-094（回填機制原始）、CHANGE-103（CEVA 公司合併 = 本 FIX 的槓桿 1,見 §5）

---

## 1. 起點:對「field definition → Stage 3」的常見誤解

用戶原本的心智模型:「設定了 field definition,AI Stage 3 就會把指定的 line item prompt 內容加進去,AI 就會識別並回傳匹配的 line item 與金額。」

**這只對一半。** Stage 3 其實有**兩道機制**,而「計錯數/匹配錯名」發生在第二道:

| | 機制一:進 GPT prompt | 機制二:程式確定性回填 |
|---|---|---|
| 做什麼 | `buildFieldDefinitionsSection`（FIX-043）把 field def 的 label/key/aliases/hints 組成一段追加進 Stage 3 system prompt,要求 GPT 把費用填進 `fields` | GPT 回傳後,`backfillLineItemCharges`（CHANGE-094 → FIX-108）拿原始 `lineItems` **重新推導**費用欄位值,覆蓋 GPT 填的 |
| 為何存在 | 你以為的那道 | 只靠 GPT 不穩定:同文件跑 3 次 THC 得 3700/2200/2400（心算錯 + fields vs lineItems 判斷不穩） |
| `aliases` 參與? | ✅ | ✅（比對 description 用的正是 `label` + `aliases`,見 `resolveUniqueChargeKey`） |
| `extractionHints` 參與? | ✅ | ❌（回填**完全不看** hints） |

> **關鍵**:要治「不穩定」靠的是機制二穩定命中,而機制二只吃 **aliases**;hints 只幫到那道不穩定的 GPT 層。

### 「數據正確、處理卻出錯」的精確定位

GPT 抽出的原始 `lineItems`（description + amount）通常是對的,但把 line item「歸戶」到 field def key 的那一步（機制二的加總 + 名稱比對）出錯:

- **計錯數**:CHANGE-094 原為「GPT 已填值優先」→ GPT 的錯誤加總無法被更正。FIX-108 改為一律以程式加總為準。
- **匹配錯名**:回填原用 `classifiedAs`（GPT **改寫過**的分類名,會失真,如 `CONTAINER SEAL FEE - FCL` → `Seal Charge`）比對。FIX-108 改為優先用原始 `description`,`classifiedAs` 只當退路。

---

## 2. 盤查:機制二目前的真實命中率（Azure DEV,唯讀）

用線上實際比對邏輯（逐字複製 `canonicalizeLabel` / `matchLabel` / `resolveUniqueChargeKey`）跑 267 份已處理文件的費用行,分三類:

- **穩定**:`description` 直接唯一命中 field def
- **脆弱**:`description` 對不上,只靠 GPT 的 `classifiedAs` 命中 → 補一條 alias 即可轉穩定
- **未覆蓋**:兩者皆不中 → 該費用完全不走確定性回填

| 指標 | 數字 |
|---|---|
| 費用行穩定命中 | 743（**68%**） |
| 脆弱 | 179 |
| 未覆蓋 | 168 |
| 費用欄位定義總數 | 211,其中 **204 無 aliases（97%）** |
| 有處理量的公司 | 12（另 20 個 COMPANY def set,0 個 GLOBAL） |

### 反直覺發現:aliases 空 ≠ 壞掉

204/211 欄位沒 aliases,但整體穩定率仍有 68% —— 因為許多公司的原始 `description` 本來就跟 `label` 對得上。**這直接推翻「全部 field definition 都要補 aliases」的前提。**

---

## 3. 為什麼「全面盤點補 aliases」是錯的方向

盤查把表面上的「缺 aliases」拆成**三個不同根因**,而且高度集中在 CEVA:

| 公司 | 文件 | 穩定 | 脆弱 | 未覆蓋 |
|---|---|---|---|---|
| **CEVA Logistics** | 137 | 258 | 148 | 123 |
| CEVA (HONG KONG) LIMITED | 50 | 168 | 13 | 5 |
| Nippon Express Logistics | 53 | 230 | 13 | 1 |
| Nippon Express (HK) | 15 | 75 | 0 | 0 |
| 其餘 8 間（多為 1-3 份,多為 CEVA/RICON 重複公司） | — | 少 | 少 | 大量 |

**三個根因,三種不同修法:**

1. **公司重複（最大槓桿,→ CHANGE-103）**:6 間幽靈 CEVA/RICON 公司**完全沒有 field def set**（`CEVA Logistics Hong Kong Limited`、`CEVA Logistics (RICHASIA)...`、`CEVA LOGISTICS (香港) KONG LITTD`、`RICON ASIA PACIFIC...`、`RICHON ASIA PACIFIC...`、`RICON...（CEVA LOGISTICS）`），費用 100% 未覆蓋。連兩個「正主」CEVA 也彼此分裂。修法是**合併公司**,不是加 alias。CEVA 佔全部文件量 72%。
2. **description 內嵌金額（→ 未來的 description 正規化）**:CEVA 大宗脆弱/未覆蓋的 description 帶 per-invoice 金額匯率,如 `Delivery Order Fee THB 2,545.00 @ 0.244135`。每筆金額不同 → **無法當 alias**,要在比對前剝掉 `THB x @ y` 尾巴。
3. **乾淨但對不上 label（← 本 FIX 處理）**:少數 description 是乾淨 label 文字、只是跟現有 label 用字不同（如 `Terminal Handling Charge at Origin` vs label `Origin THC - Terminal Handling Charge`）。**這才是 aliases 該解的**。

---

## 4. 本 FIX 的產出:9 條可直接套用的 aliases

篩選條件:**只收乾淨 description**（不含任何數字 → 排除內嵌金額/數量/貨櫃規格）+ **每條通過碰撞檢查**（模擬加入 alias 後,該 description 仍唯一解到目標 key,不會製造歧義使回填跳過）。

| # | 公司 | field def key | 現有 label | 要補的 alias | 影響行數 |
|---|------|--------------|-----------|-------------|:---:|
| 1 | CEVA Logistics | `origin_thc_terminal_handling_charge` | Origin THC - Terminal Handling Charge | `Terminal Handling Charge at Origin` | 27 |
| 2 | CEVA Logistics | `solas_vgm_management_fee` | Solas VGM Management Fee | `Vgm Certificate Fee` | 17 |
| 3 | Nippon Express Logistics | `other_charges` | Other Charge | `OTHER CHARGES` | 13 |
| 4 | CEVA Logistics | `destination_document_processing_fee` | Destination Document Processing Fee | `Documentation at Destination` | 4 |
| 5 | CEVA Logistics | `destination_handling` | Destination Handling | `Handling & Processing at Destination` | 4 |
| 6 | CEVA Logistics | `destination_thc_terminal_handling_charge` | Destination THC - Terminal Handling Charge | `Terminal Handling Charge at Destination` | 2 |
| 7 | Fairate Express | `airline_document_charge` | Airline document charge | `AIRLINE DOCUMENTATION CHARGE` | 2 |
| 8 | Fairate Express | `container_field_station_charge` | container field station charge | `CONTAINER FIELD STATION CHARGES` | 2 |
| 9 | Nippon Express (HK)…（NIPPON） | `container_seal_fee` | Container seal fee | `CONTAINER SEAL FEE - FCL` | 1 |

合計把 **~72 筆費用行**從「靠 GPT 的脆弱路徑」轉為確定性穩定;皆為穩定 label 文字（非一次性）。

---

## 5. 判斷紀錄:為什麼是這 9 條、為什麼不全面補

| 決策 | 理由 |
|------|------|
| **不做全面盤點** | 68% 費用行已穩定,補 aliases 對它們無幫助;204 個空 aliases 欄位大多屬於本來就命中的公司 |
| **只收乾淨 description** | CEVA 大宗 description 內嵌金額匯率,每筆唯一 → 當 alias 無效,屬 description 正規化問題（根因 2） |
| **每條做碰撞檢查** | aliases 太多會製造歧義:同一 description 命中 ≥2 個 key → `resolveUniqueChargeKey` 判歧義回 null → 反而不填。故「準,不要多」 |
| **候選 alias 來自真實 description** | 不憑空猜;目標 key 由該行的 `classifiedAs` 唯一解出（高信心） |
| **CEVA 5 條標時序警告** | CEVA 正走公司合併（CHANGE-103）。現在加到「CEVA Logistics」set,合併後 canonical set 若換,恐需重做 → 建議 CEVA 合併定案後再套用 canonical set |

### 套用優先序

- **可立即套用（無 CEVA 合併顧慮）**:#3、7、8、9（Nippon / Fairate）
- **待 CEVA 合併定案後套用**:#1、2、4、5、6（CEVA Logistics）

---

## 6. 本 FIX **不**解決的（交棒）

| 項目 | 交給 |
|------|------|
| CEVA/RICON 6 間重複公司合併 + field def set 統一（根因 1,最大槓桿） | **CHANGE-103**（本 FIX 的盤查作為其輸入:哪些實體、各自文件數、費用未覆蓋現況） |
| CEVA description 內嵌金額 → 比對前正規化剝除 `THB x @ y`（根因 2） | 待評估另立 FIX/CHANGE（碰 `backfillLineItemCharges` 前處理,需設計） |
| aliases 自動學習（從人工確認的提取結果學 alias,取代手動維護） | 長遠方向,碰 H1,暫不啟動 |

---

## 7. 套用（✅ 已執行,2026-07-15）

這些 field def entry 原本連 `aliases` key 都沒有;套用 = 在 `field_definition_sets.fields` JSON 對應 entry 加 `"aliases": [...]`。加後**機制一機制二皆受惠**。

**執行方式**:先 dry-run（確認 4 間公司各精確匹配 1 個 active COMPANY set、無誤配、無歧義、9 條全為新增）→ 冪等寫入 → 回讀驗證（9 條全 ✅ 存在）。寫入 4 個 set:

| set id | 公司 | 寫入 alias 數 |
|---|---|---|
| `f13aaf3b-ec74-4750-8036-a27dbb554792` | CEVA Logistics | 5 |
| `7a124db2-e84f-4d19-8b74-12ca081c098d` | Nippon Express Logistics | 1 |
| `754d113d-ece4-4ec0-8a2f-8ee0f46ad860` | Fairate Express | 2 |
| `60f729de-701e-4748-af76-814c61a03499` | NIPPON EXPRESS (HK) CO., LTD.（NIPPON EXPRESS） | 1 |

**可重現腳本**:`prisma/apply-fix110-aliases.js`（gated by `RUN_FIX110_ALIAS_BACKFILL=true`,冪等,參數化,公司以「精確名 → 恰好 1 個 active set」解析,防誤寫重複公司）。FieldDefinitionSet 來自本地同步匯入,DEV 若被 reset/re-import 會遺失本次直接寫入的 aliases → 屆時用此旗標冪等重跑補回。

> ⏳ **生效範圍**:alias 只影響**新處理**的文件。既有 267 份的 ~72 筆脆弱費用行,需**重新處理對應文件**才會從「靠 GPT」轉為確定性穩定（同 FIX-108 的驗收邏輯）。
>
> ⚠️ **CEVA 5 條的時序備註**:CEVA 正走公司合併（CHANGE-103）。若合併後 canonical set 換成另一個 company 的 set,這 5 條需以 `apply-fix110-aliases.js` 重跑補到新 canonical set。

---

## 8. 資料來源與可信度

- §2/§3/§4 全部取自 2026-07-15 經 Kudu 在 Azure DEV 容器內執行的純 `SELECT`（`field_definition_sets` + `extraction_results` + `documents`）,無任何寫入。
- 比對邏輯逐字複製 `src/services/extraction-v3/utils/classify-normalizer.ts`（`canonicalizeLabel` / `matchLabel`）與 `stage-3-extraction.service.ts`（`resolveUniqueChargeKey`）。
- 「乾淨 description」定義:不含任何數字字元。
- 碰撞檢查:模擬把 alias 加入目標 key 後,重跑 `resolveUniqueChargeKey`,確認回傳目標 key（9 條全 `safe: true`）。
- §7 套用:2026-07-15 經 Kudu sidecar 以參數化 `UPDATE ... SET fields = $1::jsonb` 冪等寫入（先 dry-run 後 apply,寫後回讀驗證 9 條全存在）;等效邏輯固化於 `prisma/apply-fix110-aliases.js`。

---

*文件建立日期: 2026-07-15*
*最後更新: 2026-07-15（9 條 aliases 已套用 + 回讀驗證;可重現腳本已提交;既有文件待重處理生效）*
