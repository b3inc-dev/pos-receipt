-- CreateTable
CREATE TABLE "SettlementOperationLock" (
    "lockKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementOperationLock_pkey" PRIMARY KEY ("lockKey")
);

-- CreateIndex
CREATE INDEX "SettlementOperationLock_expiresAt_idx" ON "SettlementOperationLock"("expiresAt");
