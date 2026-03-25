/**
 * /app/budget-template-csv
 * 予算テンプレートCSVダウンロード専用ルート（POS Stock方式）
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { getFullAccess, checkPlanAccess } from "../utils/planFeatures.server";

const LOCATIONS_QUERY = `#graphql
  query Locations {
    locations(first: 50, includeLegacy: false) {
      nodes { id name isActive }
    }
  }
`;

function daysInMonthFromKey(monthKey: string) {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return 0;
  return new Date(y, m, 0).getDate();
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await resolveShop(session.shop, admin);

  const fullAccess = await getFullAccess(admin, session);
  const access = checkPlanAccess(shop.planCode, "budget_management", fullAccess);
  if (!access.allowed) {
    return Response.json({ ok: false, error: access.message }, { status: 403 });
  }

  const formData = await request.formData();
  const templateMonth = String(formData.get("templateMonth") ?? "");
  const locationIdsRaw = String(formData.get("templateLocationIds") ?? "[]");

  let requestedLocationIds: string[] = [];
  try {
    const parsed = JSON.parse(locationIdsRaw) as unknown;
    if (Array.isArray(parsed)) requestedLocationIds = parsed.map((v) => String(v));
  } catch {
    requestedLocationIds = [];
  }

  if (!templateMonth) {
    return Response.json(
      { ok: false, error: "templateMonth が必要です" },
      { status: 400 }
    );
  }
  const dayCount = daysInMonthFromKey(templateMonth);
  if (dayCount <= 0) {
    return Response.json(
      { ok: false, error: "templateMonth の形式が不正です（YYYY-MM）" },
      { status: 400 }
    );
  }

  const locRes = await admin.graphql(LOCATIONS_QUERY);
  const locJson = (await locRes.json()) as {
    data?: { locations?: { nodes?: { id: string; name: string; isActive: boolean }[] } };
  };
  const activeLocations = (locJson.data?.locations?.nodes ?? []).filter((l) => l.isActive);
  const selectedLocationIds = (
    requestedLocationIds.length > 0
      ? requestedLocationIds
      : activeLocations.map((l) => l.id)
  ).filter((id) => activeLocations.some((l) => l.id === id));
  if (selectedLocationIds.length === 0) {
    return Response.json(
      { ok: false, error: "対象ロケーションを1つ以上選択してください" },
      { status: 400 }
    );
  }
  const locationNameMap = new Map(activeLocations.map((l) => [l.id, l.name]));

  const dateFrom = `${templateMonth}-01`;
  const dateTo = `${templateMonth}-${String(dayCount).padStart(2, "0")}`;
  const budgets = await prisma.budget.findMany({
    where: {
      shopId: shop.id,
      locationId: { in: selectedLocationIds },
      targetDate: { gte: dateFrom, lte: dateTo },
    },
    select: { locationId: true, targetDate: true, amount: true },
    orderBy: [{ locationId: "asc" }, { targetDate: "asc" }],
  });
  const amountMap = new Map(
    budgets.map((b) => [`${b.locationId}__${b.targetDate}`, b.amount.toString()])
  );

  const rows = ["ロケーション名,日付,予算"];
  for (const locId of selectedLocationIds) {
    const locName = locationNameMap.get(locId) ?? locId;
    for (let day = 1; day <= dayCount; day++) {
      const targetDate = `${templateMonth}-${String(day).padStart(2, "0")}`;
      const amount = amountMap.get(`${locId}__${targetDate}`) ?? "";
      rows.push(`${locName},${targetDate},${amount}`);
    }
  }

  return new Response(`${rows.join("\n")}\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="budget-template-${templateMonth}.csv"`,
    },
  });
}

