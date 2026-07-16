-- CHANGE-103 Phase 2（組件 4）：companies 加 suspected_duplicate_of_id
-- 灰帶 JIT 建 PENDING 時記錄「疑似重複於」目標公司，供人工審核。純加 nullable 欄位（向後相容）。

-- AlterTable
ALTER TABLE "companies" ADD COLUMN "suspected_duplicate_of_id" TEXT;

-- CreateIndex
CREATE INDEX "companies_suspected_duplicate_of_id_idx" ON "companies"("suspected_duplicate_of_id");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_suspected_duplicate_of_id_fkey" FOREIGN KEY ("suspected_duplicate_of_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
