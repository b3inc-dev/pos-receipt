-- AlterTable Location: 要件 §4.2.3, §4.2.4, §4.2.5
ALTER TABLE "Location" ADD COLUMN "includeInStoreTotals" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Location" ADD COLUMN "includeInOverallTotals" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Location" ADD COLUMN "visibleInSummaryDefault" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Location" ADD COLUMN "printerProfileId" TEXT;
ALTER TABLE "Location" ADD COLUMN "cloudprntEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Location" ADD COLUMN "summaryTargetGroup" TEXT;
ALTER TABLE "Location" ADD COLUMN "budgetTargetEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Location" ADD COLUMN "footfallTargetEnabled" BOOLEAN NOT NULL DEFAULT false;
