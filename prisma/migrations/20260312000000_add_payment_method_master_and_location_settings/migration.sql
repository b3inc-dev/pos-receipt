-- AlterTable Location: 要件 §4 表示名・並び順・機能有効可否
ALTER TABLE "Location" ADD COLUMN "displayName" TEXT;
ALTER TABLE "Location" ADD COLUMN "shortName" TEXT;
ALTER TABLE "Location" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Location" ADD COLUMN "settlementEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Location" ADD COLUMN "receiptEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Location" ADD COLUMN "specialRefundEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Location" ADD COLUMN "voucherAdjustmentEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Location" ADD COLUMN "inspectionReceiptEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable 要件 §13.3 支払方法マスタ
CREATE TABLE "PaymentMethodMaster" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "rawGatewayPattern" TEXT NOT NULL,
    "formattedGatewayPattern" TEXT,
    "matchType" TEXT NOT NULL DEFAULT 'contains_match',
    "displayLabel" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'uncategorized',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isVoucher" BOOLEAN NOT NULL DEFAULT false,
    "voucherChangeSupported" BOOLEAN NOT NULL DEFAULT false,
    "voucherNoChangeSupported" BOOLEAN NOT NULL DEFAULT false,
    "selectableForSpecialRefund" BOOLEAN NOT NULL DEFAULT true,
    "selectableForReceiptCashAdjustment" BOOLEAN NOT NULL DEFAULT false,
    "selectableForPaymentOverride" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentMethodMaster_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaymentMethodMaster_shopId_idx" ON "PaymentMethodMaster"("shopId");

ALTER TABLE "PaymentMethodMaster" ADD CONSTRAINT "PaymentMethodMaster_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
