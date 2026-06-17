# FIX-079: Azure 容器執行期 `re2.wasm` ENOENT 回歸（正則功能失效）

> **建立日期**: 2026-06-17
> **發現方式**: FIX-078 上傳修復後部署 Azure DEV（映像 `dev-fix078-20260617112757`），抓容器 log 時發現
> **影響頁面/功能**: 所有用到 `safe-regex` 的正則功能（mapping rule test / preview，如 `/api/rules/test`、`/api/rules/[id]/preview`）
> **優先級**: 中（不影響上傳/處理/健康檢查；影響規則正則相關功能）
> **狀態**: 🚧 待修復（先記錄，之後處理）

---

## 問題描述

Azure DEV 容器**正常啟動**（`/api/health` 200、`database: connected`），但容器 stdout 在啟動預載（`unstable_preloadEntries`）與正則路由時**洪水般刷**以下錯誤：

```
Error: ENOENT: no such file or directory, open '/app/node_modules/re2-wasm/build/wasm/re2.wasm'
failed to compile wasm module: RuntimeError: abort(Error: ENOENT: ...re2.wasm)
    at getBinary (/app/node_modules/re2-wasm/build/wasm/re2.js:1486:5)
    ...
    at Object.<anonymous> (/app/node_modules/re2-wasm/build/src/re2.js:19:15)
```

注意：`build/src/re2.js` 能載入並執行（套件**存在**），但 `build/wasm/re2.wasm` **檔案缺失**。

---

## 重現步驟

1. 從 `main`（含 FIX-069 + runbook §13 修復）重建映像並部署 Azure DEV。
2. 容器啟動後抓 `*_default_docker.log`（Kudu / ARM containerlogs）。
3. 觀察：啟動段大量 `re2.wasm` ENOENT；呼叫任一正則功能（mapping rule test / preview）執行期失敗。

---

## 根本原因（已知 vs 待查）

這是 runbook **§13 已標記「已根治（PR #37）」的問題回歸**。本次確認 `main` 上 §13 的兩項修復**都還在**：

| 項目 | 狀態（main，已驗證） |
|------|----------------------|
| `next.config.ts` `serverExternalPackages: ['re2-wasm']` | ✅ 存在（第 21 行）→ runtime 路徑確實已是 `node_modules/re2-wasm/...`（非 `.next/server/chunks`），代表「不被 bundle」這半已生效 |
| `Dockerfile` `COPY --from=builder ... /app/node_modules/re2-wasm ./node_modules/re2-wasm` | ✅ 存在（第 185 行） |

**矛盾點**：修復都在，runtime 卻仍在 `/app/node_modules/re2-wasm/build/wasm/re2.wasm` ENOENT。代表 **COPY 沒有真正把 `build/wasm/re2.wasm` 帶進最終映像**，或被後續步驟覆蓋。

### 待查方向（實作時逐一確認）

1. **builder 階段該路徑是否真有 `re2.wasm`**：`re2-wasm` 套件本應內含 `.wasm`；確認 `deps`/`builder` 階段 `node_modules/re2-wasm/build/wasm/re2.wasm` 實際存在。
2. **COPY 順序 / standalone 覆蓋**：若 runner 先 `COPY .next/standalone`（內含部分 traced `node_modules`）**之後**才 COPY re2-wasm，或反之被 standalone 覆蓋，會造成檔案被蓋掉或不完整。需確認 Dockerfile runner 階段的 COPY 先後。
3. **base image 由 node:20 → `node:26-slim`**：Dockerfile 三個 stage 實際都是 `node:26-slim`（第 19 行註解仍寫 node:20，已過時）。確認 node 26 是否影響 npm ci 對 `re2-wasm` 的安裝/解壓。
4. **npm 11.16 預設擋 install script**：build log 出現大量 `npm warn allow-scripts ... Run npm approve-scripts`（無 `.npmrc`、無 lavamoat 設定 → 為 npm 內建行為）。`re2-wasm` 為純 WASM、理論上不靠 install script，但需排除其他連帶影響。

> 與 [[FIX-080]]（`@napi-rs/canvas` 缺失導致 OCR 失敗）**同屬一類**：「依賴有、但 native/WASM 檔沒進 standalone runtime 映像」。兩者可能共用根因（node:26 base + npm 11 script 阻擋 + standalone trace 不含動態載入的二進位）。建議一併調查。

---

## 解決方案（待定，實作前確認）

候選方向（擇一或合併）：
- 修正 Dockerfile runner 的 COPY 順序，確保 `node_modules/re2-wasm`（含 `build/wasm/re2.wasm`）在 standalone 複製**之後**落地、不被覆蓋。
- 若 builder 該檔本就缺，改在映像內顯式還原 `.wasm`（或 pin `re2-wasm` 版本確保套件含 `.wasm`）。
- 評估 base image 回 `node:20-slim`（與原設計一致、prebuilt 較穩）。

---

## 修改的檔案（預估，待實作回填）

| 檔案 | 預估修改 |
|------|----------|
| `Dockerfile` | runner 階段 re2-wasm COPY 順序 / 補檔 |
| `next.config.ts` | （視調查結果，可能不需動） |

---

## 測試驗證（待實作）

- [ ] 重建映像後，容器啟動段 `re2.wasm` ENOENT 數 = 0
- [ ] `/api/rules/test`、`/api/rules/[id]/preview` 正則功能執行期正常
- [ ] `/api/health` 仍 200

---

## 影響與優先級說明

- **不影響**：上傳、文件處理主流程（OCR 由 [[FIX-080]] 處理）、健康檢查。
- **影響**：規則正則相關功能執行期失敗 + log 洪水（雜訊干擾診斷）。
- 故列**中**優先級；建議與 [[FIX-080]] 合併於同一次映像重建處理（同屬 native 模組落地問題）。

---

*文件建立日期: 2026-06-17*
*最後更新: 2026-06-17*
