-- 販売の帰属スタッフ（注文 Webhook の line_items[].attributed_staffs）。新しい表だけで、既存の表は変えない。
CREATE TABLE "OrderStaffAttribution" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "staffId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStaffAttribution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderStaffAttribution_shopId_orderId_lineItemId_staffId_key" ON "OrderStaffAttribution"("shopId", "orderId", "lineItemId", "staffId");
CREATE INDEX "OrderStaffAttribution_shopId_orderId_idx" ON "OrderStaffAttribution"("shopId", "orderId");
CREATE INDEX "OrderStaffAttribution_shopId_staffId_idx" ON "OrderStaffAttribution"("shopId", "staffId");

ALTER TABLE "OrderStaffAttribution" ADD CONSTRAINT "OrderStaffAttribution_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
