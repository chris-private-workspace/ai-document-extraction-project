# FIX-103: 公司 i18n 遺留修正（Forwarder→Company 翻譯 + 新增頁硬編碼中文）

> **日期**: 2026-07-06
> **狀態**: 🔬 待 E2E 驗證（實作完成、type-check/i18n:check/lint 通過；使用者自行測試中）
> **優先級**: Medium
> **類型**: Bug Fix / i18n
> **影響範圍**: companies 命名空間三語言、/companies/new 頁面

---

## 問題描述

1. `/en/companies/new` 的建立按鈕顯示 `Create Forwarder`（應為 `Create Company`），表單標題/描述亦為 Forwarder（REFACTOR-001 翻譯遺留）。
2. `/companies/new` 頁面標題、副標題、返回連結、metadata 為硬編碼中文，英文介面也顯示中文。

## 根因

1. 三語言 `companies.json` 的 `form.title` / `form.editTitle` / `form.description` / `form.submit` 仍是 Forwarder / 貨代商（REFACTOR-001 未同步）。
2. `new/page.tsx` 未使用 i18n，直接硬編碼中文。

## 修復

1. 三語言 `companies.json`：上述 4 個 form key 由 Forwarder / 貨代商 → Company / 公司；新增 `companies.new.*`（pageTitle / metaDescription / backToList / title / subtitle）。（`companyType.forwarder` 為合法公司類型標籤，保留。）
2. `new/page.tsx`：改用 `getTranslations`（companies.new 命名空間），metadata 改為 `generateMetadata`。

## 修改範圍

| 檔案 | 變更 |
|------|------|
| `messages/{en,zh-TW,zh-CN}/companies.json` | form 4 key 修正 + 新增 new 區塊 |
| `src/app/[locale]/(dashboard)/companies/new/page.tsx` | 硬編碼中文 → i18n |

## 驗證

- `npm run type-check` → exit 0
- `npm run i18n:check` → exit 0（companies 三語言同步通過）
- `npx eslint`（new/page.tsx）→ exit 0
- **待 E2E**：`/en/companies/new` 全英文顯示、建立按鈕為 `Create Company`。

## 與其他變更的關係

- 與 CHANGE-095、FIX-102 同屬本次 `/companies/new` 與公司表單的處理，性質獨立（純 i18n / 文案）。
