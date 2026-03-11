-- Epic H: DBカラム監査 — 冪等キー・監査カラム追加

-- ReceiptIssue: idempotencyKey（重複発行防止）
ALTER TABLE "ReceiptIssue"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptIssue_idempotencyKey_key"
  ON "ReceiptIssue"("idempotencyKey");

-- Settlement: idempotencyKey（重複精算防止）
ALTER TABLE "Settlement"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Settlement_idempotencyKey_key"
  ON "Settlement"("idempotencyKey");

-- SalesSummaryCacheDaily: createdAt（監査カラム補完）
ALTER TABLE "SalesSummaryCacheDaily"
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX IF NOT EXISTS "SalesSummaryCacheDaily_shopId_targetDate_idx"
  ON "SalesSummaryCacheDaily"("shopId", "targetDate");

-- SalesSummaryCachePeriod: createdAt（監査カラム補完）
ALTER TABLE "SalesSummaryCachePeriod"
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
