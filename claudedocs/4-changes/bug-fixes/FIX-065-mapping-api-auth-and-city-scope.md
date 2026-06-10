# FIX-065: mapping API 缺認證與城市範圍驗證

> **建立日期**: 2026-06-10
> **發現方式**: 代碼審查（2026-06-10 全面安全審查）
> **影響頁面/功能**: `/api/mapping`、`/api/mapping/[id]`
> **優先級**: 高
> **狀態**: 🔧 認證已修復（2026-06-10）；城市範圍 IDOR 留 WP-4
> **實作摘要**: mapping 3 個 handler 補 `auth()` + `RULE_VIEW`/`RULE_MANAGE`。城市範圍 IDOR（documentId 未過濾）已標註留 WP-4。type-check + lint 通過。
> **來源**: SECURITY-ASSESSMENT.md §4（DOCFLOW-01）、P0-DETAILED-PLAN.md WP-3c
> **相依**: 建議於 CHANGE-077/078 後實作；城市範圍 helper 與 WP-4（CHANGE 待立）共用

---

## 問題描述

| # | 問題 | 嚴重度 | 端點:行 |
|---|------|--------|---------|
| BUG-1 (DOCFLOW-01) | mapping API 完全無認證，可未登入讀取任意文件提取結果並觸發映射處理（昂貴操作） | Critical | `api/mapping/[id]/route.ts:28`、`api/mapping/route.ts:50,111` |

---

## 重現步驟
1. 不帶認證，GET `/api/mapping/<documentId>`
2. 觀察現象：回傳任意文件的提取與映射結果（應為 401）

---

## 根本原因
- `mapping` 兩檔 handler 缺 `auth()`。
- 即使補登入檢查，仍需驗證請求者對該文件 `cityCode` 的存取權（否則跨城市 IDOR）。

---

## 解決方案
1. 3 個 handler（`[id]` GET、`route` GET/POST）補 `auth()`。
2. 依文件所屬 `cityCode` 補城市範圍驗證（沿用 WP-4 的 `requireCityScope` / 服務層 `assertCityAccess`，或既有 `withCityFilter` 範本如 `documents/progress`）。
3. POST（觸發處理）額外確認權限（避免未授權觸發昂貴映射）。

---

## 修改的檔案

| 檔案 | 修改內容 |
|------|----------|
| `src/app/api/mapping/[id]/route.ts` | GET(28) 補認證 + 城市範圍 |
| `src/app/api/mapping/route.ts` | GET(50)/POST(111) 補認證 + 城市範圍 + 處理權限 |

---

## 測試驗證
- [ ] 未認證 → 401
- [ ] 已登入但跨城市文件 → 403
- [ ] 同城市合法 → 200
- [ ] `npm run type-check && npm run lint` 通過

---

*文件建立日期: 2026-06-10*
*最後更新: 2026-06-10*
