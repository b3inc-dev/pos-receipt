-- AlterTable
ALTER TABLE "Shop" ADD COLUMN "salesSummaryPublicTokenHash" TEXT;

CREATE UNIQUE INDEX "Shop_salesSummaryPublicTokenHash_key" ON "Shop"("salesSummaryPublicTokenHash");
