# FIX-176: 生產相依的 21 個 high 漏洞 —— 消除 15 個，餘 6 個需 major 升級

> **建立日期**: 2026-08-08
> **發現方式**: FIX-171 第三批步驟 5 遺留待辦。2026-08-08 重新掃描時發現原記載的「20 個 high、受 major 升級阻擋」兩項都不準確
> **影響頁面/功能**: 不影響功能，屬供應鏈安全。`npm-audit` 已是 main 的 required status check（門檻 critical）
> **優先級**: 中
> **狀態**: 🚧 部分完成（2026-08-08 —— 第一階段 high 21 → 6；第二階段完成 `immutable` 3→4 與 `next` 15→16，high **6 → 4**、總計 **12**。剩餘 4 個全部源於同一個上游死結：`nodemailer` 9 受 `next-auth` 的 peer 宣告阻擋，詳見 §第二階段）
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

> ✅ **使用者於 2026-08-08 批准，處理結果見 §第二階段**：`immutable` 與 `next` 兩項完成（解除 5 個），`nodemailer` 受上游 peer 限制阻擋。以下為批准當下的評估，保留供追溯。

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

---

## 第二階段：3 個 major 升級（2026-08-08，使用者批准 H2）

### 結果：high 6 → 4

| | 第一階段後 | 第二階段後 |
|---|---:|---:|
| critical | 0 | 0 |
| **high** | **6** | **4** |
| moderate | 6 | 7 |
| low | 1 | 1 |
| **總計** | **13** | **12** |

| 升級 | 結果 |
|---|---|
| `immutable` 3.8.2 → **4.3.9** | ✅ 完成，連帶解除 `swagger-ui-react` |
| `next` 15.5.23 → **16.3.0** | ✅ 完成，連帶解除 `postcss` 與 `sharp` |
| `nodemailer` 7.0.12 → 9.0.5 | ❌ **受阻**，見下 |

### 🔴 `nodemailer` 的上游死結

`next-auth@5.0.0-beta.32` 與 `@auth/core@0.41.3` 宣告的 peer 範圍是 `nodemailer@"^7.0.7 || ^8.0.5"`，**不接受 9.x**。而 nodemailer 的 advisory 範圍是 `<=9.0.0` —— 也就是 **8.x 沒有任何安全版本**，必須到 9.x。

實測三條路都不通：

| 嘗試 | 結果 |
|---|---|
| 直接裝 `nodemailer@^9.0.5` | 裝得上，但相依樹被標為 `invalid`，**後續任何 `npm install` 都因 ERESOLVE 失敗** —— 這不是警告，是會卡住整個相依安裝流程 |
| 加 `@types/nodemailer@^8.0.1` | 直接被 peer 衝突擋下 |
| 宣告保持 8.x、以 `overrides` 強制 9.x | npm 拒絕：`EOVERRIDE: Override for nodemailer@^8.0.11 conflicts with direct dependency`。npm 不允許對**直接相依**設定不同 spec 的 override |

因此回退為 `^8.0.11`（next-auth 允許的最高版）。代價是 4 個 high：`nodemailer` 自身，加上因它而中招的 `@auth/core`、`@auth/prisma-adapter`、`next-auth`。

**實際曝險評估**：本專案**未使用** next-auth 的 email provider（`src/lib/auth.config.ts` 的 `buildProviders()` 未註冊 Nodemailer/Email provider，全庫亦無 `providers/nodemailer` 引用）。nodemailer 的唯一使用點是 `src/lib/email.ts`，走自建 SMTP 設定寄送驗證信。所以 next-auth 那 3 個標記屬於「相依關係上的傳染」，並非實際可觸發的路徑。

**剩餘選項**（皆需決策，未擅自採用）：

| 選項 | 作法 | 代價 |
|---|---|---|
| A | 維持現狀，等 `next-auth` 放寬 peer 範圍 | 4 個 high 持續存在 |
| B | `.npmrc` 設 `legacy-peer-deps=true` 後升到 9.x | 全專案的 peer 檢查一併放寬，可能掩蓋其他真實衝突 |
| C | 改用其他 SMTP 套件取代 `src/lib/email.ts` 的 nodemailer | 屬 H2 換 vendor，且需重寫寄信邏輯 |

### Next.js 16 需要的三項配套變更

升級不是純相依變動，Next 16 移除了兩個既有依賴的機制：

**一、`NextConfig` 移除 `eslint` 選項。** `next.config.ts` 原有 `eslint: { ignoreDuringBuilds: true }`，在 16 會直接讓 `type-check` 失敗（TS2353）。已刪除 —— Next 16 的 `next build` 本就不再執行 ESLint，行為等價。

**二、`next lint` 子命令已移除。** `npm run lint` 原本是 `next lint`，在 16 會把 `lint` 當成目錄參數而報「Invalid project directory」。已改為直接呼叫 ESLint CLI。

**三、新增 `.eslintignore`。** 原本的忽略範圍由 `next lint` 內建提供，改用 ESLint CLI 後必須明確列出，否則會掃進 `.next/`、`public/`、`python-services/` 等目錄。

> 🔴 **一個容易誤判的地方**：lint script 若寫成 `eslint .`，會掃出 **3559 個問題（150 errors / 3409 warnings）** 而讓 CI 失敗。這些**不是升級造成的** —— `next lint` 原本只掃 `app`／`pages`／`components`／`lib`／`src`，而 `eslint .` 掃全部，把 `scripts/`、`tests/` 等從未納入 lint 的程式碼一併拉了進來。
>
> 已將範圍收斂為 `eslint src`，與 `next lint` 等價（實測 exit 0、333 warnings、0 errors）。**擴大 lint 覆蓋範圍是獨立議題，不應由一次相依升級夾帶。**

### `eslint-config-next` 未一併升級

`eslint-config-next@16.3.0` 要求 `eslint >= 9`，而本專案在 `eslint@^8.57.0`。ESLint 9 的 flat config 是重大遷移，會連鎖出第四個 major 升級，故維持 `^15.0.0`。它是 dev 期的 lint 規則來源，與 Next.js 執行期無關，實測 lint 正常運作。

---

## 修改的檔案

| 檔案 | 修改內容 | 階段 | 狀態 |
|------|----------|------|------|
| `package.json` | `overrides` 由 1 項擴為 12 項（含 5 組巢狀分線）；`js-yaml` 宣告 `^4.1.1` → `^4.3.1`；`@prisma/client` 與 `prisma` 宣告 `^7.2.0` → `^7.9.1` | 一 | ✅ 已完成 |
| `package-lock.json` | 隨變更更新，並**於 Linux 容器重新生成**以補齊平台專屬條目 | 一・二 | ✅ 已完成 |
| `package.json` | 新增 `immutable: ^4.3.9` override；`next` → `^16.3.0`；`nodemailer` → `^8.0.11`；`lint` script 由 `next lint` 改為 `eslint src --ext .js,.jsx,.ts,.tsx` | 二 | ✅ 已完成 |
| `next.config.ts` | 移除 Next 16 已不支援的 `eslint.ignoreDuringBuilds` | 二 | ✅ 已完成 |
| `.eslintignore` | **新增** —— 補上原由 `next lint` 內建提供的忽略範圍 | 二 | ✅ 已完成 |
| `tsconfig.json` | **由 `next build` 自動修改**：`jsx` 由 `preserve` 改為 `react-jsx`；`include` 新增 `.next/dev/types/**/*.ts` | 二 | ✅ 已完成 |
| `next-env.d.ts` | **由 `next build` 自動修改**：`/// <reference path>` 改為 `import` 語法，並新增 `root-params.d.ts`（該檔標註 should not be edited，本即自動生成） | 二 | ✅ 已完成 |

> 📌 上述兩個檔案由 Next 16 的 build 自動改寫，非手動編輯。其中 `jsx: preserve → react-jsx` 是實質變更（改用 React 17+ 的新 JSX transform）—— `type-check`、`build`、`test` 皆在此變更**之後**通過，確認相容。這兩項必須一併提交，否則每次 build 都會重新產生未提交的差異。

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

### 第二階段（`immutable` 4.3.9 + `next` 16.3.0）

- [x] `npx prisma generate` 通過
- [x] `npm run type-check` 通過（修正 `next.config.ts` 的 `eslint` 選項後）
- [x] `npm run lint` 通過（exit 0、333 warnings、0 errors，範圍與 `next lint` 等價）
- [x] `npm run test` —— 489 passed / 2 skipped / **0 failed**
- [x] `npm run build` 通過（**Next.js 16.3.0**，先 `rm -rf .next` 避免 15 的產物殘留）
- [x] `npm run i18n:check` 通過（三語言翻譯完整）
- [x] **Linux 容器 `npm ci` 通過**（`node:22-slim`，lock 已重新生成）
- [x] `npm audit --omit=dev` 複驗：critical 0 / high **4** / moderate 7 / low 1
- [x] 確認 `next@16.3.0` 與 `nodemailer@8.0.11` 為實際安裝版本

> ⚠️ **Next 16 升級的驗證缺口比前一階段更值得重視**：本機無法登入，因此 App Router 在登入後的行為、middleware 在 16 的實際表現皆未實測。而本專案的 API 認證閘與頁面保護（FIX-175）**完全建立在 middleware 上**，這正是 Next 16 最可能出現行為變化之處。部署到 DEV 後應優先走一次登入與受保護路由的端到端驗證。

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
