# FIX-088: EN 介面顯示中文 — 全站硬編碼中文常量系統性盤點 ＋ i18n:check 治理擴充

> **建立日期**: 2026-06-20
> **發現方式**: 代碼審查（全站 grep CJK 掃描）
> **影響頁面/功能**: 全站多頁面（EN 介面）
> **優先級**: 中
> **狀態**: 🚧 待修復
>
> **性質說明**: 本 FIX 屬「先盤點再修」性質，根本原因與解決方案在盤點階段標為「待驗證盤點」，並列出已知優先清單。實際需修檔案以階段一盤點結果為準。

---

## 問題描述

EN（英文）介面下，部分頁面仍顯示中文文字。根因**並非** en JSON 缺 key 觸發 fallback，而是**組件直接 render 含中文的顯示用常量、未走 `useTranslations`**。

換言之，這些中文文字並未經過 i18n 系統，無論 en JSON 是否齊全都會直接顯示中文。

### 為何長期未被發現

`npm run i18n:check`（`scripts/check-i18n-completeness.ts`）目前**只檢查 `PROMPT_TYPES` 一個常量**，`*_FORM_LABELS` 等數十個顯示用常量完全不在覆蓋範圍。因此即使常量中文洩漏、即使組件直接 render 該常量，現有治理檢查也不會報錯。

### 重要校正（避免過度修改）

初掃列出約 30 個 type / 常量檔含中文，但經抽查，**多數 config 常量的中文 label 並未真正被 render**：

- 組件多已改用 `useTranslations`，僅取常量的 `variant` / `className` 等樣式欄位，或常量本身為 deprecated 殘留。
- 範例 1：`ForwarderTable.tsx` import `LEGACY_FORWARDER_STATUS_CONFIG`，但只取 `variant` / `className`，label 走 `t()`。
- 範例 2：`ForwarderActions.tsx` 未使用 `FORWARDER_ACTION_DIALOGS`，全走 `t('companies.*')`。

> 🔴 **核心判定原則**：真正使用者可見的洩漏點遠少於初掃結果。必須以「**組件是否真的 render 該常量的文字欄位**」逐一驗證，**不可僅憑常量含中文就判定需改，更不可全量改**。

---

## 重現步驟

1. 將介面語言切換為 EN（英文）。
2. 瀏覽各頁面（公司管理、Pipeline timeline、欄位顯示處等）。
3. 觀察現象：部分文字仍顯示中文（label / placeholder / description / step name 等）。
4. 於代碼端 grep 該文字，確認來源為直接 render 的中文常量，而非 i18n key。

---

## 根本原因

> **狀態：待驗證盤點**（實際洩漏點以階段一盤點結果為準）

初步判定：組件直接 render 含中文的顯示用常量（如 `*_FORM_LABELS`），未經 `useTranslations`。需逐一確認下表「被誰 render」欄位是否真的把常量文字渲染到畫面。

### 已知 / 高度可疑優先清單（依優先序，需逐一驗證 render 點）

| 優先 | 來源常量（file:line） | 被誰 render | 性質 |
|---|---|---|---|
| P0 已確認（由 FIX-087 處理） | `FORWARDER_FORM_LABELS` `src/types/forwarder.ts:794` | `ForwarderForm.tsx` | label / placeholder / description 全中文，EN key 已存在 |
| P1 待確認 | `COMPANY_FORM_LABELS` `src/types/company.ts:947` | 若有其他組件 import 則同樣洩漏 | 須 grep render 點 |
| P1 待確認 | `STEP_DISPLAY_NAMES_V3` / `STEP_DESCRIPTIONS_V3` `src/constants/processing-steps-v3.ts:~184` | Pipeline timeline 組件 | 有 `_V3_EN` 版本並存，須確認組件選對版本 |
| P2 待確認 | `src/types/invoice-fields.ts`（約 130 條欄位描述） | 欄位顯示處 | 業務核心、量大，須逐一確認是否 render |
| P3 多為樣式 | `*_STATUS_CONFIG` / `*_TABLE_COLUMNS` / `*_OPTIONS`（forwarder / company / escalation / backup / audit 等） | 多數只取樣式或已 `t()` 覆蓋 | 個別 grep 確認，**勿全量改** |

---

## 解決方案

> **狀態：待驗證盤點**（兩階段執行）

### 階段一：盤點

對每個可疑常量，grep 其被組件「**當文字 render**」之處，產出「**真正需改**」清單。

- 判定標準：組件是否取用該常量的文字欄位（label / placeholder / description / name 等）並直接渲染到畫面。
- 排除：只取 `variant` / `className` 等樣式欄位、未被 import、或已 `t()` 覆蓋的常量。
- 預估：真正需改組件約 **5-15 個**，而非初掃的 30 個。

### 階段二：修正

逐一將真正需改的 render 點改用 `t()`：

- 對應 namespace **缺 key 才補**（多數應已存在）。
- 需新增 key 時，同步更新 `messages/en/`、`messages/zh-TW/`、`messages/zh-CN/`（H5 約束）。
- 修正後執行 `npm run i18n:check`。

### 附帶治理（納入本 FIX）

擴充 `scripts/check-i18n-completeness.ts`，將覆蓋範圍從目前僅有的 `PROMPT_TYPES` 擴充到 `*_FORM_LABELS` 等顯示用常量，避免同類洩漏再次發生且長期無法被偵測。

---

## 修改的檔案

> **狀態：待盤點後填入實際清單**。下表為依優先清單預判之候選，最終以階段一盤點結果為準。

| 檔案 | 修改內容（候選） |
|------|----------|
| `scripts/check-i18n-completeness.ts` | 擴充覆蓋 `*_FORM_LABELS` 等顯示用常量（附帶治理，確定納入） |
| `src/types/company.ts` 之 render 組件（待確認） | 若 `COMPANY_FORM_LABELS` 真被 render → 改 `t()` |
| Pipeline timeline 組件（待確認） | 確認 `STEP_DISPLAY_NAMES_V3` / `STEP_DESCRIPTIONS_V3` 是否選對 `_V3_EN` 版本 |
| 欄位顯示組件（待確認） | `src/types/invoice-fields.ts` 描述若被 render → 改 `t()` |
| `messages/{en,zh-TW,zh-CN}/*.json`（視缺 key 而定） | 僅在對應 namespace 缺 key 時新增（H5 三語言同步） |

---

## Hard Constraint

- **H5（i18n）為核心約束**：新增 / 修改翻譯 key 必須同步 `messages/en/`、`messages/zh-TW/`、`messages/zh-CN/`，修正後執行 `npm run i18n:check`。
- **升級條件**：若盤點後確認真正需改 **>15 檔**或需新增大量 key，則在本文件註明「**升級為 CHANGE**」，並依 §H3（Task Scope）走升級流程。

---

## 與 FIX-087 的關係

FIX-087 已處理 P0 的 `ForwarderForm` / `FORWARDER_FORM_LABELS`（label / placeholder / description 全中文、EN key 已存在）。本 FIX 處理其餘系統性盤點（P1-P3）與 `check-i18n-completeness.ts` 治理擴充，避免同類洩漏再發生。

---

## 測試驗證

盤點與修正完成後需驗證：

- [ ] 階段一盤點清單產出，明確標記每個常量「真正需改 / 僅樣式 / 已 `t()` 覆蓋」
- [ ] 真正需改的 render 點全部改用 `t()`
- [ ] 切換 EN 介面，先前洩漏頁面不再顯示中文
- [ ] 新增 key（如有）三語言同步，`npm run i18n:check` 通過
- [ ] `check-i18n-completeness.ts` 已擴充覆蓋 `*_FORM_LABELS`，並能偵測同類洩漏
- [ ] `npm run type-check` + `npm run lint` 通過
- [ ] 若真正需改 >15 檔 → 已升級為 CHANGE 並註明

---

*文件建立日期: 2026-06-20*
*最後更新: 2026-06-20*
