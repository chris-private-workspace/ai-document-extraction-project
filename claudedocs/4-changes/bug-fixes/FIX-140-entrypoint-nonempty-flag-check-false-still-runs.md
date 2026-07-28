# FIX-140: entrypoint 對兩個旗標用「非空即執行」判斷，設為 `false` 仍會觸發

> **建立日期**: 2026-07-28
> **發現方式**: FIX-139 Azure DEV 部署驗收（容器 log 掃描）
> **影響頁面/功能**: 容器啟動流程（`scripts/docker-entrypoint.sh`）
> **優先級**: 低（目前無資料變更風險，但關閉語意違反直覺、每次啟動浪費一次 node 程序）
> **狀態**: ✅ 已修復並已部署 Azure DEV（2026-07-28，映像 `dev-fix140-20260728151614`；以保留 `false` 設定取得前後對照驗證）

---

## 問題描述

`scripts/docker-entrypoint.sh` 的 9 個一次性 gated 區塊中，**7 個**用 `[ "$X" = "true" ]`（布林語意），但**2 個**用 `[ -n "$X" ]`（非空即執行）。

字串 `"false"` 是非空的 → **設成 `false` 並不會關閉這兩個步驟**，唯一的關閉方式是**清空該 app setting**。

| 行號 | 旗標 | 判斷式 | 設 `false` 的結果 |
|------|------|--------|------------------|
| 39 | `GRANT_GLOBAL_ADMIN_EMAIL` | `[ -n "$X" ]` | 觸發 → 嘗試把 `false` 當 email 授權 → 找不到帳號、非致命失敗 |
| 64 | `RUN_TEMPLATE_MAPPING_SEED` | `[ -n "$X" ]` | 觸發 → 腳本收到 `MODE=false` |
| 20, 31, 46, 55, 72, 83, 93 | 其餘 7 個 | `[ "$X" = "true" ]` | 正確關閉 |

### 實測證據（2026-07-28 FIX-139 部署）

Azure DEV 的 `RUN_TEMPLATE_MAPPING_SEED` 設為 `false`，容器 log 仍出現：

```
[entrypoint] Step 2/3: run essential seed (idempotent)
   Upserted: Auditor
[entrypoint] (optional) template field mapping seed: mode=false
[entrypoint] Step 3/3: starting Next.js server
```

### 目前無實際損害（但屬「防護恰好救了它」）

`prisma/seed-template-field-mappings.js:336` 有 unknown mode 保護：

```js
const MODE = (process.env.RUN_TEMPLATE_MAPPING_SEED || 'inspect').trim().toLowerCase()
// ...
} else {
  console.log(`[template-mapping] 未知 MODE=${MODE}，僅支援 inspect / dryrun / write。不執行。`)
}
```

所以 `MODE=false` 落到 else 分支、什麼都不做。損害僅為每次容器啟動多一次 node 程序（連 DB、印訊息、退出）。

**但這是下游的防護攔住了上游的判斷錯誤，不是設計正確。** 真正的風險是心智模型：運維看到其餘 7 個旗標都是 `false` = 關閉，會合理推論這兩個也一樣 —— 而它們不是。

---

## 重現步驟

1. 在 Azure DEV 設 `RUN_TEMPLATE_MAPPING_SEED=false`（或 `GRANT_GLOBAL_ADMIN_EMAIL=false`）
2. `az webapp restart`
3. 查容器 log（runbook §8 的 AAD bearer + Kudu，或 Log Analytics `AppServiceConsoleLogs`）
4. 觀察現象：對應的 `[entrypoint] (optional) ...` 行仍然出現，該步驟確實執行了

---

## 根本原因

**不是單純打錯，是設計取捨的副作用。**

`RUN_TEMPLATE_MAPPING_SEED` 是**三模式旗標**（`inspect` / `dryrun` / `write`，見 CHANGE-101），不是布林；`GRANT_GLOBAL_ADMIN_EMAIL` 的值是 email。對這兩者而言，「有沒有設值」比「是否等於 true」更貼近語意，所以當初用 `-n` 是有理由的。

問題出在**沒有處理「非布林旗標該如何關閉」**：
- 文件（runbook §A.5、entrypoint 註解）一律寫「用完即設回 false」—— 這對其餘 7 個成立，對這 2 個不成立
- entrypoint 註解只說「非空即執行」，沒說「所以 false 也算執行」
- 結果是文件與實作對「關閉」的定義不一致

---

## 解決方案

### 採用：選項 A（明確列舉有效值，2026-07-28 實作）

| 選項 | 做法 | 結果 |
|------|------|------|
| **A ✅ 採用** | 改為 `case` **明確列舉有效值** | 同時擋掉 `false` 與打錯字；有效值與下游腳本同源 |
| B | 保留 `-n` 但顯式排除假值 | 未採用：只擋 `false`，打錯字仍觸發，`0` / `off` 仍漏 |
| C | 只改文件不改程式碼 | 未採用：依賴人記得例外，關閉語意仍不一致 |

兩個旗標都改，且**保留各自的非布林語意**（沒有硬改成布林）：

```sh
# RUN_TEMPLATE_MAPPING_SEED —— 三模式
case "$RUN_TEMPLATE_MAPPING_SEED" in
  inspect|dryrun|write) …執行… ;;
  "")                   : ;;   # 未設定 = 關閉（不輸出）
  *)                    echo "… skipped: mode=$X not recognised (expected inspect|dryrun|write; clear the app setting to disable)" ;;
esac

# GRANT_GLOBAL_ADMIN_EMAIL —— email 形狀檢查
case "$GRANT_GLOBAL_ADMIN_EMAIL" in
  *?@?*.?*) …執行… ;;
  "")       : ;;
  *)        echo "… skipped: value is not an email address (clear the app setting to disable)" ;;
esac
```

**關鍵設計選擇：無法辨識的值會印 skip 訊息而非靜默跳過。** 若有人把 `write` 打成 `writte`，舊行為是照樣觸發（靠下游 unknown mode 保護才沒事），新行為是明確告知值被忽略 —— 否則「我設了卻沒作用」會變成沉默的謎。

#### H4 注意：skip 訊息不回印 email

`GRANT_GLOBAL_ADMIN_EMAIL` 的 skip 分支**刻意不輸出該值**。它可能是真實 email，印進容器 log 就是 PII 落地（H4 禁止）。`RUN_TEMPLATE_MAPPING_SEED` 的值是 mode 字串、非 PII，故照印以便診斷。

#### 已知限制

email 形狀檢查要求 `@` 後含 `.`，所以無 TLD 的位址（如 `admin@localhost`）會被擋。Azure DEV 實際使用的帳號為 `@rci-t.com` 形式，不受影響。

### 即時緩解（不需部署）

直接**清空** Azure 的設定即可讓該步驟不再執行，無須等映像重建：

```
az webapp config appsettings delete -g RG-RAPOSCM-AIDocProcessing-DEV \
  -n WebApp-RAPOSCM-AIDocProcessing-DEV --setting-names RUN_TEMPLATE_MAPPING_SEED
```

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `scripts/docker-entrypoint.sh` | 🔧 第 39 行 `GRANT_GLOBAL_ADMIN_EMAIL` → email 形狀檢查 `case`；第 64 行 `RUN_TEMPLATE_MAPPING_SEED` → 三模式明確列舉 `case`；兩處註解補「關閉方式是清空、設 false 無效」與 H4 說明（+35/−11）|
| `docs/07-deployment/02-azure-deployment/dev-deployment-runbook.md` | 🔧 §A.5 拆為「布林旗標(7 個 + `FORCE_SCHEMA_RESET`)設 `false`」與「非布林旗標(2 個)**必須 `delete` 清空**」兩類，各附命令；記錄 FIX-139 部署 log 的實例 |

**未修改**（刻意）：其餘 7 個 `= "true"` 旗標、`prisma/seed-template-field-mappings.js`（其 unknown mode 保護仍是有價值的第二道防線，保留）。

> ⚠️ 改動 `docker-entrypoint.sh` 屬**容器啟動關鍵路徑**（`set -e`）。必須確認工作樹為 LF（`.gitattributes` 已強制 `*.sh eol=lf`，見 runbook §12 的 CRLF → exit 127 事故）。

---

## 測試驗證

### 本地（已完成）

- [x] 決定採用哪個選項 —— A（明確列舉有效值）
- [x] `sh -n scripts/docker-entrypoint.sh` 語法通過
- [x] **`docker-entrypoint.sh` CR count = 0**（改動後重驗；`core.autocrlf=true` 但 `.gitattributes` 對 `*.sh` 強制 `eol: lf`）+ shebang `#!/bin/sh` 完好 → 不會重演 runbook §12 的 exit 127
- [x] 行為矩陣實測（`sh` 執行，模式字串與 entrypoint 逐字相同）：

| 值 | 新行為 | 舊行為 |
|-----|--------|--------|
| `''`（未設）| off-silent | off |
| **`false`** | **skip-warn** | **RUN** ← 本 FIX 的缺陷 |
| `inspect` / `dryrun` / `write` | RUN | RUN |
| `writte`（打錯字）| skip-warn | RUN ← 額外收益 |
| `FALSE` / `0` / `true` | skip-warn | RUN |
| `a@b.co` / `user.name@corp.example.com` | RUN | RUN |
| `notanemail` / `@b.co` / `a@b` / `a@.co` | skip-warn | RUN |

- [x] 確認 `inspect` / `dryrun` / `write` 三個正常模式仍可觸發（未因修正而誤擋）
- [x] 確認真實 email 形狀仍可觸發
- [x] 其餘 7 個 `= "true"` 旗標未被碰觸（本次只改第 39 / 64 行兩個區塊）

### Azure DEV（2026-07-28 已部署驗收）

| 項目 | 值 |
|------|-----|
| 映像 | `dev-fix140-20260728151614`（ACR run `ck1h` Succeeded，8m27s）|
| 前一映像 | `dev-fix139-20260728142008` |
| 變更範圍 | 2 個 commit，其中 `d1faa40` 純文檔 → **實質變更只有本 FIX 的 entrypoint 改動** |
| 前置檢查 | `.env.example` 零變更；entrypoint CR=0；`RUN_TEMPLATE_MAPPING_SEED` **刻意保留為 `false`**（見下）|
| 健康 | ✅ 200 `{"status":"healthy","services":{"database":"connected"}}`，uptime 16.7s |

#### 驗證設計：刻意不先清設定

部署前 `RUN_TEMPLATE_MAPPING_SEED` 仍是 `false`，**刻意保留**。若先清空，部署後只會得到 off-silent（無輸出），無法區分「修法生效」與「設定被清掉」。保留它才能取得前後對照：

| | log 輸出 |
|---|---|
| 部署前（`dev-fix139`）| `[entrypoint] (optional) template field mapping seed: mode=false` ← **執行了腳本** |
| 部署後（`dev-fix140`）| `[entrypoint] (optional) template field mapping seed skipped: mode=false not recognised (expected inspect\|dryrun\|write; clear the app setting to disable)` ← **跳過 + 說明原因** |

- [x] 容器 log **不再**出現舊的 `template field mapping seed: mode=false`
- [x] 改為出現 `... skipped: mode=false not recognised`，且訊息含關閉指引
- [x] 腳本確實**未被執行**（log 無 `[template-mapping] MODE=...` 輸出）
- [x] **容器正常啟動**（`Step 3/3: starting Next.js server` + `Ready in 1110ms`，**無** `exec: ... not found`）—— 本次動啟動關鍵路徑，此項為必驗，同時證明 `case` 語法在實機 dash 下無誤
- [x] essential seed 未受影響（`Upserted: Auditor` 仍正常）
- [ ] 收尾：清空 `RUN_TEMPLATE_MAPPING_SEED`（照 runbook §A.5；**待授權** —— 變更 app setting 會觸發一次額外重啟，且該值現已無實際作用、不緊急）

---

## 相關

- FIX-139 —— 本問題於該次部署驗收的 log 掃描中發現
- CHANGE-101 —— `RUN_TEMPLATE_MAPPING_SEED` 三模式設計來源
- `prisma/seed-template-field-mappings.js:336` —— unknown mode 保護（目前唯一擋住實際動作的機制）
- runbook §A.5 —— 「一次性旗標用完即設回 false」，對這 2 個旗標不成立

---

*文件建立日期: 2026-07-28*
*最後更新: 2026-07-28*
