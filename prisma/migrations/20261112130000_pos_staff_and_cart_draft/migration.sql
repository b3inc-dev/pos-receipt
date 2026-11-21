-- CreateTable
CREATE TABLE "PosStaff" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "staffKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosStaff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CartStaffDraft" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "draftKey" TEXT NOT NULL,
    "linesJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CartStaffDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosStaff_shopId_staffKey_key" ON "PosStaff"("shopId", "staffKey");
CREATE INDEX "PosStaff_shopId_idx" ON "PosStaff"("shopId");
CREATE UNIQUE INDEX "CartStaffDraft_draftKey_key" ON "CartStaffDraft"("draftKey");
CREATE INDEX "CartStaffDraft_shopId_updatedAt_idx" ON "CartStaffDraft"("shopId", "updatedAt");

-- AddForeignKey
ALTER TABLE "PosStaff" ADD CONSTRAINT "PosStaff_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CartStaffDraft" ADD CONSTRAINT "CartStaffDraft_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
