-- 特殊返金の承認（返金手段変更）。既存の行は not_required（今までどおり数える）
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "approvalDecidedAt" TIMESTAMP(3);
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "approvalDecidedBy" TEXT;
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "approvalNote" TEXT;

CREATE INDEX "SpecialRefundEvent_shopId_approvalStatus_idx" ON "SpecialRefundEvent"("shopId", "approvalStatus");
