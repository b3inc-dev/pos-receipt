/**
 * GET /api/receipts/history
 * 要件書 §21.5: 領収書発行履歴
 * Query: orderId?, dateFrom?, dateTo?, limit?, locationId?, q?
 *
 * POS の発行履歴の一覧（注文一覧と同じ見た目）用に、2026-11-23 から次を足した:
 * - dateFrom/dateTo は店のタイムゾーンの 0 時〜23:59 で区切る（前は UTC の 0 時で、0〜9 時の発行が前の日に出ていた）
 * - locationId: 指定した店で発行したものだけ（POS の今の店）
 * - q: 注文番号・宛名の一部で探す（日付は使わない）
 * - 行の localDate / transactionTime と、todayLocalDate / fetchedAtTime（店のタイムゾーン）
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticatePosRequestOrCorsError, corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import {
  formatTimeHmInTimeZone,
  getCalendarDateStringInTimeZone,
  getDayRangeInUtc,
  getShopTimezoneForDaily,
} from "../utils/shopTimezone.server";
import { normalizeLocationIdForQuery } from "../utils/orderSearchQuery";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;

    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId");
    const dateFrom = url.searchParams.get("dateFrom");
    const dateTo = url.searchParams.get("dateTo");
    const limit = Math.min(50, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20);

    const where: Parameters<typeof prisma.receiptIssue.findMany>[0]["where"] = {
      shopId: shop.id,
    };
    const timezone = await getShopTimezoneForDaily(admin, shop.id);
    const q = url.searchParams.get("q")?.trim() ?? "";
    const locRaw = normalizeLocationIdForQuery(url.searchParams.get("locationId"));

    const w = where as Record<string, unknown>;
    const and: Record<string, unknown>[] = [];
    if (orderId) w.orderId = orderId;
    if (locRaw) {
      // 発行の記録には注文の retailLocation の GID が入っている（数字だけのときも拾う）
      w.locationId = { in: [`gid://shopify/Location/${locRaw}`, locRaw] };
    }
    if (q) {
      const term = q.replace(/^#/, "");
      and.push({
        OR: [
          { orderName: { contains: term, mode: "insensitive" } },
          { recipientName: { contains: q, mode: "insensitive" } },
        ],
      });
    } else if (dateFrom || dateTo) {
      // 店のタイムゾーンの暦日で区切る
      const createdAt: Record<string, Date> = {};
      if (dateFrom) createdAt.gte = getDayRangeInUtc(dateFrom, timezone).startUtc;
      if (dateTo) createdAt.lte = getDayRangeInUtc(dateTo, timezone).endUtc;
      w.createdAt = createdAt;
    }
    if (and.length) w.AND = and;

    const items = await prisma.receiptIssue.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return corsJson({
      items: items.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        orderName: r.orderName,
        locationId: r.locationId,
        recipientName: r.recipientName,
        proviso: r.proviso,
        amount: r.amount.toString(),
        currency: r.currency,
        isReissue: r.isReissue,
        templateVersion: r.templateVersion,
        createdBy: r.createdBy,
        createdAt: r.createdAt.toISOString(),
        // 一覧の「今日 18:14」「11月20日 19:04」用（店のタイムゾーン）
        localDate: getCalendarDateStringInTimeZone(r.createdAt, timezone),
        transactionTime: formatTimeHmInTimeZone(r.createdAt.toISOString(), timezone),
      })),
      timezone,
      todayLocalDate: getCalendarDateStringInTimeZone(new Date(), timezone),
      fetchedAtTime: formatTimeHmInTimeZone(new Date().toISOString(), timezone),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  return new Response(null, { status: 405 });
}
