-- 返金の予約（docs/REFUND_RESERVATION.md）。新しい表だけで、今の表は変えない
CREATE TABLE "RefundReservation" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "sourceOrderName" TEXT,
    "locationId" TEXT NOT NULL,
    "rowsJson" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "businessDate" TEXT NOT NULL,
    "appliedRefundId" TEXT,
    "appliedEventIds" TEXT,
    "appliedAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundReservation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RefundReservation_shopId_sourceOrderId_status_idx" ON "RefundReservation"("shopId", "sourceOrderId", "status");

ALTER TABLE "RefundReservation" ADD CONSTRAINT "RefundReservation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
