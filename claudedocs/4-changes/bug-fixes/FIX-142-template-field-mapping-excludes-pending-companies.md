# FIX-142: 模板欄位映射頁選不到 PENDING 公司，與欄位定義集的公司來源不一致

> **建立日期**: 2026-07-29
> **發現方式**: 使用者 Azure DEV 測試回報「Cargo Partner 無法加入 template field mappings」
> **影響頁面/功能**: `/admin/template-field-mappings`（新建 + 編輯）
> **優先級**: 中（灰帶公司的映射完全無法建立，且成因不易察覺）
> **狀態**: ✅ 已修復（2026-07-29）

---

## 問題描述

使用者無法為 `cargo-partner Logistics Ltd.` 與 `CYTS-SPIRIT LOGISTICS LIMITED` 建立模板欄位映射 —— 這兩間公司在該頁的公司下拉選單中完全不存在。

Azure DEV 實際資料（2026-07-29 查證）：

| 公司 | 狀態 | 來源 | 文件數 | 疑似重複於 |
|------|------|------|--------|-----------|
| `cargo-partner Logistics Ltd.` | PENDING | AUTO_CREATED | 10 | `Cargo Partner`（ACTIVE） |
| `CYTS-SPIRIT LOGISTICS LIMITED` | PENDING | AUTO_CREATED | 10 | `CYTS`（ACTIVE） |

兩間都是 CHANGE-103 Phase 2 灰帶機制（組件 4）建立的 PENDING 公司 —— 這是**設計預期行為**：token-set 判定 core 為子集關係時建 PENDING + 掛 `suspectedDuplicateOfId`，不自動併、待人工審核，同時仍綁文件讓提取繼續。

問題不在公司狀態，而在**兩個設定頁對公司的過濾條件不一致**：

| 頁面 | 公司來源 | PENDING 公司 |
|------|---------|-------------|
| 欄位定義集 | `useCompaniesForPromptConfig` → `/api/companies`（不過濾狀態） | 選得到 |
| 模板欄位映射 | `prisma.company.findMany({ where: { status: 'ACTIVE' } })` | **選不到** |

證據：這兩間 PENDING 公司**都已經有 `field_definition_sets` 記錄**（`CARGO PARTNER - 自訂費用欄位集`、`CYTS-SPIRIT LOGISTICS LIMITED - 自訂費用欄位集`，皆 `is_active = true`），卻 **0 筆 `template_field_mappings`** —— 使用者顯然是走到映射這步才被擋住。

---

## 重現步驟

1. 讓 Stage 1 對某公司名觸發灰帶判定（core 為既有公司子集），系統建立 PENDING 公司並綁上文件
2. 到 `/admin/field-definition-sets/new` 建立該公司的欄位定義集 → **選得到該公司**
3. 到 `/admin/template-field-mappings/new` 想建對應映射 → **公司下拉中找不到該公司**

---

## 根本原因

`admin/template-field-mappings` 的兩個頁面各自硬寫了 `status: 'ACTIVE'`：

| 檔案 | 行號 | 原條件 |
|------|------|--------|
| `src/app/[locale]/(dashboard)/admin/template-field-mappings/new/page.tsx` | 97-101 | `where: { status: 'ACTIVE' }` |
| `src/app/[locale]/(dashboard)/admin/template-field-mappings/[id]/page.tsx` | 53-57 | `where: { status: 'ACTIVE' }` |

原註解寫著 `// Fetch companies (only active ones)` —— 這個條件在 CHANGE-103 Phase 2 引入 PENDING 灰帶公司**之前**是合理的（當時 PENDING 幾乎不會綁到文件），之後就變成缺口：灰帶公司會綁著文件跑完整條提取管線，卻無法為它建立映射，資料到了模板實例那步就沒有規則可套。

編輯頁同樣要修 —— 否則就算映射建起來了，之後編輯時公司下拉會找不到自己的值而顯示空白。

---

## 修復方式

兩處查詢條件改為納入 PENDING、排除 MERGED：

```ts
// FIX-142: 納入 PENDING（CHANGE-103 Phase 2 灰帶待審核公司），與欄位定義集的公司來源對齊
const companies = await prisma.company.findMany({
  where: { status: { in: ['ACTIVE', 'PENDING'] } },
  select: { id: true, name: true },
  orderBy: { name: 'asc' },
});
```

**為何不直接對齊 `/api/companies` 的「完全不過濾」**：那會把 MERGED 公司也列出來。Azure DEV 現有 8 間 MERGED 公司，其中 `CEVA LOGISTICS (HONG KONG) LIMITED（CEVA Logistics）` 底下還掛著 2 筆 `is_active = true` 的映射 —— 那些是合併後遺留的殭屍配置，不該再讓使用者往上疊加新映射。

---

## 驗證

- `npm run type-check` 通過
- `npm run lint` 通過（僅既有 warning，不涉及本次改動的檔案）

---

## 已知限制

`Cargo Partner`（ACTIVE）與 `cargo-partner Logistics Ltd.`（PENDING）名稱極為相似，選單目前只顯示 `company.name`，無狀態標示，使用者仍可能選錯。要在選單標示「待審核」需一併調整 `TemplateFieldMappingForm` 的 props 與 i18n 三語言字串，超出本次修復範圍。

**治本方向**：這兩間 PENDING 公司本來就該在 `/admin/companies/duplicate-review`（Sidebar 「重複審核」）處理掉 —— confirm-merge 併入既有公司，或 confirm-new 升為 ACTIVE。處理後 PENDING 是暫態，選單混淆的風險自然消失。

---

## 相關

- CHANGE-103 Phase 2（組件 4）— 灰帶 PENDING 公司機制的來源
- `src/app/api/companies/pending/route.ts` — 待審核佇列 API
- `src/services/company.service.ts` `confirmCompanyAsNew` / `confirmCompanyAsMerge`
