# FIX-102: 建立/編輯公司表單 FormData 契約不一致（POST 500 + PUT 靜默失效）

> **日期**: 2026-07-06
> **狀態**: 🔬 待 E2E 驗證（實作完成、type-check/lint 通過；使用者自行測試中）
> **優先級**: High
> **類型**: Bug Fix
> **影響範圍**: 公司建立/編輯表單、POST/PUT /api/companies
> **關聯**: 為 CHANGE-095（公司 code 補填）端到端生效的前置修復

---

## 問題描述

- 使用者在 `/companies/new` 建立公司時，回 500（Internal Server Error），建立失敗。
- 連帶發現：公司編輯（PUT）其實也一直靜默失效（改了 name/description 等不會儲存）。

## 根因

前端與後端的 FormData 契約不一致：

| 端 | 實際行為 |
|----|----------|
| 前端 `ForwarderForm.onSubmit` | 送 multipart FormData，**逐一欄位** append（name、code、defaultConfidence…），`body: formData` |
| POST `/api/companies` | `await request.json()` → 用 JSON 解析 multipart body → **拋錯 → 通用 catch → 500** |
| PUT `/api/companies/[id]` | 讀 `formData.get(data)` 期望一個 **data JSON blob**，但前端沒送 data → `updateData = {}` → **靜默無更新** |

PUT 明顯是設計為解析 data JSON blob（既有程式碼），前端 onSubmit 送逐欄位是不一致的一方，兩者對不上。大多數公司靠 AUTO_CREATED（JIT）自動建立，少有人用此表單，故長期未被發現。

## 修復方案（Approach B：對齊 PUT 既有的 data blob 設計）

1. **前端 `ForwarderForm.onSubmit`**：改為組一個 `payload` 物件，`formData.append(data, JSON.stringify(payload))`；logo / removeLogo 維持獨立欄位。（保留 CHANGE-095 的「已鎖定 code 不送」條件。）
2. **POST `/api/companies`**：加入 multipart 解析分支（讀 data blob，比照 PUT），保留純 JSON 分支。
3. **PUT 不變**：本來就讀 data blob，前端修正後即生效。

### 為何選 Approach B
- PUT 已實作 data blob 解析（既有、經設計的路徑），POST 只需鏡像。
- JSON blob 保留型別（`defaultConfidence` 維持 number，不需字串轉數字）。
- 後端風險最小，前端改動集中於 onSubmit。

## 修改範圍

| 檔案 | 變更 |
|------|------|
| `src/components/features/forwarders/ForwarderForm.tsx` | onSubmit 改送 data JSON blob |
| `src/app/api/companies/route.ts` | POST 加 multipart data 解析分支 |

## 效果

- 建立公司 500 修復（回 201）。
- 編輯公司實際生效（name/description/… 會儲存）。
- CHANGE-095 的 code 補填端到端生效（code 經 data blob → PUT → UpdateCompanySchema → updateCompany）。

## 驗證

- `npm run type-check` → exit 0
- `npx eslint`（兩檔）→ exit 0
- **待手動 E2E**：建立公司成功(201) / 編輯公司欄位生效 / CHANGE-095 空 code 補填生效 / 重複 code 回 409。

## 與 CHANGE-095 的關係

FIX-102 是 CHANGE-095 端到端生效的**前置修復**。CHANGE-095 的 Schema/Service/前端鎖定邏輯本身正確，但若無 FIX-102，PUT 收不到 code（updateData={}），補填不會實際發生。
