# FIX-141: main 分支從未設定 branch protection，11 個 CI check 全是 advisory

> **建立日期**: 2026-07-28
> **發現方式**: 處理「CI 不跑 vitest／build」carry-over 時查證實際配置
> **影響頁面/功能**: 儲存庫治理（`main` 分支合併閘）
> **優先級**: 高（既有的品質 gate 全數無強制力）
> **狀態**: ✅ 已修復（2026-07-28）

---

## 問題描述

`main` 分支**完全沒有 branch protection**：

```
$ gh api repos/.../branches/main/protection
gh: Branch not protected (HTTP 404)

$ gh api repos/.../rulesets
[]
```

後果：

| 事實 | 影響 |
|------|------|
| 11 個 CI check 全是 **advisory** | 任何 check 變紅仍可合併 PR |
| 無 required status checks | 品質閘等同「建議」 |
| 無 ruleset | 亦無替代機制 |

而 `.github/workflows/quality-checks.yml:3` 的註解寫著：

> 此 workflow 為 **Day 1 required（非 advisory）**；對應 npm scripts: type-check / lint / i18n:check

—— 這是**意圖聲明，從未落實到 GitHub 設定**。同理 `.claude/rules/general.md` 的「禁止直接提交到 main 分支」也只是人工紀律。

### 這與原本記錄的 carry-over 不是同一件事

`docs/07-deployment/.../2026-07-27-dev-change110.md` §仍未處理 第 1 項記載「CI 不跑 vitest」。該項**已於同日解決** —— CHANGE-110 後續補上了 `unit-tests` 與 `build` 兩個 job（見 `quality-checks.yml:5-12` 的註解），實測 PR #166〜#170 皆已執行（`unit-tests` ~1m09s、`build` ~4m04s）。

真正未解的是**下一層**：job 加了，但**跑了不擋**。追這個 carry-over 時才發現底下藏著這個更根本的缺口。

> 教訓：carry-over 清單的項目在轉錄時要重新查證現況，不能直接沿用。本次原樣沿用了 7/27 的描述，導致連續數則報告都說「CI 不跑 vitest」，而它早已不成立。

---

## 重現步驟

1. `gh api repos/<owner>/<repo>/branches/main/protection` → `404 Branch not protected`
2. 開一個讓 `unit-tests` 或 `build` 失敗的 PR
3. 觀察現象：`mergeStateStatus` 為 `UNSTABLE`（非 `BLOCKED`），**合併按鈕仍可用**

---

## 根本原因

CI workflow 與 GitHub 的分支設定是**兩套獨立的東西**：

| 層 | 狀態 |
|----|------|
| workflow 定義（`quality-checks.yml`）| ✅ 存在且正確，11 個 check 都會跑 |
| GitHub branch protection | ❌ 從未建立 |

Story 22-4 AC8 把「CI 強制 type-check + lint + i18n」寫進 workflow 註解，但**強制**這件事需要在 GitHub 設定 required status checks —— 這一步從未執行。之後 CHANGE-110 補 job 時同樣只動 workflow，沒補設定。

`mergeStateStatus: UNSTABLE` 其實一直在提示這件事（若有 required check 未通過應為 `BLOCKED`），但先前未被解讀。

---

## 解決方案

設定 branch protection，**核心 5 個 check 為 required**（2026-07-28 用戶決定）：

| Check | 耗時 | 為何 required |
|-------|------|--------------|
| `type-check` | ~1m40s | 型別錯誤 |
| `lint` | ~1m18s | ESLint |
| `unit-tests` | ~1m09s | 測試回歸（#99 曾無聲紅 17 天）|
| `build` | ~4m04s | **唯一能抓 bundle／runtime 解析問題的 gate**（FIX-069 re2-wasm、FIX-083 pdfkit、CHANGE-110 instrumentation 三次先例）|
| `docs-check` | ~7s | CHANGE/FIX 文檔一致性 |

**advisory（只跑不擋）**：`i18n-sync`、`semgrep`、`Semgrep OSS`、`gitleaks`、`npm-audit`、`pip-audit`。

安全掃描刻意不設 required —— 它們依賴上游 CVE 資料庫，新 CVE 發布即變紅，會擋住與該改動無關的 PR。

### 其餘參數與取捨

| 參數 | 值 | 理由 |
|------|-----|------|
| `strict`（要求分支與 main 同步）| `false` | 開啟後 main 每次更新都需 rebase 才能合併。本專案 PR 走 squash merge，2026-07-28 已因 squash 產生過假衝突（PR #166），開啟會放大該摩擦 |
| `required_pull_request_reviews` | `null` | 單人開發，要求 review 會自鎖 |
| `enforce_admins` | `false` | 保留 admin 緊急繞過空間 |
| `allow_force_pushes` / `allow_deletions` | `false` | main 不可被 force push 或刪除 |
| `required_linear_history` | `false` | squash merge 已天然線性 |

### 生效範圍（一項未實測）

required status checks 明確擋下**經 PR 的合併**。對**直接 `git push` 到 main** 的攔截：GitHub 文件指出受保護分支會拒絕未通過 check 的 push，但因 `enforce_admins: false`，儲存庫 admin 仍可繞過。**本次未做破壞性驗證**（不刻意往 main 推送測試），故此項標為未實測。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| （GitHub 設定，非檔案）| `main` 分支 branch protection：5 個 required status checks |
| `.github/workflows/quality-checks.yml` | 🔧 頭部註解修正「required」的實際含義 + 列出 required / advisory 分野 |

**未修改**：workflow 的 job 定義（11 個 check 本身完全不動 —— 本 FIX 只補「強制」那一層）。

---

## 測試驗證

- [x] `gh api .../branches/main/protection` 由 404 變為回傳設定
- [x] 獨立 GET 核對（非沿用 PUT 回傳）：contexts 為 5 個、`strict=false`、`enforce_admins=false`、PR review 未要求、force push／刪除禁止
- [x] check 名稱與實際 check run 名稱逐字相符（取自 `gh pr checks` 實測輸出，非猜測）
- [x] **本 FIX 自身的 PR 即為第一個受此保護的 PR** —— 其 `mergeStateStatus` 應在 checks 完成前為 `BLOCKED`（而非先前的 `UNSTABLE`），這是設定生效的直接證據
- [ ] 直接 push 到 main 是否被拒（未做破壞性驗證，見上）

---

## 影響：合併流程變慢

合併前需等 5 個 check 完成，由最慢的 `build` 決定 —— **約 4-5 分鐘**。

先前是「推上去就能合併」。這是刻意付出的代價：CHANGE-110 那次 `build` 問題一路送到 `az acr build` 才炸，白花約十分鐘與兩次 ACR 建置額度；#99 的測試紅了 17 天沒人知道。

---

## 相關

- CHANGE-112 —— pre-push hook（本地擋 `docs:check`）；本 FIX 是伺服器端的對應強制，兩者互補。hook 可被 `--no-verify` 繞過，branch protection 不能（除 admin）
- CHANGE-110 —— 補上 `unit-tests` / `build` 兩個 job；本 FIX 讓它們真正具備強制力
- Story 22-4 AC8（SDLC-08）—— 原始需求「CI 強制 type-check + lint + i18n」，本 FIX 才實際落實「強制」
- `.claude/rules/general.md` —— 「禁止直接提交到 main 分支」，先前純人工紀律

---

*文件建立日期: 2026-07-28*
*最後更新: 2026-07-28*
