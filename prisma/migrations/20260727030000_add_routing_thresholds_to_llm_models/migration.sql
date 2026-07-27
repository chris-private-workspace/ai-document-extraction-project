-- Epic 23 Story 23.3 P1（D9-a 方案 A）: llm_models 加 routing_thresholds
-- per-model 信心度路由閾值 { autoApprove, quickReview }；null = 未校準，
-- fallback 至 llm_providers.extra_config.routingThresholds → 全域 90/70（行為零變）。
-- 純加 nullable 欄位（向後相容）。

-- AlterTable
ALTER TABLE "llm_models" ADD COLUMN "routing_thresholds" JSONB;
