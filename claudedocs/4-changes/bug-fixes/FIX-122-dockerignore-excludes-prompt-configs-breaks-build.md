# FIX-122: `.dockerignore` 排除 `seed-data` 使 FIX-118 的靜態 import 建置失敗

> **日期**: 2026-07-20
> **狀態**: ✅ 已修復（映像重建 `ck16` Succeeded，並已部署至 Azure DEV 驗證）
> **嚴重度**: Sev1（部署阻塞 —— `origin/main` 無法建置容器映像）
> **類型**: Bug Fix（建置回歸）
> **影響範圍**: `.dockerignore`

---

## 問題描述

部署 `origin/main`（c61d533）到 Azure DEV 時，`az acr build` 於 run `ck15` 失敗（5m46s）：

```
./prisma/seed-prod-reference.ts:51:37
Type error: Cannot find module './seed-data/prompt-configs' or its corresponding type declarations.
The command '/bin/sh -c npm run build' returned a non-zero code: 1
```

## 根因

三個各自合理的既有條件疊加後才成立：

| # | 條件 | 出處 |
|---|------|------|
| 1 | [FIX-118](FIX-118-prod-reference-seed-overwrites-prompts-with-stale-copy.md) 把 prompt 來源從 `fs` 讀 JSON 改為**靜態 import** `./seed-data/prompt-configs`（消除副本漂移） | `prisma/seed-prod-reference.ts:51` |
| 2 | `.dockerignore` 排除整個 `prisma/seed-data`（原意：dev seed 不進生產映像） | `.dockerignore:151` |
| 3 | `tsconfig.json` 的 `include` 為 `**/*.ts`，`exclude` 僅 `node_modules` / `scripts` / `tests` → `next build` 會型別檢查 `prisma/*.ts` | `tsconfig.json:32-42` |

FIX-118 之前 `seed-prod-reference.ts` 以 `fs.readFileSync` 讀 JSON，**不產生模組解析依賴**，因此條件 2 與 3 一直相安無事。改為靜態 import 後，builder 階段（`COPY . .`，受 `.dockerignore` 限制）缺少該模組，型別檢查即失敗。

### 為何本地與 CI 測不出來

| 環境 | 檔案樹 | 結果 |
|------|--------|------|
| 本地 `npm run type-check` | 完整（含 `seed-data/`） | ✅ 通過 |
| CI | 完整（不做 docker build） | ✅ 通過 |
| Docker builder | **受 `.dockerignore` 過濾** | ❌ 失敗 |

同類陷阱曾見於 FIX-079 / FIX-080 / FIX-081（Next standalone 漏搬動態依賴）—— **只有映像分層複製才會顯現**的一類缺陷。

## 修正內容

`.dockerignore` 加入單一否定規則，精準保留該檔：

```
!prisma/seed-data/prompt-configs.ts
```

### 為何選這個方案

| 選項 | 評估 |
|------|------|
| **A（採用）** `.dockerignore` 例外保留該檔 | 最小、精準；修的正是根因（缺檔）。該檔為**自足常量模組（零 import）**，已查證無連鎖依賴，成本僅數 KB |
| B `tsconfig` 排除 `prisma` | 會讓**所有** `prisma/*.ts`（含 seed 腳本）脫離型別檢查，連帶縮小 CI 品質網 —— 為了過建置而拆掉檢查，代價不對等 |
| C 還原 FIX-118 為動態載入 | 直接違背 FIX-118 的單一真相來源目的，讓已根治的漂移風險復活 |

附帶好處：runner 映像（`COPY --from=builder /app/prisma`）因此也具備該檔，日後在容器內手動執行 `seed-prod-reference.ts` 不會在執行期才缺檔。

## 驗收

| # | 項目 | 標準 | 狀態 |
|---|------|------|------|
| 1 | 映像可建置 | `az acr build` 成功 | ✅ run `ck16` **Succeeded**（對照失敗的 `ck15`，同一份 code、僅差本 FIX） |
| 2 | 修的是根因 | 建置不再中斷於型別檢查 | ✅ `ck15` 於 `Checking validity of types` 失敗；`ck16` 通過並產出映像 |
| 3 | 排除範圍未擴大 | `seed-data` 其餘檔案仍被排除 | ✅ 僅單一否定規則 |
| 4 | 部署可完成 | 切換映像 + 重啟 + 健康檢查 | ✅ tag `dev-fix115-122-20260720151737`；`/api/health` 200 `{"database":"connected"}`；容器 log `✓ Ready in 694ms` |

## 關聯

- [FIX-118](FIX-118-prod-reference-seed-overwrites-prompts-with-stale-copy.md) — 引入靜態 import 的來源；本 FIX 讓其在容器建置下成立
- FIX-079 / FIX-080 / FIX-081 — 同類「只有映像分層才顯現」的部署缺陷
- 部署記錄：`docs/07-deployment/02-azure-deployment/deployment-records/2026-07-20-dev-fix115-120.md`

## 後續建議（未處理）

CI 未涵蓋 `docker build`，因此這類缺陷只能在實際部署時才被發現。若要根絕同類問題，可評估在 CI 加一個「僅建置、不推送」的 docker build 檢查。此屬流程改善、不在本 FIX 範圍。
