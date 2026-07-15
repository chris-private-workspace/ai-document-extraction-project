# CHANGE-010: 批次處理並行化優化

> **狀態**: ✅ 已完成

## 變更摘要

| 項目 | 內容 |
|------|------|
| 變更編號 | CHANGE-010 |
| 變更日期 | 2026-01-16 |
| 更新日期 | 2026-01-19 |
| 完成日期 | 2026-01-19 |
| 變更類型 | 效能優化 |
| 影響範圍 | 批次處理服務 (batch-processor.service.ts) |
| 狀態 | ✅ 已完成 |
| Commit | b855aeb |
| 回滾點 | git tag: pre-change-010 (fc58044) |

---

## 變更原因

- 現有批次處理採用**順序處理**，100 個檔案需要約 120 秒
- 希望透過**控制並發**提升處理效率，同時避免 Azure API 速率限制
- 預期將處理時間從 240 小時降至 48 小時（年度）

---

## 架構分析（2026-01-19 深入調查結果）

### 處理流程確認

```
┌─────────────────────────────────────────────────────────────────────┐
│                     歷史數據批次處理流程                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Next.js API ──► batch-processor.service.ts ──► Azure APIs          │
│                        │                           │                │
│                        │                           ├── Azure DI     │
│                        │                           │   (OCR)        │
│                        │                           │                │
│                        │                           └── Azure OpenAI │
│                        │                               (GPT Vision) │
│                        │                                            │
│                        └─► 直接調用 Azure，不經過 Python 服務        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 關鍵發現

1. **batch-processor 不調用 Python 服務**
   - 直接使用 `@azure/ai-document-intelligence` SDK
   - 直接使用 Azure OpenAI SDK
   - Python 服務僅用於日常處理流程（`extraction.service.ts`）

2. **現有代碼確實是順序處理**
   ```typescript
   // batch-processor.service.ts:1071-1072
   for (const file of chunk) {
     const result = await this.processFile(file, { ... });  // 順序等待
   }
   ```

3. **Azure Document Intelligence 限制**
   - 預設：15 TPS (Transactions Per Second)
   - S0 層級可申請提升至 50+ TPS
   - 需要速率控制避免 429 錯誤

4. **p-queue 套件問題**
   - `p-queue` 是 ESM-only 模組，與 CommonJS 項目不兼容
   - 需改用 `p-queue-compat`（提供 CJS 支援）

---

## 變更內容

### 實施方案：p-queue-compat 並發控制

將現有的順序文件處理改為並行處理，提升批次處理效率。

> ⚠️ **方案調整說明**：
> 原方案 C（Uvicorn workers）已移除，因為 batch-processor 不調用 Python 服務。

**預期效果：**
- 處理時間：240 小時 → 48 小時（提升 80%）
- 成本增加：<10%（$450 → $495/月）

---

### 方案 B：客戶端並發控制（p-queue-compat）

**什麼是 p-queue-compat？**
- npm 套件，控制同時執行的任務數量
- 提供 CommonJS 兼容性（解決 ESM-only 問題）
- 確保最多 5 個文件同時處理，避免資源耗盡

**需要修改的文件：**
```
src/services/batch-processor.service.ts  (~40 行修改)
```

**修改內容：**
```typescript
// 安裝套件
npm install p-queue-compat

// 修改 processChunk() 方法
import PQueue from 'p-queue-compat';

const queue = new PQueue({
  concurrency: 5,        // 同時處理 5 個文件
  interval: 1000,        // 每秒
  intervalCap: 10,       // 最多 10 個請求（防止 Azure 429）
});

// 原本的順序處理 (Line 1071-1072)
for (const file of chunk) {
  await processFile(file);  // 一個一個處理
}

// 改為並行處理
const chunkPromises = chunk.map(file =>
  queue.add(() => this.processFile(file, { ... }))
);
const results = await Promise.allSettled(chunkPromises);

// 處理結果
for (const result of results) {
  if (result.status === 'fulfilled') {
    // 成功處理
  } else {
    // 失敗處理，記錄錯誤
  }
}
```

---

## 影響分析

### 需要修改的文件清單

| 文件 | 修改量 | 難度 | 說明 |
|------|-------|------|------|
| `src/services/batch-processor.service.ts` | ~40 行 | ⭐⭐ | 添加並發控制邏輯 |
| `package.json` | 1 行 | ⭐ | 添加 p-queue-compat 依賴 |

### 不需要修改的文件

| 文件 | 原因 |
|------|------|
| ~~`python-services/extraction/main.py`~~ | batch-processor 不調用 Python 服務 |
| `src/services/extraction.service.ts` | 日常處理流程，非本次範圍 |

### 風險與緩解

| 風險 | 可能性 | 緩解措施 |
|------|--------|---------|
| Azure API 429 錯誤 | 低 | p-queue intervalCap 限制為 10/秒 |
| 記憶體溢出 | 低 | 限制並發數 ≤ 5 |
| 資料庫連接耗盡 | 低 | 並發數遠低於連接池大小 |

---

## 實施步驟

### Step 1：安裝 p-queue-compat 套件
```bash
npm install p-queue-compat
```

### Step 2：修改 batch-processor.service.ts
1. 導入 p-queue-compat
2. 在 `processChunk()` 方法中建立並發隊列
3. 將 for-loop 改為 Promise.allSettled + queue.add
4. 添加結果處理邏輯

### Step 3：測試驗證
1. 執行批次處理測試（10 個文件）
2. 監控記憶體使用
3. 確認無 429 錯誤
4. 驗證處理速度提升

---

## 驗證方式

1. **單元測試**：模擬 10 個文件的批次處理
2. **監控**：檢查 `process.memoryUsage()` 確認記憶體穩定
3. **日誌**：確認處理速度提升約 3-4 倍
4. **API 監控**：確認 Azure API 無 429 錯誤

---

## 預期成果

| 指標 | 修改前 | 修改後 |
|------|--------|--------|
| 10 文件處理時間 | ~100 秒 | ~25 秒 |
| 同時處理數 | 1 | 5 |
| 記憶體使用 | ~500MB | ~500MB（不變） |
| 月成本 | $450 | ~$495 |

---

## 回滾方案

如果出現問題，可以快速回滾：

**方法 1：調整並發數**
```typescript
const queue = new PQueue({
  concurrency: 1,  // 恢復順序處理
  // ...
});
```

**方法 2：還原代碼**
```bash
git revert <commit-hash>
```

---

## 未來改進：中途停止機制（本次不實施）

### 現有限制

| 能做到 | 做不到 |
|--------|--------|
| ✅ 標記待處理文件為「已跳過」 | ❌ 立即停止正在處理的文件 |
| ✅ 防止新文件開始處理 | ❌ 中斷進行中的 Azure API 調用 |

### 未來實施方案

**1. 添加 AbortController 支持**
```typescript
// batch-processor.service.ts
const batchAbortControllers = new Map<string, AbortController>()

export async function processBatch(batchId: string) {
  const controller = new AbortController()
  batchAbortControllers.set(batchId, controller)

  try {
    // 傳遞 signal 給 API 調用
    await processFile(file, { signal: controller.signal })
  } finally {
    batchAbortControllers.delete(batchId)
  }
}

export function cancelBatch(batchId: string) {
  const controller = batchAbortControllers.get(batchId)
  if (controller) {
    controller.abort() // 中止所有進行中的請求
  }
}
```

**2. 處理 AbortError**
```typescript
try {
  await processPdfWithAzureDI(filePath, { signal })
} catch (error) {
  if (error.name === 'AbortError') {
    // 標記為 CANCELLED，而不是 FAILED
    await updateFileStatus(fileId, 'CANCELLED')
  }
}
```

### 預估工作量
- 開發時間：1-2 天
- 測試時間：0.5 天
- 風險：低（不影響現有功能）

---

## 相關文件

| 檔案 | 操作 |
|------|------|
| `src/services/batch-processor.service.ts` | 修改 - 添加 p-queue-compat 並發控制 |
| `package.json` | 修改 - 添加 p-queue-compat 依賴 |

---

## 變更歷史

| 日期 | 版本 | 變更內容 |
|------|------|----------|
| 2026-01-16 | 1.0 | 初始方案：B + C 組合 |
| 2026-01-19 | 2.0 | 深入分析後更新：移除方案 C（batch-processor 不調用 Python 服務），改用 p-queue-compat 解決 ESM 兼容性 |
| 2026-01-19 | 2.1 | ✅ 實施完成：Commit b855aeb，新增 p-queue-compat 依賴，修改 batch-processor.service.ts |

---

*變更記錄建立日期: 2026-01-16*
*最後更新日期: 2026-01-19*
