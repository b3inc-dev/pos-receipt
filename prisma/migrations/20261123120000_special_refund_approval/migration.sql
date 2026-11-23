-- 特殊返金「支払方法の付け替え」の管理者の承認（設定でオンのときだけ使う。既存の行は none = 承認の対象外）
-- AlterTable
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "approvalReviewedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "SpecialRefundEvent_shopId_approvalStatus_idx" ON "SpecialRefundEvent"("shopId", "approvalStatus");
