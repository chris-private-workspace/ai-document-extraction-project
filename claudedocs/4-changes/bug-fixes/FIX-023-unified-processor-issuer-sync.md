# FIX-023: 統一處理流程發行者識別結果未同步到數據庫

> **狀態**: ✅ 已修復

## 問題描述

使用統一處理流程（UnifiedProcessor）處理文件時，`ISSUER_IDENTIFICATION` 步驟成功識別了發行者並匹配到公司，但結果沒有被同步到 `HistoricalFile` 表的相關欄位。

### 症狀
- `documentIssuerId`: `null`（應有值）
- `issuerIdentificationMethod`: `null`（應有值）
- `issuerConfidence`: `null`（應有值）
- 但 `extractionResult._unifiedProcessorInfo.stepResults` 中的 `ISSUER_IDENTIFICATION` 步驟有正確的 `matchedCompanyId`

### 影響範圍
1. **術語聚合失敗** - `hierarchical-term-aggregation.service.ts` 需要 `documentIssuerId` 不為 null
2. **導出報告為空** - 因為術語無法正確聚合到公司
3. **術語被標記為 "UNKNOWN" 公司** - 在 `batch-term-aggregation.service.ts` 中

## 根本原因

`batch-processor.service.ts` 在更新文件記錄時（Line 811-829），只從舊版的 `companyIdentification` 和 `processFileIssuerIdentification` 結果中提取數據。

當使用統一處理流程時：
- 發行者識別結果存在於 `extractionResult._unifiedProcessorInfo.stepResults[ISSUER_IDENTIFICATION].data`
- 但這些數據沒有被提取並同步到數據庫欄位

```typescript
// 舊代碼只處理 companyIdentification
...(companyIdentification && {
  identifiedCompanyId: companyIdentification.companyId,
  ...
}),
// 註釋說 documentIssuerId 在 processFileIssuerIdentification 中更新
// 但使用 UnifiedProcessor 時不會調用 processFileIssuerIdentification
```

## 修復方案

在文件更新邏輯中，添加從 `_unifiedProcessorInfo.stepResults` 提取 `ISSUER_IDENTIFICATION` 結果的邏輯：

```typescript
// FIX-023: 從統一處理流程結果中提取發行者識別結果
const unifiedProcessorInfo = extractionResult._unifiedProcessorInfo;
const issuerStepResult = unifiedProcessorInfo?.stepResults?.find(
  (s) => s.step === 'ISSUER_IDENTIFICATION'
);
const issuerData = issuerStepResult?.data;

// 在更新時展開
...(issuerData?.matchedCompanyId && {
  documentIssuerId: issuerData.matchedCompanyId,
  issuerIdentificationMethod: issuerData.identificationMethod || null,
  issuerConfidence: issuerData.confidence || null,
}),
```

## 修改文件

| 文件 | 變更 |
|------|------|
| `src/services/batch-processor.service.ts` | 添加從 UnifiedProcessor 結果提取發行者識別數據的邏輯 |

## 驗證方式

1. 重啟開發服務器
2. 創建新批次並上傳 DHL 測試文件
3. 處理完成後檢查文件記錄：

```bash
node -e "
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const pg = require('pg');

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:postgres@localhost:5433/ai_document_extraction'
});

async function main() {
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  // 替換為實際的文件 ID
  const file = await prisma.historicalFile.findFirst({
    where: { batchId: 'YOUR_BATCH_ID' },
    select: {
      documentIssuerId: true,
      issuerIdentificationMethod: true,
      issuerConfidence: true
    }
  });

  console.log('documentIssuerId:', file.documentIssuerId); // 應有值
  console.log('issuerIdentificationMethod:', file.issuerIdentificationMethod); // 應為 'LOGO' 或 'HEADER'
  console.log('issuerConfidence:', file.issuerConfidence); // 應有數值

  await prisma.\$disconnect();
  await pool.end();
}
main();
"
```

4. 驗證導出功能正常工作

## 相關資訊

| 項目 | 值 |
|------|-----|
| 發現日期 | 2026-01-06 |
| 發現於 | CHANGE-006 驗證測試 |
| 關聯 Bug | FIX-022 (CONFIG_FETCHING PromptType) |
| 測試批次 | test change-006 by chris - 2 - 20260106 |

## 連帶影響

修復後，以下功能將正常工作：
1. 術語聚合到正確的公司
2. 階層式術語報告導出
3. 公司-格式-術語三層結構

---

**修復者**: Claude AI
**修復日期**: 2026-01-06
**狀態**: ✅ 已修復
