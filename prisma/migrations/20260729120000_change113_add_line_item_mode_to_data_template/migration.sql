-- CHANGE-113 階段二：data_templates 加 line_item_mode
-- 決定一份文件在模板實例中展開成幾列：
--   PIVOT  = 1 份文件 1 列，費用按分類聚合為欄（現況，預設值）
--   EXPAND = 1 筆費用 1 列（尚未實作，行為同 PIVOT）
--   GROUP  = 1 個分組鍵 1 列（一份發票對應多個 shipment）
-- 有預設值，既有資料自動落在 PIVOT，向後相容。

-- AlterTable
ALTER TABLE "data_templates" ADD COLUMN "line_item_mode" VARCHAR(20) NOT NULL DEFAULT 'PIVOT';
