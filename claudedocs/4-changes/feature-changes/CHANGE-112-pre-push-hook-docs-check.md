# CHANGE-112: 本地 pre-push hook 攔截 docs:check

> **日期**: 2026-07-28
> **狀態**: ✅ 已完成（2026-07-28）
> **優先級**: Medium
> **類型**: Tooling / DX
> **影響範圍**: 本地開發流程（不影響執行期程式碼）

---

## 變更背景

`npm run docs:check` 是 CI 的 required gate —— 新增或改動 CHANGE/FIX 狀態後若沒跑 `npm run docs:status` 重生成 `claudedocs/STATUS.md`，PR 會被擋下。

問題在於**本地沒有任何東西擋**：專案目前完全沒有 git hooks（`package.json` 無 `husky` / `lint-staged` / `prepare`，`.husky/` 不存在，`.git/hooks/` 只剩 `.sample`）。所以流程是：

```
忘記跑 docs:status → push → 等 CI → docs-check 紅 → 補跑 → 再 push → 再等 CI
```

每次多一輪往返。2026-07-27 的 PR #154 就是這樣紅的。

CLAUDE.md §Self-Verification Checklist 早就列明了這一項，但**它靠人記得**。這次 CI 補上 `unit-tests` 與 `build`（PR #158）走的是同一個方向：**把靠記性的事變成擋得住的閘門**。本變更把最後一項也補上，而且提前到本地。

---

## 變更內容

新增 `pre-push` hook，push 前執行 `npm run docs:check`。失敗即中止 push 並提示跑 `npm run docs:status`。

### 只跑 docs:check，不跑四閘

刻意**不**在 hook 裡跑 `type-check` / `lint` / `test`：

| 檢查 | 耗時（2026-07-28 實測）|
|------|------|
| `docs:check` | **11 秒** |
| `type-check` | 1 分 46 秒 |
| `lint` | 1 分 9 秒 |
| `test` | 8.6 秒 |

四閘全跑會讓每次 push 等 3 分鐘以上，實務上必然被 `--no-verify` 繞過，等於沒有。`docs:check` 快且針對性強 —— 它擋的正是最常忘、且純機械性的那一項。其餘四閘留給 CI。

---

## 技術設計

### 實作方式：**選項 A**（2026-07-28 用戶定案）

專案目前零 git hooks 基礎設施。兩條路曾並陳，用戶選定 A：

| 選項 | 做法 | 優點 | 代價 | 結果 |
|------|------|------|------|------|
| **A** | 原生 `.git/hooks/pre-push` + `scripts/install-git-hooks.ps1` 安裝腳本 | **零新依賴**；符合專案既有 `scripts/*.ps1` 慣例（`start-dev.ps1`、`init-new-environment.ps1`）| 每台電腦要手動裝一次；可掛進 `init-new-environment.ps1` 減輕 | ✅ **採用** |
| B | 引入 `husky` | 一次 `npm install` 自動生效、跨電腦一致 | **新增 npm devDependency → 觸發 H2**，需 explicit approval | ❌ 未採用 |

跨電腦開發是本專案常態（見 CLAUDE.md §跨電腦開發協作），B 在這點上較優；但 A 不必動 dependency，安裝步驟可併進既有的新環境初始化腳本，實質差距不大。

> **選 A 因此不觸發 H2**（零新增 dependency），可直接進入實作，無須另行 approval。

**修改範圍**

| 文件 | 變更內容 |
|------|----------|
| `scripts/pre-push` | 🆕 hook 本體：跑 `npm run docs:check`，非 0 即 `exit 1` 並印出補救指令 |
| `scripts/install-git-hooks.ps1` | 🆕 把上述檔案複製到 `.git/hooks/pre-push`（`.git/` 不受版控，故需安裝步驟）|
| `scripts/init-new-environment.ps1` | 🔧 新環境初始化時順帶安裝 hook |
| `docs/07-deployment/01-local-deployment/project-initialization-guide.md` | 🔧 補上安裝步驟說明 |

> ⚠️ `.git/hooks/` 在 CLAUDE.md §絕不 touch 清單的 `.git/` 之下。本變更**不直接寫入** `.git/`，而是提供安裝腳本由開發者自行執行 —— 實作時務必維持這個分界。

### i18n 影響

無。純開發工具，不含使用者可見字串。

### 資料庫影響

無。

---

## 設計決策

1. **選 `pre-push` 而非 `pre-commit`** —— `docs:check` 要 11 秒，掛在 commit 上會拖慢高頻操作；而且開發過程中 CHANGE/FIX 狀態本來就可能反覆改，push 前檢查一次即可。
2. **hook 失敗訊息要直接給出補救指令** —— 印 `npm run docs:status && git add claudedocs/STATUS.md`，不要只說「檢查失敗」。
3. **不擋 `--no-verify`** —— 保留逃生門。這是提醒機制，不是安全邊界；真正的 gate 在 CI。

---

## 向後兼容性

完全向後相容。未安裝 hook 的機器行為不變（照舊靠 CI 擋）。

---

## 驗收標準

| # | 驗收項目 | 驗收標準 | 優先級 |
|---|----------|----------|--------|
| 1 | hook 能擋下 | 故意讓 STATUS.md 與 CHANGE/FIX 不一致後 `git push`，push 被中止 | High |
| 2 | 提示可操作 | 失敗訊息含 `npm run docs:status` 補救指令 | High |
| 3 | 正常情況不擾民 | 一致時 push 正常進行，額外耗時 ≤ 15 秒 | High |
| 4 | 安裝流程可重複 | 重跑安裝腳本不出錯（冪等）| Medium |
| 5 | 新環境自動涵蓋 | `init-new-environment.ps1` 跑完後 hook 已就位 | Medium |

---

## 測試場景

| # | 場景 | 測試步驟 | 預期結果 |
|---|------|----------|----------|
| 1 | 狀態不同步 | 改某 FIX 的 `> **狀態**:` 但不跑 `docs:status` → `git push` | push 中止，印出補救指令 |
| 2 | 狀態同步 | 跑 `docs:status` 後 `git push` | 正常推送 |
| 3 | 逃生門 | `git push --no-verify` | 跳過檢查，正常推送 |
| 4 | 未安裝 hook | 在沒跑安裝腳本的機器 push | 行為與現況相同，不報錯 |

---

## 實作結果（2026-07-28）

### 實際檔案

| 檔案 | 類型 | 說明 |
|------|------|------|
| `scripts/pre-push` | 🆕 | hook 本體（sh）。跑 `npm run --silent docs:check`，非 0 即 `exit 1` 並印補救指令 |
| `scripts/install-git-hooks.ps1` | 🆕 | 安裝腳本。複製到 `.git/hooks/`，**明確正規化為 LF + 無 BOM** |
| `scripts/init-new-environment.ps1` | 🔧 | 新增 Step 11（10 步 → 11 步），以 try/catch 隔離為非致命 |
| `docs/07-deployment/01-local-deployment/project-initialization-guide.md` | 🔧 | 腳本流程表加第 11 列 + 既有環境補裝說明 |

### 行尾正規化不是多餘的防禦

Git for Windows 以自帶 `sh.exe` 執行 hook。CRLF 會讓 shebang 變成 `#!/bin/sh\r`、UTF-8 BOM 會讓它變成 `﻿#!/bin/sh` —— 兩者都導致 exec 失敗，而錯誤訊息（`not found` / `exec format error`）完全不指向真因。本專案在 Azure 容器上已經被 CRLF shebang 咬過一次（見 `.gitattributes` 的 `*.sh` 註解）。

`.gitattributes` 的 `* text=auto eol=lf` 已保證工作樹是 LF，安裝腳本仍再正規化一次 —— 因為編輯器另存、跨工具複製都可能繞過它。

**實測安裝結果**：`size=1661`、`BOM=False`、**`CR count=0`**、首行 `#!/bin/sh`。

### 驗收結果

| # | 驗收項目 | 結果 |
|---|----------|------|
| 1 | hook 能擋下 | ✅ 把本檔狀態改為已完成但不跑 `docs:status` → hook `exit 1`，印出 `R3 claudedocs\STATUS.md 與現況不符` |
| 2 | 提示可操作 | ✅ 輸出含 `npm run docs:status` / `git add` / `--amend` 三行補救指令 |
| 3 | 正常情況不擾民 | ✅ 一致時 `exit 0`，耗時約 11 秒 |
| 4 | 安裝流程冪等 | ✅ 覆寫式安裝，重跑不報錯 |
| 5 | 新環境自動涵蓋 | ✅ 已掛入 `init-new-environment.ps1` Step 11 |

驗收 1 刻意**用真實工作流程觸發**（改本檔狀態）而非人工破壞 STATUS.md —— 攔下的正是實務上最常發生的那一種不一致。

### 順帶發現（未修，屬 H3 範圍外）

`scripts/init-new-environment.ps1` 結尾的文件指引寫的是 `docs/06-deployment/...`，但實際目錄是 `docs/07-deployment/...`。這是既有錯誤、與本變更無關，**未動**。如需修正請另開 FIX。

---

*文件建立日期: 2026-07-28*
*最後更新: 2026-07-28*
