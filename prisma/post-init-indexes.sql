-- ============================================================================
-- Prisma 無法在 schema 中表示的 DB 物件 —— 追加於 init.sql 尾端（見 Dockerfile）
-- ----------------------------------------------------------------------------
-- init.sql 由 `prisma migrate diff --from-empty --to-schema` 生成，只涵蓋 Prisma
-- schema 能表示的內容。以下物件必須額外追加，否則**全新空庫不會有它們**。
--
-- 冪等：可重複套用。
-- 同步要求：本檔內容須與對應的 prisma/migrations/*/migration.sql 及
--           prisma/apply-schema-drift.js 條目保持一致（三處分別服務
--           新空庫 / 本地 migrate 路徑 / 既有非空庫）。
-- ============================================================================

-- FIX-133: template_field_mappings 的唯一性
--
-- 原 @@unique([dataTemplateId, scope, companyId, documentFormatId]) 因 PostgreSQL
-- 預設 NULLS DISTINCT 而對任何範圍都不生效 —— companyId 與 documentFormatId 皆為
-- nullable，且每種 scope 都必然使其中至少一欄為 NULL（GLOBAL 兩個、COMPANY 與
-- FORMAT 各一個），故該約束從未擋下任何重複（2026-07-25 實測建出兩筆身分完全相同
-- 的記錄回 201）。
--
-- 改以 NULLS NOT DISTINCT 讓 NULL 參與唯一性比較，並限定 is_active = true：
--   * 對應 template-field-mapping.service.ts create() 的重複檢查條件（四元組 + isActive）
--   * 保留「停用舊配置、建立新配置」的既有使用模式（既有資料確實這樣用）
DROP INDEX IF EXISTS "template_field_mappings_data_template_id_scope_company_id_d_key";

CREATE UNIQUE INDEX IF NOT EXISTS "template_field_mappings_active_unique"
  ON "template_field_mappings" ("data_template_id", "scope", "company_id", "document_format_id")
  NULLS NOT DISTINCT
  WHERE "is_active" = true;
