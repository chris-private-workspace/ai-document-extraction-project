# FIX-076: codebase CI-readiness — type-check / lint / i18n 在乾淨 CI 通過

> **日期**: 2026-06-12
> **狀態**: ✅ 已修復（2026-06-12）
> **優先級**: High（阻擋 Story 22-4 CI pipeline 真正生效）
> **類型**: Bug（建置 / 程式碼品質）
> **影響範圍**: `tsconfig.json`、`package.json`、新增 `scripts/tsconfig.exec.json`、`src/i18n/request.ts`、`src/services/extraction-v3/confidence-v3.service.ts`、`src/services/extraction-v3/confidence-v3-1.service.ts`
> **來源**: Story 22-4 quality-checks workflow 在乾淨 CI（Linux node 20）首次執行暴露
> **發現於**: PR #3（Story 22-4）quality-checks 失敗（FIX-075 修好 npm ci 後跑到實際檢查）

---

## 問題描述

Story 22-4 的 quality-checks workflow（type-check / lint / i18n:check）在乾淨 CI 環境執行時三個 job 全失敗。揭示既有事實：**本 codebase 從未在乾淨 CI 環境通過過這三個檢查** —— 之前沒 CI，開發者本地環境（殘留 node_modules、較新 node 版本）掩蓋了問題。

| Job | 失敗原因 |
|-----|---------|
| type-check | `tsc` 掃到 `tests/` 下 test 檔（用 `describe/it/expect`）但專案無 `@types/jest`（測試框架是 Story 22-5 才建）|
| i18n:check | `ts-node` 在 CI node 20 + 根 tsconfig `module: esnext` 走 ESM loader，報 `ERR_UNKNOWN_FILE_EXTENSION .ts` |
| lint | 3 個既有 ESLint error（`no-assign-module-variable`、`prefer-const`×2）|

---

## 根本原因與修復

### 1. type-check：tsconfig 未排除 tests/

根 `tsconfig.json` `include: ["**/*.ts"]`，`exclude` 只有 `node_modules`/`scripts`，故 `tsc` 掃到 `tests/` 的 test 檔。測試型別環境由 Story 22-5（Vitest）建立，主 type-check 不應掃 tests/。

**修復**：`tsconfig.json` exclude 加 `"tests"`。

### 2. i18n:check：ts-node ESM 在 CI 壞

根 tsconfig `module: esnext` 使 ts-node 在 node 20 走 ESM loader，對 `.ts` 報 `ERR_UNKNOWN_FILE_EXTENSION`。本地 node 25 原生支援 .ts 故未暴露。

**修復**：新增 `scripts/tsconfig.exec.json`（extends 根 tsconfig，override `module: CommonJS` + `moduleResolution: node` + ts-node `transpileOnly`），i18n:check 改用 `npx ts-node --project scripts/tsconfig.exec.json scripts/check-i18n-completeness.ts`，強制 ts-node 走 CJS。腳本只 import `fs`/`path`（無 alias、無外部依賴），CJS 完全相容。**零新依賴（不觸發 H2）**。

> ⚠️ 踩坑記錄：原想照 `seed` script 的 `--compiler-options {"module":"CommonJS"}` pattern，但該 JSON 在 **Linux bash 會被去引號**（變 `{module:CommonJS}` → `SyntaxError: Expected property name`），只有本地 Windows shell 能跑。`seed` script 本身在 Linux CI 同樣會壞（只是未被測試暴露）。故改用 `--project` 指向專用 tsconfig，徹底避開 shell 引號問題。

### 3. lint：3 個既有 error

| 檔案 | 行 | error | 修復 |
|------|-----|-------|------|
| `src/i18n/request.ts` | 84 | `no-assign-module-variable`（賦值給保留變數 `module`）| 變數改名 `module` → `mod` |
| `src/services/extraction-v3/confidence-v3-1.service.ts` | 311 | `prefer-const`（`requiredFieldsCount` 未重新賦值）| `let` → `const` |
| `src/services/extraction-v3/confidence-v3.service.ts` | 200 | 同上 | `let` → `const` |

> warning（react-hooks/exhaustive-deps 等）不影響：next lint 只因 error fail。warning 屬既有技術債，逐步清理。

---

## 驗證

| 驗證項 | 環境 | 結果 |
|--------|------|------|
| type-check | 本地（exclude tests 後）| ✅ EXIT 0 |
| lint | 本地 | ✅ 0 error，EXIT 0 |
| i18n:check | Docker Linux node 20（模擬 CI）| ✅ EXIT 0「所有 i18n 翻譯完整」|

> type-check / lint 與 node 版本無關，本地驗證可信；i18n:check 涉及 ts-node 的 node 版本行為，特別在 Docker Linux node 20 驗證（本地 node 25 原生支援 .ts 會掩蓋問題）。

---

## 影響

- PR #3（Story 22-4）的 quality-checks 重跑後將通過，CI pipeline 真正生效。
- 無新依賴；i18n 沿用既有 ts-node CJS pattern，未偏離 vendor（不涉及 H2）。
