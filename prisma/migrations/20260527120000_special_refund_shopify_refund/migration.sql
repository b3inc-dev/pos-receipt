-- AlterTable
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "shopifyRefundStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "shopifyRefundId" TEXT;
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "shopifyRefundError" TEXT;
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "shopifyRefundProcessedAt" TIMESTAMP(3);
