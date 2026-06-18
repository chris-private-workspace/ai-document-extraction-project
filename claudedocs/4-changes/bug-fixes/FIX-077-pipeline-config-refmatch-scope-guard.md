# FIX-077: Pipeline Config 表單允許在 COMPANY/FORMAT scope 設定無效的 Reference Number Matching

> **建立日期**: 2026-06-18
> **發現方式**: 用戶回報 + 代碼審查（document 3a8cc323 / Fairate Express 調查）
> **影響頁面/功能**: `admin/pipeline-settings`（新增/編輯管線配置表單）
> **優先級**: 中
> **狀態**: ✅ 已修復（2026-06-18，靜態驗證通過；UI 端到端待 dev server 驗證）

---

## 問題描述

`PipelineConfigForm` 允許使用者在 **COMPANY / FORMAT scope** 設定 `Reference Number Matching`（`refMatchEnabled` 等），但這些設定對 ref match **完全無效**，且介面沒有任何提示，導致使用者誤以為已啟用。

**根本不對稱**（`extraction-v3.service.ts`）：

| 步驟 | 執行時機 | 解析 config 傳的參數 | 能讀的 scope |
|------|---------|---------------------|-------------|
| Reference Number Matching | 三階段提取**之前**（公司識別前） | `resolveEffectiveConfig({ regionId })` | 只有 GLOBAL / REGION |
| Exchange Rate Conversion | 三階段提取**之後** | `resolveEffectiveConfig({ regionId, companyId, formatId })` | GLOBAL / REGION / COMPANY / FORMAT |

ref match 在系統還沒識別公司之前就執行，結構上**只能讀 GLOBAL/REGION scope**。但同一個表單裡 FX 設定在 COMPANY/FORMAT 是生效的——兩個開關行為不一致，沒有任何提示，誤導使用者。

### 實證

文件 `3a8cc323`（Fairate Express，company `369c787f`）：使用者在 COMPANY scope 設 `refMatchEnabled=true`，但處理時 ref match 讀到 GLOBAL 的 `false` → step 為 `skipped:true`（前端顯示灰色 pending，非綠燈）。

> 注意：此 FIX 只做**前端防呆**，不改 pipeline 執行順序。ref match 作為「全域前置 gate」的設計維持不變（見對話結論：使用者要的是全域 gate，開關本應設 GLOBAL/REGION）。

---

## 重現步驟

1. 進入 `admin/pipeline-settings` → 新增配置
2. Scope 選 `COMPANY` 或 `FORMAT`
3. 在 Reference Number Matching 區塊把開關打開、設定類型
4. 儲存後上傳該公司文件處理
5. 觀察現象：Processing timeline 的 Reference Number Matching step 顯示**灰色 skipped**（設定未生效），但表單看起來像已啟用

---

## 根本原因

ref match 的 config 解析時機（公司識別前）使其只能讀 GLOBAL/REGION scope，但表單未反映此限制，允許在無效的 COMPANY/FORMAT scope 設定且無提示。

---

## 解決方案

`PipelineConfigForm`：當 `scope === 'COMPANY' || scope === 'FORMAT'` 時：

1. **UI 防呆**：Reference Number Matching 區塊不顯示開關/類型/最大結果數，改顯示說明 `Alert`（i18n key `form.refMatchScopeNotice`），告知此功能只在 GLOBAL/REGION 生效。
2. **提交清理**：建立/更新時，若 scope 非 GLOBAL/REGION，強制 `refMatchEnabled=false`，避免持久化無效的 `true` 值。

不改動 pipeline 執行順序、不改 ref match 服務邏輯。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/components/features/pipeline-config/PipelineConfigForm.tsx` | scope=COMPANY/FORMAT 時 ref match 區塊改顯示說明 Alert + 隱藏控制項；onSubmit 強制 refMatchEnabled=false |
| `messages/en/pipelineConfig.json` | 新增 `form.refMatchScopeNotice` |
| `messages/zh-TW/pipelineConfig.json` | 新增 `form.refMatchScopeNotice` |
| `messages/zh-CN/pipelineConfig.json` | 新增 `form.refMatchScopeNotice` |

---

## 測試驗證

- [x] `npm run i18n:check` 通過（3 語言 `form.refMatchScopeNotice` 同步）
- [x] `npm run type-check` 通過（`tsc --noEmit` 無錯誤）
- [x] 改動檔案 lint 無 error/warning（`npx eslint PipelineConfigForm.tsx` exit 0；整體 `npm run lint` 的 warning 屬既有 console.log 技術債）
- [ ] scope=GLOBAL/REGION：ref match 區塊正常顯示（開關 + 類型 + 最大結果數）— 待 UI 驗證
- [ ] scope=COMPANY/FORMAT：ref match 區塊只顯示說明 Alert，無開關 — 待 UI 驗證
- [ ] scope=COMPANY/FORMAT 儲存後，DB `ref_match_enabled` 為 false — 待 UI 驗證

---

*文件建立日期: 2026-06-18*
*最後更新: 2026-06-18*
