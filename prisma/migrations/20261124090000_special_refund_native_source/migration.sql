-- POS 純正の返金の付け替え（refundSource = 'native'）。null は今までの登録
ALTER TABLE "SpecialRefundEvent" ADD COLUMN "refundSource" TEXT;
CREATE INDEX "SpecialRefundEvent_shopId_sourceOrderId_refundSource_idx" ON "SpecialRefundEvent"("shopId", "sourceOrderId", "refundSource");
