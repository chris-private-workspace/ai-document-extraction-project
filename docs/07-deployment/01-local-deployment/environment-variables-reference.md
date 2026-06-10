# 環境變數完整參考

> **建立日期**: 2026-04-22（CHANGE-054）
> **對應範本**: 專案根目錄 `.env.example`（41 個變數）
> **適用環境**: 本地開發

本文件是 `.env.example` 的**擴充版本**，對每個變數提供：用途、生成方式、placeholder 說明、缺失影響、相關代碼位置。

---

## 📊 分級總覽

| 等級 | 數量 | 缺失影響 |
|------|------|---------|
| 🔴 **必要** | 11 | 應用無法啟動 |
| 🟡 **功能相關** | 17 | 特定功能不可用（但應用可啟動） |
| 🟢 **可選** | 13 | 完全不影響（退回 fallback 或不啟用該功能） |

---

## 🔴 必要變數（11 個）

### 1. `DATABASE_URL`

| 項目 | 值 |
|------|------|
| **用途** | PostgreSQL 連線字串 |
| **預設值** | `postgresql://postgres:postgres@localhost:5433/ai_document_extraction?schema=public` |
| **⚠️ 常見錯誤** | Port 必須為 `5433`（docker-compose 對外映射），**不是 5432**（容器內部端口） |
| **代碼位置** | `src/lib/prisma.ts`（Prisma Client 單例） |
| **如何驗證** | `npm run verify-environment` 會執行 `SELECT 1` |

### 2. `AUTH_SECRET`

| 項目 | 值 |
|------|------|
| **用途** | NextAuth v5（Auth.js）加密 JWT 的密鑰 |
| **生成方式** | `npx auth secret`（官方工具） |
| **格式** | Base64URL-encoded random string |
| **代碼位置** | `src/lib/auth.config.ts` |
| **⚠️ 輪替風險** | 更換後所有既有 session 失效，使用者需重新登入 |

### 3. `AUTH_URL`

| 項目 | 值 |
|------|------|
| **用途** | NextAuth 的 canonical URL，用於 OAuth callback |
| **本地預設** | `http://localhost:3005` |
| **不同 port 時** | 必須同步改（例：`npm run dev -- -p 3200` 時 → `http://localhost:3200`） |

### 4. `AUTH_TRUST_HOST`

| 項目 | 值 |
|------|------|
| **用途** | 允許非 HTTPS / 非標準 host 處理 auth |
| **本地值** | `"true"`（必須） |
| **生產值** | `"false"` 或不設（因已走 HTTPS） |
| **⚠️ 忘記設的症狀** | Login 後 JWT 無法解密、API 返回 401 |

### 5. `JWT_SECRET`

| 項目 | 值 |
|------|------|
| **用途** | 自定義 JWT 簽名密鑰（非 NextAuth，用於 API Key / Webhook 認證） |
| **生成方式** | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| **格式** | 32-char hex |
| **代碼位置** | `src/services/api-key.service.ts`、`src/services/webhook.service.ts` |

### 6. `JWT_EXPIRES_IN`

| 項目 | 值 |
|------|------|
| **用途** | JWT token 過期時間 |
| **預設** | `"7d"`（7 天） |
| **格式** | [Vercel ms](https://github.com/vercel/ms) 格式：`"7d"` / `"12h"` / `"30m"` |

### 7. `SESSION_SECRET`

| 項目 | 值 |
|------|------|
| **用途** | Session 加密密鑰（與 AUTH_SECRET 分離，用於 Cookie session） |
| **生成方式** | 同 JWT_SECRET |
| **格式** | 32-char hex |

### 8. `ENCRYPTION_KEY`

| 項目 | 值 |
|------|------|
| **用途** | 敏感資料對稱加密（API keys、整合憑證、PII 欄位） |
| **生成方式** | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| **格式** | 32-char hex |
| **代碼位置** | `src/services/encryption.service.ts` |
| **🔴 重要警告** | **一旦設定後不可變更**！變更會讓所有既有加密資料無法解密。若必須輪替，需先解密 → 換 key → 重新加密 |

### 9. `SYSTEM_USER_ID`（FIX-054）

| 項目 | 值 |
|------|------|
| **用途** | Server-side 操作的系統用戶 ID（company auto-create、batch processing、SharePoint/Outlook 抓取、Issuer Identification 預設值） |
| **全新環境** | `"system-user-1"`（由 `prisma/seed.ts` 建立的固定 ID） |
| **既有環境** | 若 DB 中 system user 已有不同 UUID，設為該 UUID 避免資料遷移 |
| **查詢方式** | `SELECT id FROM users WHERE email = 'system@ai-document-extraction.internal';` |
| **代碼位置** | `src/services/company-auto-create.service.ts:103` |
| **驗證** | `npm run verify-environment` 會檢查此 ID 對應的 User 存在 |

### 10. `NEXT_PUBLIC_APP_URL`

| 項目 | 值 |
|------|------|
| **用途** | 前端可見的應用 URL（用於郵件通知中的連結等） |
| **本地預設** | `http://localhost:3005` |
| **注意** | `NEXT_PUBLIC_` 前綴會暴露到 client-side bundle，不放敏感值 |

### 11. `NODE_ENV`

| 項目 | 值 |
|------|------|
| **用途** | Node.js 標準環境識別 |
| **可選值** | `"development"` / `"production"` / `"test"` |
| **影響** | Next.js build 優化、錯誤訊息詳略、`auth.ts` / `auth.config.ts` 的 dev mode bypass |
| **🔴 生產檢查（CHANGE-077）** | 生產環境**必須**設為 `"production"`。若誤用 `"development"`，將啟用 `X-Dev-Bypass-Auth` header 後門與「Azure AD 未配置時免密碼登入」。**部署前務必驗證 `NODE_ENV=production`。** |

---

## 🟡 功能相關變數（17 個）

### Azure AD SSO（3 個）
- `AZURE_AD_CLIENT_ID` / `AZURE_AD_CLIENT_SECRET` / `AZURE_AD_TENANT_ID`
- **缺少影響**：**僅當 `NODE_ENV=development`** 時進入 dev mode（接受任何含 `@` 的 email 登入，不需密碼）。生產環境（`NODE_ENV=production`）即使未配置仍走真實密碼驗證（CHANGE-077）
- **來源**：Azure Portal → App Registrations
- **代碼**：`src/lib/auth.config.ts`

### Azure Blob Storage（2 個）
- `AZURE_STORAGE_CONNECTION_STRING` / `AZURE_STORAGE_CONTAINER`
- **缺少影響**：文件上傳失敗
- **本地**：使用 Azurite 模擬器連接字串（已在 `.env.example` 提供）
- **生產**：Azure Portal → Storage Account → Access Keys

### Azure Document Intelligence（2 個）
- `AZURE_DI_ENDPOINT` / `AZURE_DI_KEY`
- **缺少影響**：OCR 文字識別不可用
- **用於**：`src/services/azure-di.service.ts`、Python `ai-doc-extraction-ocr` 容器

### Python Microservices（2 個）
- `OCR_SERVICE_URL` / `MAPPING_SERVICE_URL`
- **預設**：`http://localhost:8000` / `http://localhost:8001`（由 docker-compose 提供）
- **缺少影響**：OCR 或 Mapping 呼叫失敗
- **變更時機**：僅當 container port 對應改變

### Azure OpenAI（4 個）
- `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_DEPLOYMENT_NAME` / `AZURE_OPENAI_API_VERSION`
- **用途**：GPT-5.2 Vision OCR、欄位提取、術語分類
- **缺少影響**：AI 功能完全不可用
- **定價**：Input $1.75/1M tokens / Output $14/1M tokens（見 `.env.example` 註解）

### Azure OpenAI 多模型路由（2 個，可選）
- `AZURE_OPENAI_MINI_DEPLOYMENT_NAME` / `AZURE_OPENAI_NANO_DEPLOYMENT_NAME`
- **用途**：成本優化（簡單任務用 mini / nano 模型）
- **缺少時 fallback**：統一使用 `AZURE_OPENAI_DEPLOYMENT_NAME`

### V3 Extraction Pipeline Flags（5 個）
- `FEATURE_EXTRACTION_V3` — 啟用 V3 三階段管線
- `FEATURE_EXTRACTION_V3_1` — 啟用 V3.1 升級
- `FEATURE_EXTRACTION_V3_1_FALLBACK` — V3.1 失敗降回 V3
- `FEATURE_EXTRACTION_V3_PERCENTAGE` — V3 啟用比例（0-100）
- `FEATURE_EXTRACTION_V3_1_PERCENTAGE` — V3.1 啟用比例
- **用途**：逐步上線控制
- **代碼**：`src/services/extraction-v3/` 各服務

### Unified Document Processor（1 個）
- `ENABLE_UNIFIED_PROCESSOR`
- **值**：`"true"` 啟用 11-step unified pipeline / `"false"` 舊版 OCR-only
- **代碼**：`src/services/unified-processor/unified-document-processor.service.ts`

---

## 🟢 可選變數（13 個）

### Upstash Redis（2 個）
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
- **缺少影響**：Rate limit 退回 in-memory Map（FIX-052 修復的邏輯）
- **僅單實例有效**，多實例部署需設定
- **來源**：https://console.upstash.com/

### n8n 工作流整合（2 個）
- `N8N_BASE_URL` / `N8N_API_KEY`
- **缺少影響**：工作流自動化、webhook 觸發不可用

### Microsoft Graph（SharePoint / Outlook，3 個）
- `MICROSOFT_GRAPH_CLIENT_ID` / `_CLIENT_SECRET` / `_TENANT_ID`
- **缺少影響**：SharePoint 文件抓取、Outlook 郵件監控不可用
- **來源**：Azure Portal → App Registrations（與 Azure AD SSO 分開註冊）

### 密碼雜湊（1 個）
- `BCRYPT_SALT_ROUNDS`
- **預設**：`"12"`（範圍 10-14）
- **影響**：數值越高越安全但登入越慢

### 偵錯旗標（2 個）
- `DEBUG_EXTRACTION_V3_PROMPT` / `DEBUG_EXTRACTION_V3_RESPONSE`
- **用途**：V3 extraction 在日誌中輸出完整 Prompt / Response
- **⚠️ 警告**：**生產環境務必關閉**（會洩漏敏感資料到日誌）

### 其他（3 個）
- `AZURE_OPENAI_TENANT_ID`（Token-based auth，代替 API key）
- `DOCKER_HOST`（⚠️ 若指向舊式 `tcp://localhost:2375` 會讓 Docker 指令失敗，建議 unset — 見 `project-initialization-guide.md` 問題 9）

---

## 🔧 生成敏感值的標準指令

```bash
# 32-char hex（用於 JWT_SECRET / SESSION_SECRET / ENCRYPTION_KEY）
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# NextAuth AUTH_SECRET
npx auth secret

# 其他長度
node -e "console.log(require('crypto').randomBytes(64).toString('base64url'))"
```

---

## 🛡️ Placeholder 偵測

`scripts/verify-environment.ts` 會偵測以下 pattern 並報 critical：

```typescript
/your-.*-change-in-production/i
/^your-/i
/^change-me$/i
```

這是為了避免新環境忘記改 `.env`。若偵測到，`verify-environment` 會輸出：

```
❌ Env var AUTH_SECRET uses placeholder value
   目前值類似 "your-nextauth-secret-key-change-in-production..."。請改為實際值
```

---

## 🔗 相關文件

- 範本：`.env.example`（專案根目錄）
- 驗證腳本：`scripts/verify-environment.ts`
- NextAuth 配置：`src/lib/auth.config.ts`
- Prisma Client：`src/lib/prisma.ts`
- 主要指南：[`project-initialization-guide.md`](./project-initialization-guide.md)
- FIX-054 遷移：`claudedocs/4-changes/bug-fixes/FIX-054-*.md`
