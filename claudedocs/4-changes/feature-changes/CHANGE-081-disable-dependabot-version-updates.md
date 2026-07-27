# CHANGE-081: 停用 Dependabot 版本更新（保留安全漏洞修補）

> **狀態**: ✅ 已完成（2026-06-12 用戶 approve + 執行）

## 變更摘要

| 項目 | 內容 |
|------|------|
| **變更編號** | CHANGE-081 |
| **變更日期** | 2026-06-12 |
| **相關模組** | CI/CD 安全 Pipeline / 相依套件管理 |
| **影響範圍** | 刪除 `.github/dependabot.yml`；`CLAUDE.md` §開發工作流新增規範（同 PR #34） |
| **優先級** | Medium |
| **狀態** | ✅ 已完成（2026-06-12 用戶 approve + 執行） |
| **類型** | Governance Change（停用既有自動化） |
| **依賴** | 對應 Story 22-4 AC4（SDLC-04） |
| **對應安全控制項** | SDLC-04（SCA / Dependabot）— version updates 部分停用 |

---

## 背景與觸發

Story 22-4 AC4 建立的 `.github/dependabot.yml` 配置 5 個 ecosystem（npm / github-actions / docker / pip × 2）每週掃描並自動產生版本更新 PR。Dependabot 首次全量掃描於 2026-06-12 07:26–07:36 一次性產生 **21 個版本更新 PR**，造成 PR 列表噪音。

用戶評估後決定停用「版本更新」自動化，理由：
- 版本更新 PR 數量過多（含多個 major 升級：next 15→16、react-pdf 9→10 等，breaking change 風險高，需人工逐個評估）
- 現階段維護成本 > 自動化收益

## 用戶決策（2026-06-12）

| 決策點 | 用戶選擇 |
|--------|---------|
| 停用範圍 | **只停用版本更新（version updates），保留安全漏洞修補（security updates）** |
| 現有 21 個 PR | 合併 11 個全綠燈（Python/Docker），關閉 10 個紅燈（npm，CI 失敗 + major 風險） |

## 變更內容

1. **刪除 `.github/dependabot.yml`** — 停止所有 ecosystem 的每週版本更新 PR
2. **保留 Dependabot security updates** — 此為 GitHub repo 獨立設定（非由 `dependabot.yml` 控制），維持啟用；有 CVE advisory 時仍自動開修補 PR
3. **保留 CI 端相依漏洞掃描** — `security-deps.yml`（npm audit / pip-audit）、Trivy 不受影響，仍在 CI 把關
4. **附帶**：`CLAUDE.md` §開發工作流新增「工作單元完成後的提交確認」規範（同一 PR #34）

## 對 SDLC-04 的影響

| 面向 | 變更前 | 變更後 |
|------|--------|--------|
| 版本更新自動 PR | ✅ 啟用（weekly） | ❌ 停用 |
| 安全漏洞修補 PR | ✅ 啟用 | ✅ 保留 |
| CI npm audit / pip-audit / Trivy | ✅ 啟用 | ✅ 保留 |

SDLC-04 整體仍維持 L2（npm audit + security updates + CI 把關），但「主動版本維護」由自動降為手動。

## 後續追蹤（技術債務）

| 項目 | 說明 |
|------|------|
| npm audit 53 個漏洞 | 停用版本更新後失去自動升級管道，需建立**手動定期檢視**機制（建議每月 `npm audit` + 評估升級；HIGH/CRITICAL 優先） |
| 文件同步 | 已更新 Story 22-4 AC4、治理矩陣 SDLC-04、`known-discrepancies.md`（本 CHANGE 一併完成） |

## 執行記錄

- **PR #34**（governance）：刪除 `dependabot.yml` + CLAUDE.md 規範 → 已 merged
- **合併（綠燈）**：#9 #11 #12 #13 #15 #16 #17 #18 #19 #20 #21（#16/#21 經 `@dependabot rebase` 解衝突後合併）
- **關閉（紅燈 npm）**：#22 #23 #24 #25 #26 #27 #28 #29 #30 #31

---

*建立日期：2026-06-13（補記今天於 2026-06-12 執行的決策）*
