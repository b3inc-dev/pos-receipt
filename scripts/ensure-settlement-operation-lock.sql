-- SettlementOperationLock（PostgreSQL・冪等）
-- prisma migrate deploy が失敗状態で止まっているときの救済用
CREATE TABLE IF NOT EXISTS "SettlementOperationLock" (
    "lockKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SettlementOperationLock_pkey" PRIMARY KEY ("lockKey")
);

CREATE INDEX IF NOT EXISTS "SettlementOperationLock_expiresAt_idx" ON "SettlementOperationLock"("expiresAt");
