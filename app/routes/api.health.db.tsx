/**
 * GET /api/health/db
 * DB 接続と SettlementOperationLock テーブルの有無（マイグレーション確認用・秘密情報は返さない）
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method !== "GET") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  try {
    const pending = await prisma.$queryRaw<
      { migration_name: string; finished_at: Date | null }[]
    >`
      SELECT migration_name, finished_at
      FROM "_prisma_migrations"
      WHERE finished_at IS NULL
      ORDER BY started_at DESC
      LIMIT 5
    `;

    const applied = await prisma.$queryRaw<
      { migration_name: string; finished_at: Date }[]
    >`
      SELECT migration_name, finished_at
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 5
    `;

    let settlementOperationLockTable = false;
    try {
      await prisma.$queryRaw`SELECT 1 FROM "SettlementOperationLock" LIMIT 1`;
      settlementOperationLockTable = true;
    } catch {
      settlementOperationLockTable = false;
    }

    return Response.json({
      ok: true,
      settlementOperationLockTable,
      pendingMigrations: pending.map((p) => p.migration_name),
      recentAppliedMigrations: applied.map((a) => a.migration_name),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
