# FIX-140: entrypoint 對兩個旗標用「非空即執行」判斷，設為 `false` 仍會觸發

> **建立日期**: 2026-07-28
> **發現方式**: FIX-139 Azure DEV 部署驗收（容器 log 掃描）
> **影響頁面/功能**: 容器啟動流程（`scripts/docker-entrypoint.sh`）
> **優先級**: 低（目前無資料變更風險，但關閉語意違反直覺、每次啟動浪費一次 node 程序）
> **狀態**: 🚧 待修復

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

三個方向，**需決定後才實作**：

| 選項 | 做法 | 優點 | 代價 |
|------|------|------|------|
| **A（建議）** | 改為**明確列舉有效值**：`case "$RUN_TEMPLATE_MAPPING_SEED" in inspect\|dryrun\|write) ... esac` | 同時擋掉 `false` 與打錯字（如 `writte`）；有效值收斂到與腳本一致，上下游同源 | 新增模式時要改兩處（entrypoint + 腳本）|
| B | 保留 `-n` 但顯式排除假值：`[ -n "$X" ] && [ "$X" != "false" ]` | 改動最小 | 只擋 `false`，打錯字仍會觸發；`0` / `off` 等仍漏 |
| C | 不改程式碼，只在 runbook §A.5 與 entrypoint 註解寫明「這 2 個要清空、不是設 false」 | 零風險 | 依賴人記得例外，違反「一致的關閉語意」直覺 |

> `GRANT_GLOBAL_ADMIN_EMAIL` 建議一併處理：至少加 email 形狀檢查（含 `@`），避免把 `false` 當 email 送進腳本。

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
| `scripts/docker-entrypoint.sh` | 第 64 行（+ 第 39 行）改為明確列舉／排除假值；註解補「關閉方式」 |
| `docs/07-deployment/02-azure-deployment/dev-deployment-runbook.md` | §A.5 收尾說明區分「布林旗標設 false」與「非布林旗標需清空」 |

> ⚠️ 改動 `docker-entrypoint.sh` 屬**容器啟動關鍵路徑**（`set -e`）。必須確認工作樹為 LF（`.gitattributes` 已強制 `*.sh eol=lf`，見 runbook §12 的 CRLF → exit 127 事故）。

---

## 測試驗證

- [ ] 決定採用哪個選項
- [ ] 本機以 `sh` 驗證判斷式：`false` / 空 / `inspect` / `write` / 打錯字 各自的觸發結果符合預期
- [ ] `docker-entrypoint.sh` CR count = 0
- [ ] 部署後容器 log **不再**出現 `template field mapping seed: mode=false`
- [ ] 確認 `inspect` / `dryrun` / `write` 三個正常模式仍可觸發（不可因修正而誤擋）
- [ ] 其餘 7 個 `= "true"` 旗標行為未受影響

---

## 相關

- FIX-139 —— 本問題於該次部署驗收的 log 掃描中發現
- CHANGE-101 —— `RUN_TEMPLATE_MAPPING_SEED` 三模式設計來源
- `prisma/seed-template-field-mappings.js:336` —— unknown mode 保護（目前唯一擋住實際動作的機制）
- runbook §A.5 —— 「一次性旗標用完即設回 false」，對這 2 個旗標不成立

---

*文件建立日期: 2026-07-28*
*最後更新: 2026-07-28*
