# FIX-130: Azure DEV 存量設定修正清單（aliases 補齊 / 公式修正 / 公司歸屬）

> **建立日期**: 2026-07-22
> **發現方式**: 使用者 Azure DEV 測試回報的根因追查（FIX-126 ~ FIX-129）
> **影響頁面/功能**: Field Definition Set、Template Field Mapping、公司管理（**純資料，不改代碼**）
> **優先級**: 高（代碼修好後仍需這批修正才能真正解決使用者回報的問題）
> **狀態**: 📋 規劃中

---

## 問題描述

FIX-126 ~ FIX-129 處理的是**機制**；本文件處理的是**現存資料**。即使機制全部修好，以下存量問題仍會讓使用者看到錯誤結果：

- 三家公司的費用欄位 **aliases 全部為空**，確定性回填只能靠 label 硬碰
- 多條 mapping 公式引用了**不存在的 key**（永遠取不到值）
- 多條 mapping 公式含**重複來源項**（同一筆錢被加兩次）
- 設定掛在**沒有文件的公司**或**已合併的公司**底下
- 部分 template instance 是**過期快照**，需重跑才會反映修正

**交付方式（依使用者 2026-07-22 決定）**：同時提供「後台操作清單」與「gated 一次性腳本」。清單供逐筆確認與小量修正，腳本供大批量套用（預設 dry-run）。

---

## 修正項目

### 1. aliases 補齊（影響最廣）

| 欄位定義集 | 公司 | 費用欄位數 | 已設 aliases |
|---|---|---:|---:|
| Toll Global Forwarder Limited - 自訂費用欄位集 | Toll Global Forwarder Limited | 37 | **0** |
| SBS INTERNATIONAL LOGISTICS - 自訂費用欄位集 | RICOH INTERNATIONAL LOGISTICS (HK) LTD. | 47 | **0** |
| SBS - 自訂費用欄位集 | SBS | 34 | **0** |
| Nippon Express Logistics - 自訂費用欄位集 | Nippon Express Logistics | 21 | 1 |
| Nippon Express Logistics (HK) - 自訂費用欄位集 | Nippon Express (HK) Co., Ltd. | 15 | **6** ✅ |

**Nippon Express (HK) 是正面範例**，證明 aliases 機制有效：

```
nehk_bl_fee | "NEHK B/L fee"  aliases=["NEHK B/L FEE","NEHK B/L FEE - FCL","NEHK BL FEE"]
thc         | "THC"           aliases=["T.H.C","THC","TERMINAL HANDLING CHARGE"]
```

實測 `NEX_RCIM250020_8925.pdf`：兩行 `T.H.C.`（1500 + 7200）正確加總為 `thc = 8700`，`source=lineItem-backfill`。

**待補的高優先 aliases**（依真實文件原文）：

| 公司 | 欄位 key | 建議加入的 alias（文件實際寫法） |
|---|---|---|
| Toll | `terminal_handling_charge_origin` | `Terminal Handling Charges - Origin` |
| Toll | `terminal_handling_charge_destination` | `Terminal Handling Charges - Destination` |
| Toll | `documentation_fee_origin` | *(需確認是否該新增 `Documentation Fee - Destination` 欄位，見項目 5)* |
| SBS INTERNATIONAL | `air_delivery_order_dest` | `(AIR) DELIVERY ORDER CHARGE DEST CHARGE`、`(AIR) DELIVERY ORDER CHARGE` |
| SBS INTERNATIONAL | `sea_thc` | `(SEA) THC (DEST)` |
| SBS INTERNATIONAL | `air_pick_up_charge_origin` | `(AIR) PICK UP CHARGE ORIGIN CHARGE` |

> ⚠️ 這批 alias 需與 [FIX-126](FIX-126-charge-label-matching-fragility.md) 的方案協調：若採方案 A（單複數正規化），Toll 的兩條 THC alias 就不必手動加。**建議先定 FIX-126 方案，再決定這裡補多少**，避免做白工。

### 2. 公式引用不存在的 key（永遠取不到值）

**SBS INTERNATIONAL LOGISTICS — Inbound**

| 公式中的 key | 實際 key | 受影響的目標欄位 |
|---|---|---|
| `air_delivery_order_dest_charge` | `air_delivery_order_dest` | `docs_fee` |
| `air_delivery_order_charge` | `air_delivery_order_dest` | `docs_fee` |
| `air_delivery_charge_dest_charge` | `air_delivery_charge_dest` | `delivery` |
| `air_pick_up_charge_original_charge` | `air_pick_up_charge_origin` | `pick_up_fee_at_origin` |
| `air_cfs_charge_dest_charge` | `air_cfs_charge_dest` | `cfs` |
| `air_gate_charge_dest_charge` | `air_gate_charge_dest` | `gate_charge` |
| `air_airline_document_charge_dest_charge` | `air_airline_document_charge_dest` | `docs_fee` |
| `sea_document_b_l` | `sea_document_bl` | `docs_fee` |

**Toll Global Forwarder — Inbound**

```
terminal_fees_at_origin ← terminal_handling_charges_origin   [DIRECT]
                          ↑ 複數，實際 key 為 terminal_handling_charge_origin
```

> 完整掃描應以 [FIX-128](FIX-128-mapping-source-field-validation.md) 的驗收項（對 30 組 mapping 全面掃描）產出的清單為準，上表僅為已查證的部分。

### 3. 公式重複來源（同一筆錢加兩次）

| mapping | 目標欄位 | 現行公式 | 問題 |
|---|---|---|---|
| SBS INTERNATIONAL — Inbound | `thc` | `{sea_thc_hongkong_asia}+{thc}+{sea_thc}` | GPT 填 `thc`、回填填 `sea_thc`，同一筆 325.42 被加兩次 → 650.84 |
| Toll — Inbound | `docs_fee` | `{document_fee_destination} + {delivery_order_fee_destination}` | GPT 誤填 `document_fee_destination`、回填填 `delivery_order_fee_destination`，同一筆 50.82 被加兩次 → 101.64 |
| Toll — Outbound | `thc` | `{terminal_handling_charge_origin} + {terminal_handling_charges_origin} + {terminal_handling_charge} + {terminal_handling_charge_destination}` | 4 項中 2 項 key 不存在；`_destination` 出現在 Outbound 公式中語意可疑 |

> ⚠️ **處理順序很重要**：公式去重必須與 [FIX-127](FIX-127-stage3-misattribution-and-dual-source.md) 一併完成。若只刪公式的重複項而沒修 Stage 3，某些文件會從「翻倍」變成「漏算」（原本靠第二項才取到值的情況）。

### 4. 公司歸屬修正

| 公司 | 文件數 | 欄位集 | mapping | 狀態 | 問題 |
|---|---:|---:|---:|---|---|
| Nippon Express Logistics | 53 | 1 | 2 | ACTIVE | 三筆 Nippon 並存，各有各的設定 |
| Nippon Express (HK) Co., Ltd. | 16 | 1 | 1 | ACTIVE | 同上 |
| NIPPON EXPRESS (HK) CO., LTD.（NIPPON EXPRESS） | 1 | 1 | 1 | ACTIVE | 同上，僅 1 份文件 |
| SBS | **0** | 1 | 2 | ACTIVE | 設定掛在**沒有文件**的公司上，永遠不會被使用 |
| RICOH INTERNATIONAL LOGISTICS (HK) LTD. | 43 | 1 | 2 | ACTIVE | 真正有文件的是這筆 |
| CEVA LOGISTICS (HONG KONG) LIMITED（CEVA Logistics） | 0 | 1 | 4 | **MERGED** | 孤兒設定（見 [FIX-129](FIX-129-merge-skipped-config-no-resolution-path.md)） |

**需使用者決策**：
- Nippon 三筆是否合併？合併到哪一筆？（設定會撞鍵，需逐筆決定保留哪一份）
- `SBS` 那 2 組 mapping 是要轉移到 `RICOH INTERNATIONAL LOGISTICS (HK) LTD.`，還是捨棄？
- CEVA MERGED 公司的 4 組 mapping 與存活公司的 4 組是否重複？

### 5. 缺少的欄位定義

Toll 的定義中有 `Documentation Fee - Origin`，但**沒有** `Documentation Fee - Destination`；同時另有一組 `Document Fee - Origin` / `Document Fee - Destination`。文件實際出現的是 `Documentation Fee - Destination`。

需使用者確認：`Document Fee` 與 `Documentation Fee` 在業務上是**同一種費用**還是兩種？
- 若同一種 → 應合併定義，避免 GPT 與回填在兩組之間搖擺
- 若兩種 → 需補上 `Documentation Fee - Destination`

### 6. 過期的 template instance

`CEVA_RCIM250325_17865.PDF` 的最新 instance（2026-07-14 07:36）顯示 `thc=2885, freight=170, docs_fee=2545, others_local_charge=815`，但目前的提取結果是 `712.71 / 1330.32 / 628.71 / 201.34`。**文件在 7/21 被重新處理過，instance 沒有跟著重跑。**

需重跑該 instance。此現象的機制面處理見 [CHANGE-106](../feature-changes/CHANGE-106-template-instance-staleness-indicator.md)。

---

## 交付方式

### （a）後台操作清單

上述各節即為清單本體。執行時逐筆確認、逐筆勾記。適用於需要業務判斷的項目（項目 4、5）。

### （b）gated 一次性腳本

比照既有做法（`prisma/*.js` + `docker-entrypoint.sh` gated flag，見 runbook §15）：

- 檔名建議：`prisma/apply-config-corrections.js`
- 開關：`RUN_CONFIG_CORRECTIONS`，預設 `false`
- **預設 dry-run**：需另一個明確旗標才實際寫入
- 涵蓋範圍：項目 1（aliases）、2（key 修正）、3（公式去重）—— 即**規則明確、不需業務判斷**的部分
- **不涵蓋**：項目 4、5（需使用者逐案決定）
- 每一筆變更前後值都要寫入 log，供事後核對

> ⚠️ 腳本不得使用 `.ts`／`tsx` —— runner 映像不含它們（見 memory `feedback_azure_runner_excludes_scripts_tsx`）。

---

## 驗收標準

- [ ] FIX-126 方案定案後，重新確認 aliases 補齊清單（避免與代碼修正重工）
- [ ] FIX-128 的全面掃描完成，取得完整的「不存在 key」清單
- [ ] 腳本 dry-run 輸出經人工核對後才實際執行
- [ ] 使用者回報的 17 份文件重跑處理 + 重跑 template instance 後：
  - [ ] `RIL_RCIM250015_14409` 的 `thc` = 325.42（不再翻倍）
  - [ ] `TOLL_RCIM240349_58326` 的 `docs_fee` 不再包含不存在的 document fee
  - [ ] `RIL_RCIM250313_22084` 的 `delivery` / `pick_up_fee_at_origin` 有值
  - [ ] `TOLL_RHIM260048_79294` / `TOLL_RHIM260100_81794` 的 `thc` 有值
  - [ ] `CEVA_RCIM250325_17865` 的 instance 反映最新提取結果
- [ ] 項目 4、5 的決策經使用者確認並記錄於本文件

---

## 相關文件

- [FIX-126](FIX-126-charge-label-matching-fragility.md) —— 決定 aliases 要補多少
- [FIX-127](FIX-127-stage3-misattribution-and-dual-source.md) —— 必須與公式去重一併完成
- [FIX-128](FIX-128-mapping-source-field-validation.md) —— 提供完整的錯誤 key 清單
- [FIX-129](FIX-129-merge-skipped-config-no-resolution-path.md) —— CEVA 孤兒設定
- [CHANGE-106](../feature-changes/CHANGE-106-template-instance-staleness-indicator.md) —— 過期 instance 的機制面處理
