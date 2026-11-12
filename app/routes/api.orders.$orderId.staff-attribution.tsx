/**
 * GET/POST /api/orders/:orderId/staff-attribution
 * 確定済み明細の担当順と返品帰属を記録する。
 * Shopify 管理 API は呼ばない。決済・返金・在庫は変更しない。連携送信はしない。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";
import {
  attributionFromConfirmedLine,
  buildStaffAttributionPayload,
  commitOrderStaffCorrection,
  currentCorrectionsByLine,
  dispatchStaffAttributionPayload,
  selectLatestCorrection,
} from "../../extensions/common/orderStaffAttribution.js";

type SavedRow = {
  id: string;
  orderId: string;
  lineId: string;
  idempotencyKey: string;
  previousCorrectionId: string;
  beforeJson: string;
  afterJson: string;
  recordedAt: Date;
  createdAt: Date;
};

function shopDomainFromToken(dest: unknown) {
  if (typeof dest !== "string" || !dest.trim()) return null;
  try {
    return new URL(dest).hostname;
  } catch {
    return null;
  }
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toRecord(row: SavedRow) {
  return {
    id: row.id,
    orderId: row.orderId,
    lineId: row.lineId,
    idempotencyKey: row.idempotencyKey,
    recordedAt: row.recordedAt.toISOString(),
    persistedAt: row.createdAt.toISOString(),
    previousCorrectionId: row.previousCorrectionId,
    before: parseJson(row.beforeJson),
    after: parseJson(row.afterJson),
    effects: {
      payment: "unchanged",
      refund: "unchanged",
      inventory: "unchanged",
    },
  };
}

function storeFor(shopId: string) {
  return {
    async findByKey(key: string) {
      const row = await prisma.orderStaffAttributionCorrection.findUnique({
        where: { idempotencyKey: key },
      });
      if (!row || row.shopId !== shopId) return null;
      return toRecord(row);
    },
    async findLatestByLine(orderId: string, lineId: string) {
      const history = await prisma.orderStaffAttributionCorrection.findMany({
        where: { shopId, orderId, lineId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return selectLatestCorrection(history.map(toRecord));
    },
    async insert(record: {
      idempotencyKey: string;
      orderId: string;
      lineId: string;
      recordedAt: string;
      before: unknown;
      after: unknown;
    }, options?: { expectedPreviousId?: string }) {
      const expectedPreviousId = options?.expectedPreviousId ?? "";
      try {
        const row = await prisma.orderStaffAttributionCorrection.create({
          data: {
            shopId,
            orderId: record.orderId,
            lineId: record.lineId,
            idempotencyKey: record.idempotencyKey,
            previousCorrectionId: expectedPreviousId,
            beforeJson: JSON.stringify(record.before),
            afterJson: JSON.stringify(record.after),
            recordedAt: new Date(record.recordedAt),
          },
        });
        return toRecord(row);
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === "P2002") {
          const existing = await prisma.orderStaffAttributionCorrection.findUnique({
            where: { idempotencyKey: record.idempotencyKey },
          });
          if (existing && existing.shopId === shopId) {
            const duplicate = new Error("duplicate");
            (duplicate as { code?: string }).code = "duplicate";
            throw duplicate;
          }
          const changed = new Error("predecessor_changed");
          (changed as { code?: string }).code = "predecessor_changed";
          throw changed;
        }
        throw error;
      }
    },
  };
}

async function shopContext(request: Request) {
  const { sessionToken, cors } = await authenticate.pos(request);
  const shopDomain = shopDomainFromToken(sessionToken.dest);
  if (!shopDomain) {
    return { error: await cors(Response.json({ ok: false, error: "shop_record_missing" }, { status: 409 })) };
  }
  let shop = await prisma.shop.findFirst({ where: { shopDomain } });
  if (!shop) {
    try {
      shop = await prisma.shop.create({
        data: {
          shopDomain,
          shopifyShopGid: `gid://shopify/Shop/${shopDomain}`,
          planCode: "lite",
        },
      });
    } catch {
      shop = await prisma.shop.findFirst({ where: { shopDomain } });
    }
  }
  if (!shop) {
    return { error: await cors(Response.json({ ok: false, error: "shop_record_missing" }, { status: 409 })) };
  }
  const corsJson = (data: unknown, init?: ResponseInit) => cors(Response.json(data, init));
  return { shop, corsJson };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "GET") {
    return corsErrorJson(request, { error: "Method not allowed" }, 405);
  }
  try {
    const context = await shopContext(request);
    if ("error" in context && context.error) return context.error;
    const { shop, corsJson } = context as Exclude<typeof context, { error: Response }>;
    const orderId = String(params.orderId ?? "").replace(/^gid:\/\/shopify\/Order\//, "");
    if (!orderId) return corsJson({ ok: false, error: "orderId required" }, { status: 400 });
    const rows = await prisma.orderStaffAttributionCorrection.findMany({
      where: { shopId: shop.id, orderId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const corrections = rows.map(toRecord);
    const current = currentCorrectionsByLine(corrections);
    return corsJson({
      ok: true,
      productionConnection: false,
      corrections,
      lines: current.map((correction) => correction.after),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "apply_failed";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "POST") {
    return corsErrorJson(request, { error: "Method not allowed" }, 405);
  }
  try {
    const context = await shopContext(request);
    if ("error" in context && context.error) return context.error;
    const { shop, corsJson } = context as Exclude<typeof context, { error: Response }>;
    const orderId = String(params.orderId ?? "").replace(/^gid:\/\/shopify\/Order\//, "");
    if (!orderId) return corsJson({ ok: false, error: "orderId required" }, { status: 400 });
    const body = await request.json() as Record<string, unknown>;
    const lineId = String(body.lineId ?? "");
    const applied = await commitOrderStaffCorrection(storeFor(shop.id), {
      orderId,
      lineId,
      quantity: body.quantity,
      returnedQuantity: body.returnedQuantity,
      recordedAt: body.recordedAt,
      idempotencyKey: body.idempotencyKey,
      slices: body.slices,
    });
    if (!applied.ok) {
      const status = applied.code === "apply_failed" || applied.code === "predecessor_conflict" ? 500 : 400;
      return corsJson({ ok: false, error: applied.code, effects: applied.effects }, { status });
    }
    const view = attributionFromConfirmedLine(
      {
        id: lineId,
        quantity: body.quantity,
        refundableQuantity: body.returnedQuantity == null
          ? undefined
          : Number(body.quantity) - Number(body.returnedQuantity),
      },
      applied.record.after,
    );
    const payload = buildStaffAttributionPayload(orderId, view ? [view] : []);
    let delivery = { sent: false, required: false, reason: "not_requested" };
    try {
      delivery = dispatchStaffAttributionPayload(payload);
    } catch {
      delivery = { sent: false, required: false, reason: "optional_unavailable" };
    }
    return corsJson({
      ok: true,
      duplicate: applied.duplicate,
      record: applied.record,
      effects: applied.effects,
      externalIntegrationRequired: false,
      delivery,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "apply_failed";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
