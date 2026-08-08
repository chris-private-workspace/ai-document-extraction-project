# FIX-176: 生產相依的 21 個 high 漏洞 —— 消除 15 個，餘 6 個需 major 升級

> **建立日期**: 2026-08-08
> **發現方式**: FIX-171 第三批步驟 5 遺留待辦。2026-08-08 重新掃描時發現原記載的「20 個 high、受 major 升級阻擋」兩項都不準確
> **影響頁面/功能**: 不影響功能，屬供應鏈安全。`npm-audit` 已是 main 的 required status check（門檻 critical）
> **優先級**: 中
> **狀態**: 🚧 部分完成（2026-08-08 —— high 21 → **6**、總計 35 → **13**；剩餘 6 個全部需要 major 升級，屬 H2，待 approval）
> **相關**: [FIX-171](FIX-171-secure-dev-dod-checklist-gaps.md)（本 FIX 的來源，§第三批步驟 5）

---

## 問題描述

FIX-171 §步驟 5 把 critical 清為 0 後，留下一批 high 未處理，記載為「剩 20 個 high 受 major 升級阻擋」。

2026-08-08 重新掃描，這個記載有兩處與實況不符：

| 項目 | FIX-171 記載 | 實測 |
|---|---|---|
| 數量 | 20 | **21**（`nanoid` 為此後新增的 advisory） |
| 阻礙 | 「受 major 升級阻擋」 | 僅 4 個真需 major，其餘 17 個可在同 major 內解決 |

「受 major 阻擋」之所以會被過度概括，是因為當時把 `prisma` 鏈的 6 個歸因於 `@prisma/client` 的宣告缺口，而那個缺口其實只要升 minor 版本就能繞開。

---

## 處理結果

| | 起始 | 結果 |
|---|---:|---:|
| critical | 0 | 0 |
| **high** | **21** | **6** |
| moderate | 13 | 6 |
| low | 1 | 1 |
| **總計** | **35** | **13** |

### 分三批處理

**第一批：升級 Prisma 鏈（一次解 7 個）**

`@prisma/client` 與 `prisma` 由 7.2.0 升到 7.9.1（同 major 的 minor 升級）。這批的關鍵在於理解相依結構 —— Prisma 7 把 CLI 變成 `@prisma/client` 的**執行期**相依，所以 CLI 自己的相依全部進入生產樹：

```
@auth/prisma-adapter@2.11.3 → @prisma/client@7.2.0 → prisma@7.2.0 → @prisma/dev → hono / effect / ...
```

一次消除 `prisma`、`@prisma/config`、`@prisma/dev`、`hono`、`@hono/node-server`、`effect`、`defu` 共 7 個 high。

> ⚠️ 依 FIX-171 的教訓，client 與 CLI **必須同時升**。`npm audit fix` 曾只升 CLI 而讓 `prisma generate` 直接失敗。本次兩者一併指定版本，升級後 `prisma generate` 通過。

**第二批：單一實例的 overrides（解 5 個）**

`axios`、`form-data`、`lodash`、`nanoid`、`tmp` 各只有一個安裝實例，比照 FIX-171 的 `fast-xml-parser` 做法逐一 override。`js-yaml` 是直接相依，同時改 `dependencies` 宣告與加 override（後者用於涵蓋 `swagger-ui-react` 底下的巢狀實例）。

**第三批：多版本線的分線 override（解 3 個）**

`minimatch`、`brace-expansion`、`picomatch` 各自同時存在多條 major 線，單一 override 會強制統一版本並可能破壞相依。改用 npm 的巢狀 override 按相依鏈分線：

| 相依鏈 | minimatch | brace-expansion |
|---|---|---|
| `exceljs → archiver → archiver-utils → glob` | 3.1.2 → **3.1.5** | 1.1.12 → **1.1.18** |
| `exceljs → archiver → readdir-glob` | 5.1.6 → **5.1.9** | 2.0.2 → **2.1.4** |
| `swagger-ui-react → swagger-client → @swagger-api/apidom-reference` | 7.4.6 → **7.4.9** | 2.0.2 → **2.1.4** |

`picomatch` 同理分兩線：`micromatch` 底下 2.3.1 → **2.3.2**、`@parcel/watcher` 底下 4.0.3 → **4.0.5**（`tinyglobby` 底下的 4.0.4 本就安全）。

巢狀語法中的 `"."` 指該套件自身的版本：

```json
"glob": {
  "minimatch": {
    ".": "^3.1.4",
    "brace-expansion": "^1.1.18"
  }
}
```

---

## 三個查證上的關鍵發現

### 一、`lodash` 的修復版本不是「脆弱範圍上界 + 1」

advisory 範圍是 `<=4.17.23`，直覺會寫 `^4.17.24`，但**該版本不存在** —— registry 查證顯示 4.17.21 之後直接跳到 4.17.23、4.18.0、4.18.1，修復發布在 **4.18.x**。若照直覺寫，`npm install` 會直接失敗。

這一項是動手前逐一向 registry 查證目標版本存在性的直接收穫；其餘 20 項查詢皆命中，唯獨這一項落空。

### 二、🔴 `immutable` 的 advisory 被我讀錯，且 override 沒有解決問題

`npm audit` 顯示 `immutable` 的脆弱範圍為 `<3.8.3 || <4.3.9`。我把它讀成「3.x 線的修復在 3.8.3、4.x 線的修復在 4.3.9」，因而 override 到 `^3.8.3`。

**這是錯的。** 那是兩條**獨立的 advisory**，第二條涵蓋所有低於 4.3.9 的版本，包含整個 3.x。升到 3.8.3 後 `npm audit` 仍將其列為 high，範圍顯示為 `<4.3.9 || <4.3.9`，並連帶把 4 個依賴它的套件（`react-immutable-proptypes`、`react-immutable-pure-component`、`redux-immutable`、`swagger-ui-react`）也列了出來。

已撤銷該 override。`immutable` 的唯一安全版本是 >= 4.3.9，屬 major 升級（3.x → 4.x），改列入待 approval 清單。

**教訓**：多條 advisory 的 range 是「聯集」而非「分線對照表」，判定安全版本要取所有 range 的**交集之外**，不能逐條各自解讀。

### 三、Windows 產生的 lock 缺 5 個 Linux 專屬條目（同型問題第 4 次出現）

全部 `npm install` 都在 Windows 執行，本機 `type-check` / `lint` / `test` / `build` 四項全綠，lock 的平台條目計數（linux 59 / darwin 20 / win32 19）也與 FIX-171 的基準一致 —— **完全看不出問題**。

以 `node:22-slim` 容器跑 `npm ci` 才暴露出來：

```
Missing: @emnapi/core@1.10.0 from lock file
Missing: @emnapi/runtime@1.10.0 from lock file
Missing: tree-sitter@0.21.1 from lock file
Missing: tree-sitter@0.22.4 from lock file
Missing: @swc/helpers@0.5.23 from lock file
```

這會讓 CI 的 5 個 required job 同時失敗。修法沿用 FIX-171：在 Linux 容器以 `npm install --package-lock-only --ignore-scripts` 重新生成 lock（`--package-lock-only` 只重算相依樹、不實際安裝，本次磁碟空間吃緊，這點很重要）。

重新生成後：套件數 1346 → 1351（正是補上的 5 個），`lockfileVersion` 維持 3 未被降級，Linux 容器 `npm ci` 通過。

> 📌 **容器 npm 版本與本機不同**（10.9.8 vs 11.6.2），本次未造成 lock 格式差異，但這是需要留意的變數。

---

## 剩餘 6 個 high：全部需要 major 升級（H2，待 approval）

| 套件 | 目前 | 需要 | 阻礙 |
|---|---|---|---|
| `immutable` | 3.8.2 | 4.3.9 | major 3 → 4。連帶影響 `swagger-ui-react` |
| `nodemailer` | 7.0.12 | 9.0.5 | major 7 → 9（跨兩個 major） |
| `postcss` | 8.4.31（next 綁定） | — | 修復綁定 `next@16.3.0` |
| `sharp` | 0.34.5 | 0.35.0 | 同上，綁定 `next@16.3.0` |
| `next` | 15.5.23 | 16.3.0 | major 15 → 16 |
| `swagger-ui-react` | 5.31.0 | — | 因 `dompurify` 與 `immutable` 而中招 |

三個獨立的升級決策：

| # | 決策 | 涵蓋 | 風險 |
|---|---|---|---|
| 1 | `next` 15 → 16 | `next`、`postcss`、`sharp`（3 個） | 最高。App Router 行為、middleware、build 產物皆可能變動，且本專案的認證閘完全建立在 middleware 上 |
| 2 | `nodemailer` 7 → 9 | `nodemailer`（1 個） | 中。用於寄送通知信，API 可能變動 |
| 3 | `immutable` 3 → 4 | `immutable`、`swagger-ui-react`（2 個） | 中。3 → 4 有 API 變動，但本專案不直接使用，僅 `swagger-ui-react` 相依 |

---

## 修改的檔案

| 檔案 | 修改內容 | 狀態 |
|------|----------|------|
| `package.json` | `overrides` 由 1 項擴為 12 項（含 5 組巢狀分線）；`js-yaml` 宣告 `^4.1.1` → `^4.3.1`；`@prisma/client` 與 `prisma` 宣告 `^7.2.0` → `^7.9.1` | ✅ 已完成 |
| `package-lock.json` | 隨上述變更更新，並**於 Linux 容器重新生成**以補齊平台專屬條目 | ✅ 已完成 |

---

## 測試驗證

- [x] `npx prisma generate` 通過（升級 client + CLI 後的關鍵驗證）
- [x] `npm run type-check` 通過
- [x] `npm run lint` 通過（exit 0）
- [x] `npm run test` —— 42 檔案通過 / 1 跳過；489 測試通過 / 2 跳過、**0 失敗**
- [x] `npm run build` 通過（Next.js 15.5.23 正常產出）
- [x] **Linux 容器 `npm ci` 通過**（`node:22-slim`）—— 這是本次唯一能揭露 lock 缺項的檢查
- [x] `npm audit --omit=dev` 複驗：critical 0 / high 6 / moderate 6 / low 1
- [x] 逐一確認 override 後的實際安裝版本落在安全範圍（非僅信任 audit 的彙總）

### 未涵蓋

| 項目 | 原因 |
|---|---|
| 登入後的功能回歸 | 本機 dev bypass 實際為關閉狀態，無法自助登入。`axios`、`form-data`、`nodemailer` 等涉及外部請求的套件，其行為變化需在有資料庫的環境驗證 |
| Azure Blob 上傳／下載 | 本機未啟動 Azurite。`fast-xml-parser`（FIX-171 已 override）與本次的 `form-data` 都在該路徑上 |
| Excel 匯出 | `exceljs → archiver → glob/minimatch` 這條鏈本次被 override，匯出功能需實測 |

> ⚠️ 上表第三項值得優先驗證：`minimatch` 的三條線中有兩條屬於 `exceljs` 的壓縮流程，而 Epic 19 的匯出功能直接依賴它。

---

*文件建立日期: 2026-08-08*
*最後更新: 2026-08-08*
