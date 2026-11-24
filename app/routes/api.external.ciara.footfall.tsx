/**
 * GET /api/external/ciara/footfall?from=YYYY-MM-DD&to=YYYY-MM-DD
 * ciara-system が読みにくる、POS で報告した入店数（読むだけ。Ciara のカスタムアプリだけ。T 2026-11-24）。
 *
 * - 自社用（APP_DISTRIBUTION=inhouse）でないときは 404（公開アプリでは口が無い）
 * - 合言葉はヘッダー X-Cron-Secret に、予算と同じ CIARA_BUDGET_SYNC_SECRET（ciara-system の POS_RECEIPT_BUDGET_SECRET）。
 *   時間一定で比べる。未設定なら 404、違えば 401
 * - 渡すのは、管理画面で「見せ合う」をオンにしたショップの、POS で人が入れた数だけ（ciara-system から入れた数は返さない）
 * - 渡すのはロケーション ID・日付・数・入れた時刻だけ（報告した人の名前は渡さない）
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { isInhouseMode } from "../utils/planFeatures.server";
import { ciaraBudgetSyncSecret } from "../services/ciaraBudgetSync.server";
import { getCiaraVisitSyncSettings } from "../services/ciaraVisitSync.server";
import { numericLocationId } from "../utils/ciaraVisitSync";
import { footfallReadDateRange } from "../utils/ciaraFootfallRead";

function secretMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function loader({ request }: LoaderFunctionArgs) {
  const secret = ciaraBudgetSyncSecret();
  if (!isInhouseMode() || !secret) return json({ ok: false, error: "not_enabled" }, 404);
  const given = request.headers.get("x-cron-secret") ?? "";
  if (!given || !secretMatches(given, secret)) return json({ ok: false, error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const range = footfallReadDateRange(url.searchParams.get("from"), url.searchParams.get("to"));
  if (!range.ok) return json({ ok: false, error: range.error }, 400);

  try {
    const shops = await prisma.shop.findMany({ select: { id: true } });
    const enabledShopIds: string[] = [];
    for (const shop of shops) {
      if ((await getCiaraVisitSyncSettings(shop.id)).enabled) enabledShopIds.push(shop.id);
    }
    const rows = enabledShopIds.length === 0 ? [] : await prisma.footfallReport.findMany({
      where: { shopId: { in: enabledShopIds }, source: "pos", targetDate: { gte: range.from, lte: range.to } },
      select: { locationId: true, targetDate: true, visitors: true, enteredAt: true },
      orderBy: [{ locationId: "asc" }, { targetDate: "asc" }],
    });
    const byLocation = new Map<string, { date: string; visitCount: number; reportedAt: string }[]>();
    for (const r of rows) {
      const id = numericLocationId(r.locationId);
      if (!/^\d+$/.test(id)) continue;
      const list = byLocation.get(id) ?? [];
      list.push({ date: r.targetDate, visitCount: r.visitors, reportedAt: r.enteredAt.toISOString() });
      byLocation.set(id, list);
    }
    const stores = [...byLocation.entries()].map(([shopifyLocationId, days]) => ({ shopifyLocationId, days }));
    return json({ ok: true, from: range.from, to: range.to, stores });
  } catch (e) {
    console.error("[external/ciara/footfall] error", e instanceof Error ? e.message : String(e));
    return json({ ok: false, error: "入店数を読めませんでした" }, 500);
  }
}
