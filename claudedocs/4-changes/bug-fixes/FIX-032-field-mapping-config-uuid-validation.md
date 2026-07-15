# FIX-032: Field Mapping Config API UUID 驗證錯誤

> **狀態**: ✅ 已修復

## 問題描述

**發現日期**: 2026-01-21
**影響範圍**: Field Mapping Config 管理功能 (Epic 13)
**嚴重程度**: 高

### 症狀

在 `http://localhost:3000/en/admin/field-mapping-configs/new` 頁面嘗試創建新的 Field Mapping Configuration 時：
- 選擇 Configuration Scope 為 `COMPANY`
- 選擇公司（例如 MSC）
- 添加映射規則
- 點擊 Save

返回 **400 Bad Request** 錯誤：

```
POST http://localhost:3000/api/v1/field-mapping-configs 400 (Bad Request)
Error: Invalid request body
```

---

## 根本原因分析

### 問題核心

API 的 Zod 驗證 schema 使用 `z.string().cuid()` 來驗證 `companyId` 和 `documentFormatId` 欄位，但資料庫中的 ID 實際上是 **UUID 格式**，而不是 CUID 格式。

### 格式差異

| 格式 | 範例 |
|------|------|
| **CUID** | `cln1234567890abcdefghijk` |
| **UUID** | `bacdbc1d-cf5b-4a87-a32a-5a677d17d2d2` |

### 問題代碼

**檔案**: `src/app/api/v1/field-mapping-configs/route.ts`

```typescript
// 原始代碼 (錯誤)
const createConfigSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  scope: z.nativeEnum(FieldMappingScope).default(FieldMappingScope.GLOBAL),
  companyId: z.string().cuid().optional().nullable(),      // ❌ 使用 cuid()
  documentFormatId: z.string().cuid().optional().nullable(), // ❌ 使用 cuid()
  isActive: z.boolean().default(true),
});
```

當前端傳送 `companyId: "bacdbc1d-cf5b-4a87-a32a-5a677d17d2d2"` 時，Zod 的 `cuid()` 驗證失敗，導致 400 錯誤。

---

## 修復內容

### 修復方案

將所有 `.cuid()` 驗證改為 `.uuid()` 以匹配實際的 ID 格式。

### 修改的檔案

| 檔案 | Schema | 修改項目 |
|------|--------|----------|
| `src/app/api/v1/field-mapping-configs/route.ts` | `listQuerySchema` | `companyId`, `documentFormatId` |
| `src/app/api/v1/field-mapping-configs/route.ts` | `createConfigSchema` | `companyId`, `documentFormatId` |
| `src/app/api/v1/field-mapping-configs/[id]/route.ts` | `updateConfigSchema` | `companyId`, `documentFormatId` |
| `src/app/api/v1/field-mapping-configs/[id]/test/route.ts` | `testRequestSchema` | `companyId`, `documentFormatId` |

### 代碼變更

#### 1. route.ts - listQuerySchema

```typescript
// 修復前
const listQuerySchema = z.object({
  scope: z.nativeEnum(FieldMappingScope).optional(),
  companyId: z.string().cuid().optional(),
  documentFormatId: z.string().cuid().optional(),
  // ...
});

// 修復後
const listQuerySchema = z.object({
  scope: z.nativeEnum(FieldMappingScope).optional(),
  companyId: z.string().uuid().optional(),
  documentFormatId: z.string().uuid().optional(),
  // ...
});
```

#### 2. route.ts - createConfigSchema

```typescript
// 修復前
const createConfigSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  scope: z.nativeEnum(FieldMappingScope).default(FieldMappingScope.GLOBAL),
  companyId: z.string().cuid().optional().nullable(),
  documentFormatId: z.string().cuid().optional().nullable(),
  isActive: z.boolean().default(true),
});

// 修復後
const createConfigSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  scope: z.nativeEnum(FieldMappingScope).default(FieldMappingScope.GLOBAL),
  companyId: z.string().uuid().optional().nullable(),
  documentFormatId: z.string().uuid().optional().nullable(),
  isActive: z.boolean().default(true),
});
```

#### 3. [id]/route.ts - updateConfigSchema

```typescript
// 修復前
const updateConfigSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  scope: z.nativeEnum(FieldMappingScope).optional(),
  companyId: z.string().cuid().optional().nullable(),
  documentFormatId: z.string().cuid().optional().nullable(),
  isActive: z.boolean().optional(),
  version: z.number().int().positive(),
});

// 修復後
const updateConfigSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  scope: z.nativeEnum(FieldMappingScope).optional(),
  companyId: z.string().uuid().optional().nullable(),
  documentFormatId: z.string().uuid().optional().nullable(),
  isActive: z.boolean().optional(),
  version: z.number().int().positive(),
});
```

#### 4. [id]/test/route.ts - testRequestSchema

```typescript
// 修復前
const testRequestSchema = z.object({
  sampleData: z.record(z.string(), z.unknown()).optional(),
  companyId: z.string().cuid().optional(),
  documentFormatId: z.string().cuid().optional(),
});

// 修復後
const testRequestSchema = z.object({
  sampleData: z.record(z.string(), z.unknown()).optional(),
  companyId: z.string().uuid().optional(),
  documentFormatId: z.string().uuid().optional(),
});
```

---

## 測試驗證

### 測試步驟

1. 啟動開發服務器
   ```bash
   npm run dev
   ```

2. 訪問 `http://localhost:3000/en/admin/field-mapping-configs/new`

3. 執行以下操作：
   - Configuration Scope: 選擇 `Company`
   - Company: 選擇任意公司（例如 MSC）
   - 點擊 "Add Rule" 添加映射規則
   - 選擇 Source Field（例如：發票日期 InvoiceDate）
   - 選擇 Target Field（例如：Invoice Date）
   - 點擊 Rule Editor 中的 Save
   - 點擊主面板的 Save

### 預期結果

- ✅ 配置創建成功
- ✅ 頁面跳轉到列表頁面
- ✅ 顯示成功通知 "Create Successful"
- ✅ 新配置出現在列表中

### 實際測試結果

- ✅ 已通過驗證
- 成功創建配置：`Company Mapping Configuration (bacdbc1d-cf5b-4a87-a32a-5a677d17d2d2)`
- Scope: Company
- Rules: 1
- Status: Active

---

## 影響範圍

### 受影響的功能

| 功能 | API 端點 | 狀態 |
|------|----------|------|
| 創建配置 | `POST /api/v1/field-mapping-configs` | ✅ 已修復 |
| 查詢配置列表 | `GET /api/v1/field-mapping-configs` | ✅ 已修復 |
| 更新配置 | `PATCH /api/v1/field-mapping-configs/[id]` | ✅ 已修復 |
| 測試配置 | `POST /api/v1/field-mapping-configs/[id]/test` | ✅ 已修復 |

### 不受影響的功能

- 刪除配置（不涉及 companyId/documentFormatId 驗證）
- 規則 CRUD 操作（使用配置 ID，非 company/format ID）

---

## 根本原因追溯

### 為何使用了錯誤的 ID 格式？

1. **Prisma Schema 定義**: 原始 schema 中 Company 和 DocumentFormat 模型使用 `@default(cuid())` 生成 ID
2. **資料庫遷移歷史**: 後續遷移可能改用了 UUID 格式，或者種子數據使用了 UUID
3. **API 驗證未同步**: API 的 Zod schema 仍然假設使用 CUID 格式

### 建議後續行動

1. **審查其他 API**: 檢查其他 API 路由是否有類似的 ID 格式驗證問題
2. **統一 ID 策略**: 確認項目是使用 CUID 還是 UUID，並保持一致
3. **添加整合測試**: 添加測試確保 API 驗證與實際數據格式匹配

---

## 相關文件

- **Epic 13**: 文件預覽與欄位映射
- **Story 13-4**: 映射配置 API
- `src/app/api/v1/field-mapping-configs/` - 相關 API 路由
- `prisma/schema.prisma` - 資料庫模型定義

---

**修復人員**: Claude AI Assistant
**修復日期**: 2026-01-21
**驗證狀態**: ✅ 已驗證通過
