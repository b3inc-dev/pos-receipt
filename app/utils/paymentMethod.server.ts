/**
 * 支払方法マスタから表示ラベルを解決（要件 §6）
 * 精算レシートの payment sections で使用
 *
 * マッチング本体は paymentMethodMatch.server.ts（純関数）に集約。
 */
import prisma from "../db.server";
import {
  isKnownRefundMethod,
  matchPaymentMethodMaster,
  resolvePaymentSectionLabel,
  type PaymentMethodMatchInput,
} from "./paymentMethodMatch.server";
import type { PaymentKeyMaster } from "../services/paymentKeyMasterPure.server";

async function loadEnabledMasters(shopId: string): Promise<PaymentMethodMatchInput[]> {
  return prisma.paymentMethodMaster.findMany({
    where: { shopId, enabled: true },
    orderBy: { sortOrder: "asc" },
    select: {
      rawGatewayPattern: true,
      formattedGatewayPattern: true,
      matchType: true,
      displayLabel: true,
      isVoucher: true,
      voucherChangeSupported: true,
      enabled: true,
    },
  });
}

/**
 * ショップの支払方法マスタを取得し、gateway（または GAS 日本語バケットキー）に
 * 一致する displayLabel を返す。一致なしならフォールバック。
 */
export async function getPaymentMethodDisplayLabel(
  shopId: string,
  gateway: string,
): Promise<string> {
  const masters = await loadEnabledMasters(shopId);
  return resolvePaymentSectionLabel(gateway, masters);
}

/**
 * 精算 payment sections 用: マスタを1回読み、全バケットの表示ラベルを解決する。
 */
export async function resolvePaymentSectionLabels(
  shopId: string,
  bucketKeys: string[],
  opts?: { preferExactDisplayLabel?: boolean },
): Promise<Map<string, string>> {
  const masters = await loadEnabledMasters(shopId);
  const out = new Map<string, string>();
  for (const key of bucketKeys) {
    out.set(key, resolvePaymentSectionLabel(key, masters, opts));
  }
  return out;
}

/**
 * 「支払方法マスタで分ける」店の集計キーに使うマスタ（有効なものを sortOrder の順）。
 */
export async function loadPaymentKeyMasters(shopId: string): Promise<PaymentKeyMaster[]> {
  return prisma.paymentMethodMaster.findMany({
    where: { shopId, enabled: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      rawGatewayPattern: true,
      formattedGatewayPattern: true,
      matchType: true,
      displayLabel: true,
      category: true,
      isVoucher: true,
      enabled: true,
    },
  });
}

/**
 * 指定 gateway が商品券として登録されているか・釣銭あり対応かを返す。
 * 特殊返金・精算で商品券判定に利用。
 */
export async function getPaymentMethodVoucherInfo(
  shopId: string,
  gateway: string,
): Promise<{ isVoucher: boolean; voucherChangeSupported: boolean }> {
  const masters = await loadEnabledMasters(shopId);
  const m = matchPaymentMethodMaster(gateway, masters);
  if (m) {
    return {
      isVoucher: m.isVoucher === true,
      voucherChangeSupported: m.voucherChangeSupported === true,
    };
  }
  return { isVoucher: false, voucherChangeSupported: false };
}

/**
 * 精算の特殊返金用: マスタを1回読み、返金方法がマスタで分かるかと表示名を返す。
 */
export async function loadRefundMethodResolver(
  shopId: string,
  normalize?: (method: string) => string,
): Promise<{
  isKnownMethod: (method: string) => boolean;
  labelForMethod: (method: string) => string;
}> {
  const masters = await loadEnabledMasters(shopId);
  return {
    isKnownMethod: (method) => isKnownRefundMethod(method, masters, normalize),
    labelForMethod: (method) => resolvePaymentSectionLabel(method, masters),
  };
}
