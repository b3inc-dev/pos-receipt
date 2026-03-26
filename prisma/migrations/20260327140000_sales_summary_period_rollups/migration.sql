-- ロケーション月次ロールアップの列追加 + チャネル月次ロールアップテーブル

ALTER TABLE "SalesSummaryCachePeriod" ADD COLUMN "ordersTotal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SalesSummaryCachePeriod" ADD COLUMN "itemsTotal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SalesSummaryCachePeriod" ADD COLUMN "visitorsTotal" INTEGER;
ALTER TABLE "SalesSummaryCachePeriod" ADD COLUMN "progressCutoffUsed" TEXT;
ALTER TABLE "SalesSummaryCachePeriod" ADD COLUMN "budgetRangeEnd" TEXT;

CREATE TABLE "SalesChannelCachePeriod" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "periodType" TEXT NOT NULL DEFAULT 'month',
    "periodKey" TEXT NOT NULL,
    "startDate" TEXT,
    "endDate" TEXT,
    "budgetTotal" DECIMAL(18,2),
    "actualTotal" DECIMAL(18,2),
    "ordersTotal" INTEGER NOT NULL DEFAULT 0,
    "itemsTotal" INTEGER NOT NULL DEFAULT 0,
    "progressBudgetToday" DECIMAL(18,2),
    "progressBudgetPrev" DECIMAL(18,2),
    "progressCutoffUsed" TEXT,
    "budgetRangeEnd" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesChannelCachePeriod_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SalesChannelCachePeriod_shopId_channelId_periodKey_key" ON "SalesChannelCachePeriod"("shopId", "channelId", "periodKey");
CREATE INDEX "SalesChannelCachePeriod_shopId_idx" ON "SalesChannelCachePeriod"("shopId");

ALTER TABLE "SalesChannelCachePeriod" ADD CONSTRAINT "SalesChannelCachePeriod_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesChannelCachePeriod" ADD CONSTRAINT "SalesChannelCachePeriod_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "SalesChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
