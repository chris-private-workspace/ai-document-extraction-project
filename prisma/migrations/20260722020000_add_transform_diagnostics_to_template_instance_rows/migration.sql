-- FIX-128: template_instance_rows 加 transform_diagnostics
-- 記錄轉換診斷（targetField → 引用了 row 中不存在的來源 key 清單）。純加 nullable 欄位（向後相容）。

-- AlterTable
ALTER TABLE "template_instance_rows" ADD COLUMN "transform_diagnostics" JSONB;
