-- CreateTable
CREATE TABLE "SalesChannelBudget" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "targetDate" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesChannelBudget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesChannelBudget_shopId_idx" ON "SalesChannelBudget"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesChannelBudget_shopId_channelId_targetDate_key" ON "SalesChannelBudget"("shopId", "channelId", "targetDate");

-- AddForeignKey
ALTER TABLE "SalesChannelBudget" ADD CONSTRAINT "SalesChannelBudget_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesChannelBudget" ADD CONSTRAINT "SalesChannelBudget_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "SalesChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
