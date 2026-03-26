/**
 * /app/channel-budget-template-csv
 * チャネル予算テンプレートCSV（チャネル名,日付,予算）
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { checkPlanAccess, getFullAccess } from "../utils/planFeatures.server";

function daysInMonthFromKey(monthKey: string) {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return 0;
  return new Date(y, m, 0).getDate();
}

function escapeCsvCell(value: string | number) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
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
  const channelIdsRaw = String(formData.get("templateChannelIds") ?? "[]");

  let requestedChannelIds: string[] = [];
  try {
    const parsed = JSON.parse(channelIdsRaw) as unknown;
    if (Array.isArray(parsed)) requestedChannelIds = parsed.map((v) => String(v));
  } catch {
    requestedChannelIds = [];
  }

  if (!templateMonth) {
    return Response.json({ ok: false, error: "templateMonth が必要です" }, { status: 400 });
  }
  const dayCount = daysInMonthFromKey(templateMonth);
  if (dayCount <= 0) {
    return Response.json(
      { ok: false, error: "templateMonth の形式が不正です（YYYY-MM）" },
      { status: 400 },
    );
  }

  const allChannels = await prisma.salesChannel.findMany({
    where: { shopId: shop.id },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  const selectedChannelIds = (
    requestedChannelIds.length > 0 ? requestedChannelIds : allChannels.map((c) => c.id)
  ).filter((id) => allChannels.some((c) => c.id === id));
  if (selectedChannelIds.length === 0) {
    return Response.json(
      { ok: false, error: "対象チャネルを1つ以上選択してください（チャネル管理で登録してください）" },
      { status: 400 },
    );
  }

  const nameMap = new Map(allChannels.map((c) => [c.id, c.name]));

  const dateFrom = `${templateMonth}-01`;
  const dateTo = `${templateMonth}-${String(dayCount).padStart(2, "0")}`;
  const budgets = await prisma.salesChannelBudget.findMany({
    where: {
      shopId: shop.id,
      channelId: { in: selectedChannelIds },
      targetDate: { gte: dateFrom, lte: dateTo },
    },
    select: { channelId: true, targetDate: true, amount: true },
    orderBy: [{ channelId: "asc" }, { targetDate: "asc" }],
  });
  const amountMap = new Map(
    budgets.map((b) => [`${b.channelId}__${b.targetDate}`, b.amount.toString()]),
  );

  const rows = ["チャネル名,日付,予算"];
  for (const cid of selectedChannelIds) {
    const chName = nameMap.get(cid) ?? cid;
    for (let day = 1; day <= dayCount; day++) {
      const targetDate = `${templateMonth}-${String(day).padStart(2, "0")}`;
      const amount = amountMap.get(`${cid}__${targetDate}`) ?? "";
      rows.push(
        [escapeCsvCell(chName), escapeCsvCell(targetDate), escapeCsvCell(amount)].join(","),
      );
    }
  }

  return new Response(`${rows.join("\n")}\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="channel-budget-template-${templateMonth}.csv"`,
    },
  });
}
