-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopifyShopGid" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "planCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyLocationGid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "printMode" TEXT NOT NULL DEFAULT 'order_based',
    "salesSummaryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "footfallReportingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "sourceOrderId" TEXT,
    "sourceOrderName" TEXT,
    "targetDate" TEXT NOT NULL,
    "periodLabel" TEXT,
    "currency" TEXT,
    "total" DECIMAL(18,2) NOT NULL,
    "netSales" DECIMAL(18,2) NOT NULL,
    "tax" DECIMAL(18,2) NOT NULL,
    "discounts" DECIMAL(18,2) NOT NULL,
    "vipPointsUsed" DECIMAL(18,2) NOT NULL,
    "refundTotal" DECIMAL(18,2) NOT NULL,
    "orderCount" INTEGER NOT NULL,
    "refundCount" INTEGER NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "voucherChangeAmount" DECIMAL(18,2) NOT NULL,
    "paymentSectionsJson" TEXT NOT NULL,
    "printMode" TEXT NOT NULL,
    "printedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpecialRefundEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "sourceOrderName" TEXT,
    "locationId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "originalPaymentMethod" TEXT,
    "actualRefundMethod" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT,
    "voucherFaceValue" DECIMAL(18,2),
    "voucherAppliedAmount" DECIMAL(18,2),
    "voucherChangeAmount" DECIMAL(18,2),
    "adjustKind" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpecialRefundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptTemplate" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "templateJson" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptIssue" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT,
    "locationId" TEXT NOT NULL,
    "recipientName" TEXT,
    "proviso" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT,
    "templateId" TEXT,
    "templateVersion" INTEGER,
    "isReissue" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "targetDate" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FootfallReport" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "targetDate" TEXT NOT NULL,
    "visitors" INTEGER NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FootfallReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesSummaryCacheDaily" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "targetDate" TEXT NOT NULL,
    "actual" DECIMAL(18,2) NOT NULL,
    "orders" INTEGER NOT NULL,
    "items" INTEGER NOT NULL,
    "visitors" INTEGER,
    "conv" DECIMAL(10,4),
    "atv" DECIMAL(18,2),
    "setRate" DECIMAL(10,4),
    "unit" DECIMAL(18,2),
    "budget" DECIMAL(18,2),
    "budgetRatio" DECIMAL(10,4),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesSummaryCacheDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesSummaryCachePeriod" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "periodType" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "startDate" TEXT,
    "endDate" TEXT,
    "budgetTotal" DECIMAL(18,2),
    "actualTotal" DECIMAL(18,2),
    "progressBudgetToday" DECIMAL(18,2),
    "progressBudgetPrev" DECIMAL(18,2),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesSummaryCachePeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopifyShopGid_key" ON "Shop"("shopifyShopGid");

-- CreateIndex
CREATE INDEX "Location_shopId_idx" ON "Location"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "Location_shopId_shopifyLocationGid_key" ON "Location"("shopId", "shopifyLocationGid");

-- CreateIndex
CREATE INDEX "AppSetting_shopId_idx" ON "AppSetting"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "AppSetting_shopId_key_key" ON "AppSetting"("shopId", "key");

-- CreateIndex
CREATE INDEX "Settlement_shopId_targetDate_idx" ON "Settlement"("shopId", "targetDate");

-- CreateIndex
CREATE INDEX "Settlement_locationId_targetDate_idx" ON "Settlement"("locationId", "targetDate");

-- CreateIndex
CREATE INDEX "SpecialRefundEvent_shopId_sourceOrderId_idx" ON "SpecialRefundEvent"("shopId", "sourceOrderId");

-- CreateIndex
CREATE INDEX "SpecialRefundEvent_locationId_createdAt_idx" ON "SpecialRefundEvent"("locationId", "createdAt");

-- CreateIndex
CREATE INDEX "SpecialRefundEvent_eventType_createdAt_idx" ON "SpecialRefundEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "ReceiptTemplate_shopId_idx" ON "ReceiptTemplate"("shopId");

-- CreateIndex
CREATE INDEX "ReceiptIssue_shopId_orderId_idx" ON "ReceiptIssue"("shopId", "orderId");

-- CreateIndex
CREATE INDEX "ReceiptIssue_locationId_createdAt_idx" ON "ReceiptIssue"("locationId", "createdAt");

-- CreateIndex
CREATE INDEX "Budget_shopId_idx" ON "Budget"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_shopId_locationId_targetDate_key" ON "Budget"("shopId", "locationId", "targetDate");

-- CreateIndex
CREATE INDEX "FootfallReport_shopId_idx" ON "FootfallReport"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "FootfallReport_shopId_locationId_targetDate_key" ON "FootfallReport"("shopId", "locationId", "targetDate");

-- CreateIndex
CREATE INDEX "SalesSummaryCacheDaily_shopId_idx" ON "SalesSummaryCacheDaily"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesSummaryCacheDaily_shopId_locationId_targetDate_key" ON "SalesSummaryCacheDaily"("shopId", "locationId", "targetDate");

-- CreateIndex
CREATE INDEX "SalesSummaryCachePeriod_shopId_idx" ON "SalesSummaryCachePeriod"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesSummaryCachePeriod_shopId_locationId_periodType_period_key" ON "SalesSummaryCachePeriod"("shopId", "locationId", "periodType", "periodKey");

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppSetting" ADD CONSTRAINT "AppSetting_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpecialRefundEvent" ADD CONSTRAINT "SpecialRefundEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptTemplate" ADD CONSTRAINT "ReceiptTemplate_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptIssue" ADD CONSTRAINT "ReceiptIssue_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FootfallReport" ADD CONSTRAINT "FootfallReport_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesSummaryCacheDaily" ADD CONSTRAINT "SalesSummaryCacheDaily_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesSummaryCachePeriod" ADD CONSTRAINT "SalesSummaryCachePeriod_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
