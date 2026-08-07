-- FIX-171 / BUG-7: users 新增登入失敗計數與鎖定時間（防暴力破解）
--
-- 對應 DoD #14「3–5 次失敗後鎖定帳號，並提供明確解鎖途徑」與 QID 150837
-- (Missing Brute Force Protection Mechanism)。
--
-- 策略（使用者 2026-08-07 決定）：連續 5 次密碼錯誤後鎖定，由管理員手動解鎖。
--   - failed_login_attempts：登入成功時歸零；每次密碼驗證失敗 +1
--   - locked_until：NULL 表示未鎖定。手動解鎖模式下寫入一個遠期時間，
--     語義為「需管理員介入」，而非等它自然到期
--
-- 為何不複用 users.status = SUSPENDED：SUSPENDED 的語義是「管理員主動停權」，
-- 與「被暴力破解鎖上」的處置完全不同。混用會永久失去這個區分 —— 管理員看到
-- SUSPENDED 時無法判斷該帳號是人為停權還是自動鎖定，也就無從決定是否該解鎖。
--
-- 同步要求：本檔內容須與 prisma/apply-schema-drift.js 的 FIX-171 條目保持一致
--           （Azure 既有非空庫走該路徑，migrate deploy 不會自動套用）。
--           本變更為純欄位新增、無索引與 enum，故**不需**動 post-init-indexes.sql。
--
-- 冪等：可重複套用。

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "failed_login_attempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locked_until" TIMESTAMP(3);
