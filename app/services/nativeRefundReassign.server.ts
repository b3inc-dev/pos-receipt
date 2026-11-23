/**
 * POS 純正の返金の付け替え（Shopify を読む・DB に書く）。決まりは nativeRefundReassignPure.server.ts。
 * Shopify には書かない（返金は作らない）。
 */
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { adminGraphqlWithRetry } from "../lib/shopifyGraphqlThrottle.server";
import {
  checkNativeReassign,
  nativeRefundLines,
  NATIVE_REFUND_SOURCE,
  remainingFor,
  type NativeRefundLine,
  type ShopifyRefundForReassign,
} from "./nativeRefundReassignPure.server";

type AdminClient = {
  graphql: (query: string, opts?: object) => Promise<{ json: () => Promise<unknown> }>;
};

const ORDER_REFUNDS_FOR_REASSIGN_QUERY = `#graphql
  query OrderRefundsForReassign($id: ID!) {
    order(id: $id) {
      id
      refunds {
        id
        createdAt
        note
        transactions(first: 50) {
          nodes {
            kind
            status
            gateway
            formattedGateway
            amountSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;

function orderGid(sourceOrderId: string): string {
  const s = String(sourceOrderId).trim();
  if (s.startsWith("gid://")) return s;
  return `gid://shopify/Order/${s.replace(/\D/g, "")}`;
}

/** 注文の純正の返金（1 件・支払方法 1 つずつ）。読めなければ throw */
export async function fetchNativeRefundLines(
  admin: AdminClient,
  sourceOrderId: string,
): Promise<NativeRefundLine[]> {
  const json = await adminGraphqlWithRetry<{
    data?: { order?: { refunds?: ShopifyRefundForReassign[] } | null };
    errors?: { message?: string }[];
  }>(admin, ORDER_REFUNDS_FOR_REASSIGN_QUERY, { variables: { id: orderGid(sourceOrderId) } });
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return nativeRefundLines(json.data?.order?.refunds ?? []);
}

/** POS に出す形: 純正の返金ごとの額・付け替えた額・残り */
export async function nativeRefundsForOrder(
  admin: AdminClient,
  shopId: string,
  sourceOrderId: string,
): Promise<Array<NativeRefundLine & { reassigned: number; remaining: number }>> {
  const lines = await fetchNativeRefundLines(admin, sourceOrderId);
  if (lines.length === 0) return [];
  const events = await prisma.specialRefundEvent.findMany({
    where: { shopId, sourceOrderId, refundSource: NATIVE_REFUND_SOURCE },
    select: { status: true, approvalStatus: true, shopifyRefundId: true, originalPaymentMethod: true, amount: true },
  });
  return lines.map((line) => {
    const remaining = remainingFor(line, events);
    return { ...line, remaining, reassigned: Math.max(0, Math.round((line.amount - remaining) * 100) / 100) };
  });
}

export type NativeReassignCreateData = Omit<
  Prisma.SpecialRefundEventUncheckedCreateInput,
  "refundSource" | "shopifyRefundStatus" | "shopifyRefundId" | "shopifyRefundProcessedAt" | "countDate"
>;

export type NativeReassignResult =
  | { ok: true; event: Awaited<ReturnType<typeof prisma.specialRefundEvent.create>> }
  | { ok: false; status: number; code: string; message: string };

/**
 * 付け替えの登録を作る。残りを数えてから作るまでを 1 つのトランザクション（Serializable）にして、
 * 同時に押されても合計が返金額を超えないようにする。
 */
export async function createNativeRefundReassign(
  lines: NativeRefundLine[],
  input: {
    refundId: string;
    data: NativeReassignCreateData;
    /** 返金した日（店のタイムゾーン） */
    countDateOf: (line: NativeRefundLine) => string;
  },
): Promise<NativeReassignResult> {
  const { data } = input;
  try {
    const event = await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const events = await tx.specialRefundEvent.findMany({
          where: { shopId: data.shopId, sourceOrderId: data.sourceOrderId, refundSource: NATIVE_REFUND_SOURCE },
          select: { status: true, approvalStatus: true, shopifyRefundId: true, originalPaymentMethod: true, amount: true },
        });
        const check = checkNativeReassign(lines, events, {
          refundId: input.refundId,
          originalPaymentMethod: data.originalPaymentMethod ?? null,
          amount: data.amount,
        });
        if (!check.ok) throw new NativeReassignRejected(check.code, check.message);
        return tx.specialRefundEvent.create({
          data: {
            ...data,
            // 元の手段の名前は Shopify の返金の gateway にそろえる（精算の行を探すため）
            originalPaymentMethod: check.line.gateway,
            refundSource: NATIVE_REFUND_SOURCE,
            // 純正の返金がもうある: 精算・ciara-system は「移すだけ」にする（返金の合計は変えない）
            shopifyRefundStatus: "success",
            shopifyRefundId: check.line.refundId,
            shopifyRefundError: null,
            shopifyRefundProcessedAt: check.line.createdAt ? new Date(check.line.createdAt) : null,
            countDate: input.countDateOf(check.line),
          },
        });
      },
      { isolationLevel: "Serializable" },
    );
    return { ok: true, event };
  } catch (err) {
    if (err instanceof NativeReassignRejected) {
      return { ok: false, status: err.code === "INVALID_AMOUNT" ? 400 : 409, code: err.code, message: err.message };
    }
    const code = (err as { code?: string } | null)?.code;
    // P2034: 同時の書き込みでやり直しが要る / P2002: 同じキーの登録が先にできた
    if (code === "P2034") {
      return {
        ok: false,
        status: 409,
        code: "CONCURRENT_UPDATE",
        message: "ほかの登録と同時になりました。画面を読み直して、もう一度押してください。",
      };
    }
    throw err;
  }
}

class NativeReassignRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
