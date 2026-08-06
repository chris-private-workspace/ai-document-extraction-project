# i18n 目錄 - 國際化配置

> **框架**: next-intl 4.7
> **支援語言**: en, zh-TW, zh-CN
> **命名空間**: **41** 個（與 `messages/{locale}/*.json` 檔數一致，已於 2026-08-06 核對）
> **最後更新**: 2026-08-06
> **版本**: 1.1.0

---

## 概述

本目錄包含 next-intl 國際化框架的核心配置文件，共 3 個文件，各有明確職責。

---

## 文件清單

### `config.ts` — 語言配置常數

**用途**: 定義支援語言、預設語言、顯示名稱

| 導出 | 類型 | 說明 |
|------|------|------|
| `locales` | `readonly ['en', 'zh-TW', 'zh-CN']` | 支援語言列表 |
| `Locale` | Type | 語言代碼類型 |
| `defaultLocale` | `'en'` | 預設語言 |
| `localeNames` | `Record<Locale, string>` | 語言顯示名稱 |
| `localeHtmlLang` | `Record<Locale, string>` | HTML lang 屬性值 |
| `isValidLocale()` | Function | 驗證 locale 是否有效 |

### `routing.ts` — 路由配置

**用途**: 定義 i18n-aware 的導航函數

| 導出 | 說明 |
|------|------|
| `routing` | next-intl 路由配置（`localePrefix: 'always'`） |
| `Link` | i18n-aware 的 Link 組件 |
| `redirect` | i18n-aware 的 redirect 函數 |
| `usePathname` | i18n-aware 的 usePathname Hook |
| `useRouter` | i18n-aware 的 useRouter Hook |
| `getPathname` | 伺服器端路徑取得 |

> **重要**: 組件中必須使用 `@/i18n/routing` 的 `Link` 和 `useRouter`，**不要**使用 `next/link` 和 `next/navigation`。

### `request.ts` — Server-side 翻譯載入

**用途**: 載入所有命名空間的翻譯文件

| 功能 | 說明 |
|------|------|
| `namespaces` 陣列 | 定義所有 41 個命名空間 |
| `Namespace` 類型 | 命名空間類型 |
| 動態載入 | `import(../../messages/${locale}/${ns}.json)` |
| Fallback | 找不到翻譯時回退到 `en` |
| 時區 | `Asia/Taipei` |

> **關鍵**: 新增命名空間時，除了建立 3 個語言 JSON 外，**必須在此文件的 `namespaces` 陣列中加入新名稱**，否則翻譯不會被載入。

---

## 語言偵測優先級

```
1. URL 路徑中的 locale（/zh-TW/dashboard）
2. 用戶資料庫偏好（已登入）
3. LocalStorage 偏好
4. 瀏覽器 Accept-Language
5. 預設語言（en）
```

---

## 相關文件

| 文件 | 用途 |
|------|------|
| `messages/` | 翻譯 JSON 文件（31 命名空間 × 3 語言） |
| `src/lib/i18n-date.ts` | 日期格式化工具 |
| `src/lib/i18n-number.ts` | 數字格式化工具 |
| `src/lib/i18n-currency.ts` | 貨幣格式化工具 |
| `src/lib/i18n-zod.ts` | Zod 驗證國際化 |
| `src/lib/i18n-api-error.ts` | API 錯誤國際化 |
| `src/hooks/use-locale-preference.ts` | 語言偏好管理 |
| `src/hooks/use-localized-*.ts` | 本地化 Hooks（4 個） |
| `.claude/rules/i18n.md` | i18n 完整開發規範 |

---

**維護者**: Development Team
**最後更新**: 2026-02-09
**版本**: 1.0.0
