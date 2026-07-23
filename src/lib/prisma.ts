/**
 * @fileoverview Prisma 資料庫客戶端單例配置
 * @description
 *   本模組配置 Prisma 客戶端，確保在開發環境中不會創建多個資料庫連接。
 *   採用全局單例模式，避免 Next.js 熱重載時產生連接洩漏問題。
 *
 *   設計考量：
 *   - 開發環境：將客戶端存儲在 globalThis 中以跨熱重載保持連接
 *   - 生產環境：每次創建新實例，由進程管理生命週期
 *   - 日誌級別：開發時輸出查詢日誌，生產僅輸出錯誤
 *   - Prisma 7.x：使用 driver adapter 進行資料庫連接
 *
 * @module src/lib/prisma
 * @author Development Team
 * @since Epic 1 - Story 1.0 (Project Init Foundation)
 * @lastModified 2025-12-18
 *
 * @features
 *   - 開發環境熱重載支援
 *   - 環境感知的日誌配置
 *   - 類型安全的客戶端導出
 *   - Prisma 7.x driver adapter 支援
 *
 * @dependencies
 *   - @prisma/client - Prisma ORM 客戶端
 *   - @prisma/adapter-pg - PostgreSQL driver adapter
 *   - pg - PostgreSQL 客戶端
 *
 * @related
 *   - prisma/schema.prisma - 資料庫 Schema 定義
 *   - src/app/api/ - API 路由（使用此客戶端）
 */

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * 創建 Prisma 客戶端實例
 * Prisma 7.x 需要使用 driver adapter
 */
function createPrismaClient(): PrismaClient {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // CHANGE-098: 連線韌性設定。降低私有端點閒置連線被網路層默默切斷造成的
    // "Connection terminated unexpectedly" 硬失敗（見 CHANGE-098 根因查證）。
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // FIX-132: pool 上限 10 在 extraction pipeline 併發下會被佔滿，其他查詢/交易
    // 在 maxWait 內取不到連線 → Prisma P2028「Unable to start a transaction」
    // （Azure log 證實）。調高到 20（安全低於 Azure PG max_connections=50，留餘裕
    // 給 admin/migration/多實例；本地 PG 預設 100 亦無虞）。
    max: 20,
  })

  // CHANGE-098: 監聽閒置 client 錯誤，避免 pg Pool 的 'error' 事件無 listener 時
  // 變成未捕捉例外拖垮整個進程。
  pool.on('error', (err) => {
    console.error('[prisma] idle pg pool client error:', err.message)
  })

  const adapter = new PrismaPg(pool)

  return new PrismaClient({
    adapter,
    // FIX-132: 私有端點連線取得延遲較高，預設 maxWait 2s / timeout 5s 太緊，
    // 併發負載下互動式交易易報 P2028。放寬到 maxWait 10s / timeout 20s。
    transactionOptions: {
      maxWait: 10_000,
      timeout: 20_000,
    },
    // FIX-100: dev 預設不記錄 query log。處理 pipeline 會跑數十個查詢，每個 'query' log 都是
    // 一次同步 console.log（stdout 被導向檔案時更會累積阻塞主 event loop），拖慢上傳後的
    // documents 載入。需逐查詢除錯時設 PRISMA_QUERY_LOG=true 開回。生產不受影響（本就只 error）。
    log:
      process.env.NODE_ENV === 'development'
        ? process.env.PRISMA_QUERY_LOG === 'true'
          ? ['query', 'error', 'warn']
          : ['error', 'warn']
        : ['error'],
  })
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

export default prisma
