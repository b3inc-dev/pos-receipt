/**
 * GET /api/receipts/history
 * 要件書 §21.5: 領収書発行履歴
 * Query: orderId?, dateFrom?, dateTo?, limit?, locationId?, q?, cursor?
 *
 * POS の発行履歴の一覧（注文一覧と同じ見た目）用に、2026-11-23 から次を足した:
 * - dateFrom/dateTo は店のタイムゾーンの 0 時〜23:59 で区切る（前は UTC の 0 時で、0〜9 時の発行が前の日に出ていた）
 * - locationId: 指定した店で売った注文の領収書だけ（発行の記録には注文の店が入っている。発行した端末の店ではない）。
 *   orderId が無いときは必須（無いと全店の履歴を返してしまうため 400）
 * - q: 注文番号・宛名の一部で探す（日付は使わない）
 * - 行の localDate / transactionTime と、todayLocalDate / fetchedAtTime（店のタイムゾーン）
 * - limit は 1〜50。cursor（前のページの nextCursor）で続きを読む
 * - dateFrom/dateTo は YYYY-MM-DD 以外なら 400
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
import { isYmd, parseHistoryLimit } from "../utils/receiptHistoryParams";
import { getAppSetting } from "../utils/appSettings.server";
import { formatReceiptIssuer, parseStaffNameMap, STAFF_DISPLAY_NAMES_SETTING_KEY } from "../utils/receiptIssuer";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const authResult = await authenticatePosRequestOrCorsError(request);
    if (authResult instanceof Response) return authResult;
    const { admin, shop, corsJson } = authResult;

    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId");
    const dateFrom = url.searchParams.get("dateFrom");
    const dateTo = url.searchParams.get("dateTo");
    const limit = parseHistoryLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor")?.trim() || null;
    if ((dateFrom && !isYmd(dateFrom)) || (dateTo && !isYmd(dateTo))) {
      return corsJson({ ok: false, error: "dateFrom/dateTo must be YYYY-MM-DD" }, { status: 400 });
    }

    const where: Parameters<typeof prisma.receiptIssue.findMany>[0]["where"] = {
      shopId: shop.id,
    };
    const timezone = await getShopTimezoneForDaily(admin, shop.id);
    const q = url.searchParams.get("q")?.trim() ?? "";
    const locRaw = normalizeLocationIdForQuery(url.searchParams.get("locationId"));
    if (!orderId && !locRaw) {
      // 店の指定が無いと全店の履歴を返してしまう
      return corsJson({ ok: false, error: "locationId required" }, { status: 400 });
    }

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

    const staffNames = parseStaffNameMap(await getAppSetting(shop.id, STAFF_DISPLAY_NAMES_SETTING_KEY).catch(() => null));
    const rows = await prisma.receiptIssue.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

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
        createdByStaffId: r.createdByStaffId,
        issuerLabel: formatReceiptIssuer(r.createdBy, r.createdByStaffId, staffNames),
        createdAt: r.createdAt.toISOString(),
        // 一覧の「今日 18:14」「11月20日 19:04」用（店のタイムゾーン）
        localDate: getCalendarDateStringInTimeZone(r.createdAt, timezone),
        transactionTime: formatTimeHmInTimeZone(r.createdAt.toISOString(), timezone),
      })),
      nextCursor,
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
