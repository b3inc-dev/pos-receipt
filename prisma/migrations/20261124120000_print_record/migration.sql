-- レシートを印刷した記録（再印字の印のため）。新しい表だけで、今の表は変えない
CREATE TABLE "PrintRecord" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "printCount" INTEGER NOT NULL DEFAULT 1,
    "firstPrintedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPrintedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrintRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PrintRecord_shopId_kind_targetId_key" ON "PrintRecord"("shopId", "kind", "targetId");

ALTER TABLE "PrintRecord" ADD CONSTRAINT "PrintRecord_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
