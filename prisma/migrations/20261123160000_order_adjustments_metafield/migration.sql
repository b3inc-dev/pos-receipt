-- 特殊返金・商品券調整を注文メタフィールド pos.adjustments に残す（docs/ORDER_ADJUSTMENTS_METAFIELD.md）
-- DB は履歴と「日・店 → 注文」の目次。列を足すだけ（前からの行は countDate なし = 登録した日で数える）
-- AlterTable
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "countDate" TEXT;
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "replacesEventId" TEXT;
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "voidedAt" TIMESTAMP(3);
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "voidedBy" TEXT;
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "voidReason" TEXT;
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "metafieldSyncedAt" TIMESTAMP(3);
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "metafieldSyncError" TEXT;

-- CreateIndex
CREATE INDEX "SpecialRefundEvent_shopId_locationId_countDate_idx" ON "SpecialRefundEvent"("shopId", "locationId", "countDate");
