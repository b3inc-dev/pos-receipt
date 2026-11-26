/**
 * GAS doPost の Script Lock（最大30秒待機）相当。
 * 同一 shop × location × date × operation の精算 Shopify 同期を直列化する。
 */
import prisma from "../db.server";

const LOCK_WAIT_MS = 30_000;
const LOCK_TTL_MS = 60_000;
const POLL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err != null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  );
}

export function buildSettlementLockKey(
  shopId: string,
  locationId: string,
  targetDate: string,
  operation: "settlement" | "inspection",
): string {
  const loc = String(locationId).trim();
  return `${shopId}:${loc}:${targetDate}:${operation}`;
}

async function tryAcquireLock(lockKey: string): Promise<Date | null> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

  await prisma.settlementOperationLock.deleteMany({
    where: { expiresAt: { lt: now } },
  });

  try {
    await prisma.settlementOperationLock.create({
      data: { lockKey, expiresAt },
    });
    return expiresAt;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    return null;
  }
}

async function releaseLock(lockKey: string, expiresAt: Date): Promise<void> {
  // A previous callback may finish after expiry and another operation has acquired
  // this key. Only remove the lease acquired by this invocation.
  await prisma.settlementOperationLock.deleteMany({ where: { lockKey, expiresAt } });
}

/**
 * ロック取得に失敗したら GAS と同様 429 相当のエラーを投げる。
 */
export async function withSettlementOperationLock<T>(
  lockKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let acquired: Date | null = null;

  while (Date.now() < deadline) {
    const lease = await tryAcquireLock(lockKey);
    if (lease) {
      acquired = lease;
      break;
    }
    await sleep(POLL_MS);
  }

  if (!acquired) {
    throw new Error("精算処理が混み合っています。しばらく待ってから再度お試しください。");
  }

  try {
    return await fn();
  } finally {
    await releaseLock(lockKey, acquired);
  }
}
