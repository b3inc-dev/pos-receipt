-- 入店数を ciara-system と見せ合う（Ciara のカスタムアプリだけで使う）。
-- POS の入店数（FootfallReport）に「人が入れた時刻」を足す（今の行は最後に変わった時刻にする）。
ALTER TABLE "FootfallReport" ADD COLUMN "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "FootfallReport" SET "enteredAt" = "updatedAt";

-- ciara-system で入れた入店数の写し（POS の入店数は書き変えない。表示のときに比べる）
CREATE TABLE "CiaraFootfallDaily" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "targetDate" TEXT NOT NULL,
    "visitors" INTEGER NOT NULL,
    "reportedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CiaraFootfallDaily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CiaraFootfallDaily_shopId_locationId_targetDate_key" ON "CiaraFootfallDaily"("shopId", "locationId", "targetDate");
CREATE INDEX "CiaraFootfallDaily_shopId_targetDate_idx" ON "CiaraFootfallDaily"("shopId", "targetDate");

ALTER TABLE "CiaraFootfallDaily" ADD CONSTRAINT "CiaraFootfallDaily_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
