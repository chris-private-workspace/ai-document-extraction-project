-- CHANGE-109: extraction_results 新增可索引的 invoice_number
--
-- 反正規化 fieldMappings JSON 內的 invoice_number，供「同一發票是否有更新的文件記錄」
-- 查詢走索引。JSON 內的原值仍是真相來源，本欄位只是可索引副本。
--
-- 為何不用 JSON path + functional index：Prisma 7.2 表達不出 functional index，會重演
-- FIX-133 那種 raw SQL 三處同步的維護負擔；而 FIX-132 剛示範過未索引熱查詢的代價
-- （連線池耗盡 P2028）。
--
-- 索引欄位順序＝查詢條件順序（company_id 等值 + invoice_number 等值）。
--
-- 同步要求：本檔內容須與 prisma/apply-schema-drift.js 的 CHANGE-109 條目保持一致
--           （既有非空庫走該路徑；全新空庫由 schema 生成的 init.sql 涵蓋，因 Prisma
--            能表達本欄位與索引，故**不需**動 post-init-indexes.sql）。
--
-- 冪等：可重複套用。

ALTER TABLE "extraction_results" ADD COLUMN IF NOT EXISTS "invoice_number" TEXT;

CREATE INDEX IF NOT EXISTS "extraction_results_company_id_invoice_number_idx"
  ON "extraction_results" ("company_id", "invoice_number");
