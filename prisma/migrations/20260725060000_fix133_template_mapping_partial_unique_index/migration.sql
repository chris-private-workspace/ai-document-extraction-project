-- FIX-133: template_field_mappings 唯一性改為 NULLS NOT DISTINCT 的部分唯一索引
--
-- 原 @@unique([dataTemplateId, scope, companyId, documentFormatId], name: "unique_template_mapping")
-- 因 PostgreSQL 預設 NULLS DISTINCT 而對任何範圍都不生效：companyId 與 documentFormatId
-- 皆為 nullable，且每種 scope 都必然使其中至少一欄為 NULL（GLOBAL 兩個、COMPANY 與
-- FORMAT 各一個），因此該唯一索引從未擋下任何重複。
--
-- 改以 NULLS NOT DISTINCT 讓 NULL 參與唯一性比較，並限定 is_active = true：
--   * 對應 template-field-mapping.service.ts create() 的重複檢查（四元組 + isActive: true）
--   * 保留「停用舊配置、建立新配置」的既有使用模式，故既有停用列不受約束、無需刪除
--
-- Prisma 7.2 不支援 nullsNotDistinct 亦不支援部分索引，故 schema.prisma 已移除該
-- @@unique，唯一性完全由本索引保證。⚠️ 不要把 @@unique 加回 schema —— 那會讓
-- prisma migrate 重建無效的全表唯一索引。
--
-- 同步要求：本檔內容須與 prisma/post-init-indexes.sql（新空庫）及
--           prisma/apply-schema-drift.js（既有非空庫）保持一致。
--
-- 冪等：可重複套用。

DROP INDEX IF EXISTS "template_field_mappings_data_template_id_scope_company_id_d_key";

CREATE UNIQUE INDEX IF NOT EXISTS "template_field_mappings_active_unique"
  ON "template_field_mappings" ("data_template_id", "scope", "company_id", "document_format_id")
  NULLS NOT DISTINCT
  WHERE "is_active" = true;
