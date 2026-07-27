# FIX-013: 術語聚合地址過濾優化

> **狀態**: ✅ 已完成

## 基本資訊

| 項目 | 內容 |
|------|------|
| Bug ID | FIX-013 |
| 發現日期 | 2025-12-30 |
| 修復日期 | 2025-12-30 |
| 嚴重程度 | Medium |
| 影響範圍 | 術語聚合服務 (term-aggregation, batch-term-aggregation, hierarchical-term-aggregation) |
| 相關 Epic | Epic 0 - 歷史數據初始化 |
| 狀態 | ✅ 已完成 |

---

## 問題描述

### 原始問題
術語聚合過程中，大量「地址類」內容被錯誤地聚合為有效術語，導致：
- 術語庫被地址、電話、郵箱等非業務術語污染
- 術語匹配準確度下降
- 報告中出現無意義的「術語」

### 根本原因
原始 `normalizeForAggregation()` 函數未過濾地址類內容，所有 line item description 都被直接聚合。

---

## 解決方案

### FIX-005 (Phase 1): 地址過濾機制

新增 `isAddressLikeTerm()` 函數，識別並過濾以下內容：

#### 1. ADDRESS_KEYWORDS (28 個關鍵詞)
```typescript
const ADDRESS_KEYWORDS = [
  // 英文地址關鍵詞
  'STREET', 'ROAD', 'AVENUE', 'BOULEVARD', 'LANE', 'DRIVE', 'COURT',
  'PLACE', 'SQUARE', 'WARD', 'DISTRICT', 'PROVINCE', 'CITY', 'COUNTY',
  'STATE', 'COUNTRY', 'FLOOR', 'BUILDING', 'TOWER', 'BLOCK', 'UNIT',
  'SUITE', 'APARTMENT', 'ROOM', 'HIGHWAY', 'EXPRESSWAY',
  // 越南語地址關鍵詞
  'DUONG', 'PHO', 'QUAN', 'PHUONG', 'TINH', 'THANH PHO', 'HUYEN', 'XA',
  'TANG', 'TOA NHA', 'CAN HO', 'PHONG', 'KHU', 'KHU PHO', 'AP',
  // 縮寫
  'ST', 'RD', 'AVE', 'BLVD', 'FLR', 'BLDG', 'BLK', 'APT',
];
```

#### 2. LOCATION_NAMES (48 個地名)
```typescript
const LOCATION_NAMES = [
  // 國家
  'VIETNAM', 'VIET NAM', 'CHINA', 'HONG KONG', 'SINGAPORE', 'THAILAND',
  'MALAYSIA', 'INDONESIA', 'PHILIPPINES', 'TAIWAN', 'JAPAN', 'KOREA', ...
  // 城市
  'HO CHI MINH', 'HOCHIMINH', 'SAIGON', 'HANOI', 'HA NOI', 'DA NANG',
  'SHANGHAI', 'BEIJING', 'SHENZHEN', 'GUANGZHOU', 'KOWLOON', ...
];
```

#### 3. ADDRESS_PATTERNS (8 個正則)
```typescript
const ADDRESS_PATTERNS = [
  /\b\d+\s*(?:F|\/F|FL|FLR|FLOOR|TANG)\b/i,  // 樓層: 21F, 3/F
  /\b(?:F|\/F|FL|FLR|FLOOR|TANG)\s*\d+\b/i,  // 樓層: F21, Floor 3
  /\b(?:NO\.?|SO)\s*\d+/i,                     // 門牌: No.123, SO 45
  /^\d+[A-Z]?\s+(?:STREET|ROAD|DUONG|PHO)/i,  // 街道開頭: 123 STREET
  /\b\d{5,6}\b/,                               // 郵遞區號: 12345, 123456
  /^[^,]+,[^,]+,[^,]+/,                        // 多段地址: A, B, C
  /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/, // 電話
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, // 郵箱
];
```

---

### FIX-005.1 (Phase 2): 貨幣代碼例外

#### 問題發現
Phase 1 實施後發現**誤過濾問題**：包含匯率數字的價格行被錯誤過濾。

**例如：**
- `TERMINAL HANDLING CHARGE AT ORIGIN THB 22 905.00 0.247946`
  - `0.247946` 被 `/\b\d{5,6}\b/` 匹配為 `247946`（郵遞區號）
- `FREIGHT CHARGES USD 65.00 7.881487`
  - `7.881487` 被匹配為 `881487`（郵遞區號）

#### 解決方案
新增貨幣代碼檢測，如果術語包含貨幣代碼，跳過 ADDRESS_PATTERNS 檢查：

```typescript
const CURRENCY_CODES = [
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'HKD', 'SGD', 'THB',
  'MYR', 'IDR', 'PHP', 'VND', 'TWD', 'KRW', 'INR', 'AUD',
  'NZD', 'CAD', 'CHF', 'AED', 'SAR', 'KWD', 'BHD', 'QAR',
];

function containsCurrencyCode(term: string): boolean {
  for (const code of CURRENCY_CODES) {
    const pattern = new RegExp(`\\b${code}\\b`, 'i');
    if (pattern.test(term)) return true;
  }
  return false;
}

function isAddressLikeTerm(term: string): boolean {
  const hasCurrency = containsCurrencyCode(upperTerm);

  // ADDRESS_KEYWORDS 和 LOCATION_NAMES 始終檢查
  // ...

  // FIX-005.1: 如果有貨幣代碼，跳過 ADDRESS_PATTERNS
  if (!hasCurrency) {
    for (const pattern of ADDRESS_PATTERNS) {
      if (pattern.test(upperTerm)) return true;
    }
  }

  // 如果有貨幣代碼，也跳過長度檢查
  if (!hasCurrency && upperTerm.length > 80) return true;
}
```

---

## 修改的文件

| 文件 | 變更內容 |
|------|----------|
| `src/services/term-aggregation.service.ts` | 新增地址過濾常數和函數，新增貨幣代碼例外 |
| `src/services/batch-term-aggregation.service.ts` | 從 term-aggregation.service 導入 `isAddressLikeTerm` |
| `src/services/hierarchical-term-aggregation.service.ts` | 從 term-aggregation.service 導入 `isAddressLikeTerm` |
| `scripts/verify-fix-005.ts` | 新增驗證腳本 |

---

## 驗證結果

### TEST-PLAN-003 批次驗證 (112 文件, 417 術語)

| 階段 | 過濾後術語數 | 被過濾數 | 過濾比例 |
|------|-------------|----------|----------|
| 無過濾 (原始) | 417 | 0 | 0% |
| FIX-005 Phase 1 | 333 | 84 | 20.1% |
| FIX-005.1 Phase 2 | 376 | 41 | 9.8% |

### 過濾效果

**正確過濾的內容（41 個）：**
- 完整地址（含城市、街道、樓層等）
- 地名前綴（WW THAILAND, WW VIETNAM）
- 包含多段逗號分隔的地址

**正確保留的內容（+43 個恢復）：**
- 包含貨幣代碼的價格行 (THB, USD, HKD, etc.)
- 費用描述 + 金額 + 匯率

---

## 注意事項

### 邊界情況
以下類型仍會被過濾（屬於預期行為）：

1. **無貨幣代碼的費用行**
   - `SEA SEAL FEE 20F 83.78` - 因 `20F` 匹配樓層模式
   - `SEA THC 20F 809` - 同上

2. **含 6 位數字的參考編號**
   - `THE AIR FREIGHT COST OF 828566` - 因 `828566` 匹配郵遞區號模式

### 後續改進建議
如需進一步減少誤過濾，可考慮：
- 新增 `SEAL FEE`, `THC` 等費用關鍵詞白名單
- 調整郵遞區號模式，排除小數點後的數字

---

## 相關 Commit

```
77aa406 fix(services): add address filtering to term aggregation (FIX-005)
[待提交] fix(services): add currency code exception to address filtering (FIX-005.1)
```

---

*文檔建立: 2025-12-30*
*最後更新: 2025-12-30*
