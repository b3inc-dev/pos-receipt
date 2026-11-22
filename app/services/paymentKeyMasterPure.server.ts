/**
 * 支払方法マスタから精算の集計キーを決める（純関数・DB / Shopify 非依存）。
 *
 * 「精算の数え方」の「支払方法の分け方」で「支払方法マスタで分ける」を選んだ店だけが使う。
 * 選んでいない店（初めの値）は builtinPaymentKeyResolver（gasNormalizeGatewayLabel・今の動き）のまま。
 *
 * - 取引の gateway が rawGatewayPattern に、または formattedGateway が formattedGatewayPattern に
 *   当たる最初のマスタ（sortOrder の順）の表示名をキーにする。
 * - どのマスタにも当たらない取引は、決まった分け方のキーにする（売上・返金が行から消えないように）。
 * - キーの種類（現金・商品券）はマスタの種類（category / 商品券として扱う）で決める。
 *   種類が「未分類」のマスタは、決まった分け方の判定を使う。
 */
import {
  builtinPaymentKeyResolver,
  type PaymentKeyKind,
  type PaymentKeyResolver,
} from "./settlementAggregatePure.server";
import { matchesGatewayPattern } from "../utils/paymentMethodMatch.server";

export type PaymentKeyMaster = {
  rawGatewayPattern: string;
  formattedGatewayPattern?: string | null;
  matchType: string;
  displayLabel: string;
  category?: string | null;
  isVoucher?: boolean | null;
  enabled?: boolean | null;
};

export type PaymentKeySource = "builtin" | "master";

function kindForMaster(
  m: PaymentKeyMaster,
  fallback: PaymentKeyKind,
): PaymentKeyKind {
  const category = String(m.category ?? "").trim();
  if (m.isVoucher === true || category === "voucher") return "voucher";
  if (category === "cash") return "cash";
  if (!category || category === "uncategorized") return fallback;
  return "other";
}

/** 取引に当たるマスタ（無ければ null） */
export function matchPaymentKeyMaster<T extends PaymentKeyMaster>(
  gateway: string,
  formattedGateway: string | null | undefined,
  masters: readonly T[],
): T | null {
  const raw = String(gateway ?? "").trim();
  const fmt = String(formattedGateway ?? "").trim();
  for (const m of masters) {
    if (m.enabled === false) continue;
    if (!String(m.displayLabel ?? "").trim()) continue;
    if (raw && matchesGatewayPattern(raw, m.rawGatewayPattern, m.matchType)) return m;
    if (
      fmt &&
      m.formattedGatewayPattern &&
      matchesGatewayPattern(fmt, m.formattedGatewayPattern, m.matchType)
    ) {
      return m;
    }
  }
  return null;
}

/** マスタで分ける resolver。masters は sortOrder の順に並べて渡す */
export function createMasterPaymentKeyResolver(
  masters: readonly PaymentKeyMaster[],
): PaymentKeyResolver {
  return (gateway, formattedGateway) => {
    const builtin = builtinPaymentKeyResolver(gateway, formattedGateway);
    const m = matchPaymentKeyMaster(gateway, formattedGateway, masters);
    if (!m) return builtin;
    return { key: String(m.displayLabel).trim(), kind: kindForMaster(m, builtin.kind) };
  };
}

/** 設定に合わせた resolver。builtin のときは今の動き */
export function paymentKeyResolverFor(
  source: PaymentKeySource,
  masters: readonly PaymentKeyMaster[],
): PaymentKeyResolver {
  return source === "master" ? createMasterPaymentKeyResolver(masters) : builtinPaymentKeyResolver;
}

/**
 * 管理画面で切り替える前に見るための対応表。
 * マスタごとに、登録した gateway の名前で見たときの「今の分け方」と「マスタで分ける」のキーを並べる。
 * contains / starts_with のパターンは本物の gateway と違うことがあるので目安。
 */
export function comparePaymentKeysForMasters(
  masters: readonly PaymentKeyMaster[],
): Array<{ rawGatewayPattern: string; builtinKey: string; masterKey: string; changes: boolean }> {
  const resolver = createMasterPaymentKeyResolver(masters);
  return masters
    .filter((m) => m.enabled !== false && String(m.rawGatewayPattern ?? "").trim())
    .map((m) => {
      const gw = String(m.rawGatewayPattern).trim();
      const fmt = m.formattedGatewayPattern ?? null;
      const builtinKey = builtinPaymentKeyResolver(gw, fmt).key;
      const masterKey = resolver(gw, fmt).key;
      return { rawGatewayPattern: gw, builtinKey, masterKey, changes: builtinKey !== masterKey };
    });
}
