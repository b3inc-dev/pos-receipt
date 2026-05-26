-- CreateTable
CREATE TABLE "SettlementOperationLock" (
    "lockKey" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "SettlementOperationLock_expiresAt_idx" ON "SettlementOperationLock"("expiresAt");
