/**
 * POST /api/budgets/import
 * 要件書 §21.6: 予算一括インポート
 * Body: { rows: [{ locationId, targetDate, amount }] }
 * ※ CSVインポートは管理画面側機能。POS/API向けは JSON 配列で受付。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resolveShop } from "../utils/shopResolver.server";
import { checkPlanAccess } from "../utils/planFeatures.server";

interface BudgetRow {
  locationId: string;
  targetDate: string;
  amount: number | string;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const { admin, session } = await authenticate.public(request);
    const shop = await resolveShop(session.shop, admin);

    const access = checkPlanAccess(shop.planCode, "budget_management");
    if (!access.allowed) {
      return Response.json({ ok: false, error: access.message }, { status: 403 });
    }

    const contentType = request.headers.get("content-type") ?? "";
    let rows: BudgetRow[] = [];

    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { rows?: BudgetRow[] };
      rows = body.rows ?? [];
    } else {
      // CSV テキスト: locationId,targetDate,amount (ヘッダー行スキップ)
      const text = await request.text();
      const lines = text.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const parts = line.split(",");
        if (parts.length < 3 || isNaN(Number(parts[2]))) continue;
        if (parts[0].trim() === "locationId") continue; // header
        rows.push({
          locationId: parts[0].trim(),
          targetDate: parts[1].trim(),
          amount: Number(parts[2].trim()),
        });
      }
    }

    if (rows.length === 0) {
      return Response.json({ ok: false, error: "No rows to import" }, { status: 400 });
    }

    let inserted = 0;
    let updated = 0;
    const errors: { row: BudgetRow; error: string }[] = [];

    for (const row of rows) {
      try {
        const locationGid = String(row.locationId).startsWith("gid://")
          ? String(row.locationId)
          : `gid://shopify/Location/${row.locationId}`;
        const amountNum = Number(row.amount);

        if (!row.targetDate || isNaN(amountNum)) {
          errors.push({ row, error: "invalid targetDate or amount" });
          continue;
        }

        const existing = await prisma.budget.findUnique({
          where: {
            shopId_locationId_targetDate: {
              shopId: shop.id,
              locationId: locationGid,
              targetDate: row.targetDate,
            },
          },
        });

        await prisma.budget.upsert({
          where: {
            shopId_locationId_targetDate: {
              shopId: shop.id,
              locationId: locationGid,
              targetDate: row.targetDate,
            },
          },
          update: { amount: amountNum },
          create: {
            shopId: shop.id,
            locationId: locationGid,
            targetDate: row.targetDate,
            amount: amountNum,
          },
        });

        if (existing) {
          updated += 1;
        } else {
          inserted += 1;
        }
      } catch (e) {
        errors.push({ row, error: e instanceof Error ? e.message : "unknown" });
      }
    }

    return Response.json({ ok: true, inserted, updated, errors });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
