# FIX-033: Template Matching API Zod 驗證 ID 格式不匹配

> **狀態**: ✅ 已完成

## 問題描述

**發現日期**: 2026-01-27
**影響範圍**: Epic 19 - Template Matching API（Story 19.3, 19.7）
**嚴重程度**: 高
**關聯**: 與 FIX-032（Field Mapping Config UUID 驗證錯誤）為同類問題，方向相反
**狀態**: ✅ 已完成

### 症狀

呼叫以下 API 時，傳入有效的 `templateInstanceId`、`dataTemplateId`、`formatId` 會收到 **400 Bad Request**：

- `POST /api/v1/template-matching/execute`
- `POST /api/v1/template-matching/preview`
- `POST /api/v1/template-matching/validate`

---

## 根本原因分析

### 問題核心

`src/validations/template-matching.ts` 中多個 Schema 使用 `z.string().uuid()` 驗證 ID，但對應的 Prisma Model 實際使用 `@default(cuid())` 生成 ID。

### 各 Model 的 ID 格式

| Model | Prisma ID 格式 | Schema 驗證 | 狀態 |
|-------|---------------|-------------|------|
| Document | `@default(uuid())` | `.uuid()` | ✅ 正確 |
| Company | `@default(uuid())` | `.uuid()` | ✅ 正確 |
| TemplateInstance | `@default(cuid())` | `.uuid()` | ❌ 錯誤 |
| DataTemplate | `@default(cuid())` | `.uuid()` | ❌ 錯誤 |
| DocumentFormat | `@default(cuid())` | `.uuid()` | ❌ 錯誤 |

### 格式範例

| 格式 | 範例 |
|------|------|
| **UUID** | `bacdbc1d-cf5b-4a87-a32a-5a677d17d2d2` |
| **CUID** | `cmkw6qjhv0000pcxgb1bymlm2` |

### 問題代碼

**檔案**: `src/validations/template-matching.ts`

```typescript
// executeMatchRequestSchema (line 59-74)
templateInstanceId: z.string().uuid(),  // ❌ TemplateInstance 用 cuid

// previewMatchRequestSchema (line 88-113)
dataTemplateId: z.string().uuid(),      // ❌ DataTemplate 用 cuid
formatId: z.string().uuid().optional(), // ❌ DocumentFormat 用 cuid

// validateMappingRequestSchema (line 127-142)
dataTemplateId: z.string().uuid(),      // ❌ DataTemplate 用 cuid
formatId: z.string().uuid().optional(), // ❌ DocumentFormat 用 cuid
```

**注意**: `batchMatchDocumentsRequestSchema` 和 `singleMatchDocumentRequestSchema` 已正確使用 `.cuid()` — 這表示 Story 19.7 開發時已修正，但 Story 19.3 的 Schema 未同步更新。

---

## 修復內容

### 修復方案

將不匹配的 `.uuid()` 改為 `.cuid()`，同時保留 Document ID 和 Company ID 的 `.uuid()` 驗證。

### 修改的檔案

| 檔案 | Schema | 修改欄位 |
|------|--------|----------|
| `src/validations/template-matching.ts` | `executeMatchRequestSchema` | `templateInstanceId`: uuid → cuid |
| `src/validations/template-matching.ts` | `previewMatchRequestSchema` | `dataTemplateId`, `formatId`: uuid → cuid |
| `src/validations/template-matching.ts` | `validateMappingRequestSchema` | `dataTemplateId`, `formatId`: uuid → cuid |

### 不需修改的欄位

| 欄位 | 原因 |
|------|------|
| `documentIds: z.string().uuid()` | Document 用 UUID ✅ |
| `companyId: z.string().uuid()` | Company 用 UUID ✅ |

---

## 測試驗證

### 驗證方式

使用 CUID 格式的 ID 呼叫以下 API 應返回成功（非 400）：

```bash
# Execute Match
curl -X POST /api/v1/template-matching/execute \
  -d '{"documentIds":["uuid-format"],"templateInstanceId":"cuid-format"}'

# Preview Match
curl -X POST /api/v1/template-matching/preview \
  -d '{"documentIds":["uuid-format"],"dataTemplateId":"cuid-format"}'
```

---

## 關聯

- **FIX-032**: Field Mapping Config API 的相反問題（cuid → uuid）
- **CHANGE-013**: Phase 1 基礎修復中包含此修復
