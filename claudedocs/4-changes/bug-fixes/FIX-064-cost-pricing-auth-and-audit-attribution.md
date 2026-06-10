# FIX-064: cost/pricing 端點缺認證與審計歸屬偽造

> **建立日期**: 2026-06-10
> **發現方式**: 代碼審查（2026-06-10 全面安全審查）
> **影響頁面/功能**: `/api/cost/pricing`、`/api/cost/pricing/[id]`
> **優先級**: 高
> **狀態**: ✅ 已修復（2026-06-10）
> **實作摘要**: cost/pricing 4 個 handler 補 `auth()` + `ADMIN_MANAGE`；移除 `changedBy='system-admin'` 改用 `session.user.id`。type-check + lint 通過。
> **來源**: SECURITY-ASSESSMENT.md §4（RPT-001/002）、§5（RPT-003）、P0-DETAILED-PLAN.md WP-3b
> **相依**: 建議於 CHANGE-077/078 後實作

---

## 問題描述

AI 成本計價配置端點完全無認證，未授權者可讀取與篡改 AI 成本計算基準，且變更歷史歸屬被偽造。

| # | 問題 | 嚴重度 | 端點:行 |
|---|------|--------|---------|
| BUG-1 (RPT-001) | POST 完全無認證，未授權者可創建計價配置（篡改成本基準） | Critical | `api/cost/pricing/route.ts:143` |
| BUG-2 (RPT-002) | PATCH 完全無認證，且 `changedBy` 硬編碼 `'system-admin'`（L152），審計歸屬偽造、無法歸責 | Critical | `api/cost/pricing/[id]/route.ts:125,152` |
| BUG-3 (RPT-003) | GET ×2 無認證，未授權讀取內部計價資料與含內部用戶 ID 的變更歷史 | High | `api/cost/pricing/route.ts:75`、`[id]/route.ts:60` |

> **盤點修正**：原以為 `/cost/*` 域 0% auth，實際 `city-summary`/`city-trend`/`comparison` 經 `withCityFilter` 有完整認證，真正裸奔的只有 `pricing` 兩檔 4 個 handler。

---

## 重現步驟
1. 不帶認證，POST `/api/cost/pricing` 帶任意計價配置
2. 觀察現象：成功創建（應為 401）

---

## 根本原因
- `pricing` 兩檔的 GET/POST/PATCH handler 缺 `auth()` 與角色檢查。
- PATCH 的 `changedBy` 為硬編碼字串（TODO 未完成），未取自 session user。

---

## 解決方案
1. 4 個 handler（2 GET、1 POST、1 PATCH）補 `auth()` + 角色檢查（計價配置屬高敏感，建議要求 admin 或 `COST_MANAGE` 權限）。
2. 移除 `[id]/route.ts:152` 的 `changedBy='system-admin'` 硬編碼，改用 `session.user.id`。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/app/api/cost/pricing/route.ts` | GET(75)/POST(143) 補認證 + 角色 |
| `src/app/api/cost/pricing/[id]/route.ts` | GET(60)/PATCH(125) 補認證 + 角色；`changedBy` 改用 session user |

---

## 測試驗證
- [ ] 4 個 handler：未認證 → 401；無權限 → 403；有權限 → 200
- [ ] PATCH 後變更歷史的 `changedBy` 為真實操作者 ID
- [ ] `npm run type-check && npm run lint` 通過

---

*文件建立日期: 2026-06-10*
*最後更新: 2026-06-10*
