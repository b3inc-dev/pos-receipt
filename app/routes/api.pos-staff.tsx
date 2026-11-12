/**
 * GET/POST /api/pos-staff
 * 標準の担当IDが無いときのアプリ内担当と、会計前の担当順。
 * Shopify 管理 API は呼ばない。決済・返金・在庫は変更しない。
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { corsErrorJson, corsPreflightResponse } from "../utils/posAuth.server";
import prisma from "../db.server";

function shopDomainFromToken(dest: unknown) {
  if (typeof dest !== "string" || !dest.trim()) return null;
  try {
    return new URL(dest).hostname;
  } catch {
    return null;
  }
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

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "GET") return corsErrorJson(request, { error: "Method not allowed" }, 405);
  try {
    const context = await shopContext(request);
    if ("error" in context && context.error) return context.error;
    const { shop, corsJson } = context as Exclude<typeof context, { error: Response }>;
    const draftKey = new URL(request.url).searchParams.get("draftKey");
    if (draftKey) {
      const draft = await prisma.cartStaffDraft.findFirst({
        where: { shopId: shop.id, draftKey },
      });
      if (!draft) return corsJson({ ok: false, error: "draft_missing" }, { status: 404 });
      return corsJson({ ok: true, draftKey, lines: JSON.parse(draft.linesJson) });
    }
    const staff = await prisma.posStaff.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "asc" },
    });
    return corsJson({
      ok: true,
      staff: staff.map((item) => ({ key: item.staffKey, label: item.label })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "apply_failed";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return corsPreflightResponse(request);
  if (request.method !== "POST") return corsErrorJson(request, { error: "Method not allowed" }, 405);
  try {
    const context = await shopContext(request);
    if ("error" in context && context.error) return context.error;
    const { shop, corsJson } = context as Exclude<typeof context, { error: Response }>;
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.draftKey === "string" && body.draftKey.trim()) {
      const lines = Array.isArray(body.lines) ? body.lines : [];
      const existing = await prisma.cartStaffDraft.findUnique({ where: { draftKey: body.draftKey.trim() } });
      if (existing && existing.shopId !== shop.id) {
        return corsJson({ ok: false, error: "draft_missing" }, { status: 404 });
      }
      const draft = await prisma.cartStaffDraft.upsert({
        where: { draftKey: body.draftKey.trim() },
        create: {
          shopId: shop.id,
          draftKey: body.draftKey.trim(),
          linesJson: JSON.stringify(lines),
        },
        update: { linesJson: JSON.stringify(lines) },
      });
      return corsJson({ ok: true, draftKey: draft.draftKey });
    }
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label) return corsJson({ ok: false, error: "label_required" }, { status: 400 });
    const staffKey = `app:${crypto.randomUUID().replace(/-/g, "")}`;
    const staff = await prisma.posStaff.create({
      data: { shopId: shop.id, staffKey, label },
    });
    return corsJson({ ok: true, staff: { key: staff.staffKey, label: staff.label } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "apply_failed";
    return corsErrorJson(request, { ok: false, error: message }, 500);
  }
}
