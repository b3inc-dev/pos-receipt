-- CreateTable
CREATE TABLE "OrderStaffAttributionCorrection" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "previousCorrectionId" TEXT NOT NULL DEFAULT '',
    "beforeJson" TEXT NOT NULL,
    "afterJson" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStaffAttributionCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderStaffAttributionCorrection_idempotencyKey_key" ON "OrderStaffAttributionCorrection"("idempotencyKey");

CREATE UNIQUE INDEX "OrderStaffCorrection_predecessor_key" ON "OrderStaffAttributionCorrection"("shopId", "orderId", "lineId", "previousCorrectionId");

-- CreateIndex
CREATE INDEX "OrderStaffAttributionCorrection_shopId_orderId_lineId_idx" ON "OrderStaffAttributionCorrection"("shopId", "orderId", "lineId");

-- AddForeignKey
ALTER TABLE "OrderStaffAttributionCorrection" ADD CONSTRAINT "OrderStaffAttributionCorrection_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
